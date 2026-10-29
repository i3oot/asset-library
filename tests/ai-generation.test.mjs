import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { startApp } from './helpers.mjs';

test('AI metadata uses the configured chat-completions gateway and never returns its key', async t => {
  const requests = [];
  const gateway = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    requests.push({ path: request.url, authorization: request.headers.authorization, body: JSON.parse(raw) });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: 'test-completion', object: 'chat.completion', created: 1, model: 'test-model', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ tags: ['generated'], description: 'Generated metadata' }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
  });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  t.after(() => new Promise(resolve => { gateway.closeAllConnections(); gateway.close(resolve); }));
  const app = await startApp(t, { AI_ENABLED: 'true', AI_CONFIG_READONLY: 'true', AI_BASE_URL: `http://127.0.0.1:${gateway.address().port}`, AI_MODEL: 'test-model', AI_API_KEY: 'TEST_ONLY_GATEWAY_KEY' });
  const form = new FormData(); form.set('title', 'AI sample'); form.set('file', new Blob(['local text content'], { type: 'text/plain' }), 'sample.txt');
  const response = await app.request('/api/assets', { method: 'POST', body: form });
  assert.equal(response.status, 201);
  const { asset } = await response.json();
  assert.ok(asset.tags.includes('generated')); assert.equal(asset.description, 'Generated metadata');
  assert.equal(requests.length, 1); assert.equal(requests[0].path, '/v1/chat/completions');
  assert.equal(requests[0].authorization, 'Bearer TEST_ONLY_GATEWAY_KEY');
  assert.equal(requests[0].body.model, 'test-model');
  const settings = await app.request('/api/integrations/ai'); assert.ok(!(await settings.text()).includes('TEST_ONLY_GATEWAY_KEY'));
});
