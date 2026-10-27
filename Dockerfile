# Multi-stage Dockerfile for SvelteKit (adapter-node)
# Builder stage
FROM node:24-alpine AS builder
WORKDIR /app

# Install deps (use package-lock if present)
COPY . .
RUN npm ci

# Build self-contained client assets
RUN npm run build

# Production stage
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV BODY_SIZE_LIMIT=1G
ENV OTEL_SDK_DISABLED=true
ENV DO_NOT_TRACK=1

# Copy only production deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy built app from builder
COPY --from=builder /app/build ./build
COPY --from=builder /app/server.mjs ./server.mjs
COPY --from=builder /app/static ./static

# Expose port and run
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
