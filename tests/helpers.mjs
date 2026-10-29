import { spawn } from 'node:child_process';
import { mkdtemp, rm, cp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';

const build = path.resolve('server.mjs');
export async function startApp(t, overrides = {}, fixture = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'asset-library-assets-'));
  if (fixture.dataSource) await cp(fixture.dataSource, path.join(cwd, 'data'), { recursive: true });
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AI_') && !key.startsWith('DATABASE_') && !key.startsWith('OIDC_') && !key.startsWith('MCP_') && !key.startsWith('MODEL_THUMBNAIL_') && key !== 'AUTH_MODE'));
  const serverEnv = { ...env, HOST: '127.0.0.1', PORT: String(port), ORIGIN: origin, AI_ENABLED: 'false', PROTOCOL_HEADER: 'x-forwarded-proto', BODY_SIZE_LIMIT: '1M', ...overrides };
  let child;
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited;
    }
  }
  async function launch() {
    child = spawn(process.execPath, [build], { cwd, env: serverEnv, stdio: 'ignore' });
    for (let i = 0; i < 15; i++) {
      try { if ((await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) return; }
      catch { /* Wait for startup. */ }
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Production server exited');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Production server did not become ready');
  }
  t.after(async () => { await stop(); await rm(cwd, { recursive: true, force: true }); });
  await launch();
  return {
    origin, cwd,
    request: (route, options = {}) => fetch(origin + route, { ...options, headers: { Origin: origin, 'X-Forwarded-Proto': 'http', ...options.headers } }),
    restart: async () => { await stop(); await launch(); },
  };
}
