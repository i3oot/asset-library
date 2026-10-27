import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';

const build = path.resolve('server.mjs');
async function start(t, overrides = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'asset-library-test-'));
  await mkdir(path.join(cwd, 'data'));
  await writeFile(path.join(cwd, 'data/ai-config.json'), JSON.stringify({
    enabled: false, baseUrl: 'http://localhost:1234', model: 'file-model',
    apiKey: 'TEST_ONLY_FILE_KEY',
  }));
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AI_') && !key.startsWith('DATABASE_')));
  const child = spawn(process.execPath, [build], {
    cwd, env: { ...env, HOST: '127.0.0.1', PORT: String(port), ORIGIN: url, PROTOCOL_HEADER: 'x-forwarded-proto', ...overrides },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    await rm(cwd, { recursive: true, force: true });
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/api/integrations/ai`)).ok) break;
    } catch { /* Wait for the production server to listen. */ }
    if (child.exitCode !== null) throw new Error('Production server exited');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return {
    get: async () => (await fetch(`${url}/api/integrations/ai`)).json(),
    patch: data => fetch(`${url}/api/integrations/ai`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: url, 'X-Forwarded-Proto': 'http' },
      body: JSON.stringify(data),
    }),
    file: async () => JSON.parse(await readFile(path.join(cwd, 'data/ai-config.json'), 'utf8')),
  };
}

test('settings responses redact keys and blank submissions preserve the file key', async t => {
  const app = await start(t);
  const { config } = await app.get();
  assert.equal(config.apiKey, '');
  assert.equal(config.apiKeyConfigured, true);
  const response = await app.patch({ apiKey: '', model: 'new-model' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).config.apiKey, '');
  const stored = await app.file();
  assert.equal(stored.apiKey, 'TEST_ONLY_FILE_KEY');
  assert.equal(stored.model, 'new-model');
  assert.equal(stored.enabled, false);
});

test('environment overrides never enter the settings file', async t => {
  const app = await start(t, { AI_API_KEY: 'TEST_ONLY_ENV_KEY', AI_MODEL: 'env-model' });
  const response = await app.patch({ temperature: 0.4 });
  assert.equal(response.status, 200);
  const { config } = await response.json();
  assert.equal(config.apiKey, '');
  assert.equal(config.model, 'env-model');
  const stored = await app.file();
  assert.equal(stored.apiKey, 'TEST_ONLY_FILE_KEY');
  assert.equal(stored.model, 'file-model');
  assert.equal(stored.temperature, 0.4);
});

test('server-managed settings reject attempts to redirect AI requests', async t => {
  const app = await start(t, { AI_CONFIG_READONLY: 'true', AI_API_KEY: 'TEST_ONLY_ENV_KEY' });
  assert.equal((await app.get()).config.readOnly, true);
  const before = await app.file();
  const response = await app.patch({ baseUrl: 'http://example.invalid', apiKey: 'TEST_ONLY_REPLACEMENT' });
  assert.equal(response.status, 403);
  assert.deepEqual(await app.file(), before);
});
