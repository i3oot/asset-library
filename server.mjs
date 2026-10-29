import { createServer } from 'node:http';

// Preserve a runtime-configurable fixed origin with SvelteKit 3's adapter-node.
// These private headers are overwritten, never accepted from the client.
let fixedOrigin;
if (process.env.ORIGIN) {
  try {
    const candidate = new URL(process.env.ORIGIN);
    if (!['http:', 'https:'].includes(candidate.protocol) || candidate.username || candidate.password || candidate.pathname !== '/' || candidate.search || candidate.hash) throw new Error();
    fixedOrigin = candidate;
  } catch { throw new Error('Invalid ORIGIN configuration'); }
  process.env.PROTOCOL_HEADER = 'x-asset-library-protocol';
  process.env.HOST_HEADER = 'x-asset-library-host';
}
const { handler } = await import('./build/handler.js');
const server = createServer((request, response) => {
  if (fixedOrigin) {
    request.headers['x-asset-library-protocol'] = fixedOrigin.protocol.slice(0, -1);
    request.headers['x-asset-library-host'] = fixedOrigin.host;
  }
  handler(request, response);
});
server.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 30_000);
    deadline.unref();
    server.close(() => process.exit(0));
  });
}
