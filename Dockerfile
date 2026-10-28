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
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force \
    && rm -rf /root/.npm /usr/local/lib/node_modules /opt/yarn* \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
       /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Copy built app from builder
COPY --from=builder /app/build ./build
COPY --from=builder /app/server.mjs ./server.mjs
COPY --from=builder /app/renderer ./renderer
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/src/lib/server/database.ts ./src/lib/server/database.ts
COPY --from=builder /app/src/lib/server/thumbnails.ts ./src/lib/server/thumbnails.ts
COPY --from=builder /app/static ./static

# Expose port and run
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]

# Run model decoding in a separate, credential-free, network-isolated workload.
FROM runner AS thumbnail-renderer
USER root
RUN apk add --no-cache chromium chromium-swiftshader
USER node
ENV PORT=8080
CMD ["node", "renderer/server.mjs"]

# Trusted initializer only; exits before the capability-free renderer starts.
FROM alpine:3.24 AS renderer-network-guard
RUN apk add --no-cache iptables
COPY renderer/firewall.sh /usr/local/bin/renderer-firewall
RUN chmod 0555 /usr/local/bin/renderer-firewall
CMD ["/usr/local/bin/renderer-firewall"]
