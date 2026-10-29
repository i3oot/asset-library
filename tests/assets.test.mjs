import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from './helpers.mjs';
import { createDatabase } from '../src/lib/server/database.ts';

for (const backend of ['sqlite', 'postgres']) {
  test(`${backend}: upload, deduplication, metadata, range, replacement, restart persistence and delete`, {
    skip: backend === 'postgres' && !process.env.TEST_DATABASE_URL,
  }, async t => {
    if (backend === 'postgres') {
      const database = await createDatabase({ backend, connectionString: process.env.TEST_DATABASE_URL });
      await database.prepare('DELETE FROM assets').run(); await database.close();
    }
    const app = await startApp(t, backend === 'postgres' ? { DATABASE_BACKEND: backend, DATABASE_URL: process.env.TEST_DATABASE_URL } : {});
    const upload = async (body, name = 'sample.txt', type = 'text/plain') => {
      const form = new FormData(); form.set('title', 'A test asset'); form.set('licenses', 'CC0');
      form.set('sourceUrl', 'javascript:alert(1)'); form.set('file', new Blob([body], { type }), name);
      return app.request('/api/assets', { method: 'POST', body: form });
    };
    const uploaded = await upload('hello world'); assert.equal(uploaded.status, 201);
    const { asset } = await uploaded.json(); assert.equal(asset.sourceUrl, '');
    assert.equal((await upload('hello world')).status, 409);
    const edited = await app.request(`/api/assets/${asset.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: "Test ' OR 1=1 --", tags: ['test'], licenses: ['CC0'], sourceUrl: 'https://example.com' }) });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).asset.title, "Test ' OR 1=1 --");
    const preview = await app.request(asset.fileUrl, { headers: { Range: 'bytes=1-4' } });
    assert.equal(preview.status, 206); assert.equal(await preview.text(), 'ello');
    assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
    assert.match(preview.headers.get('content-security-policy'), /sandbox/);
    assert.equal(preview.headers.get('cache-control'), 'private, no-store');
    assert.equal((await app.request(asset.fileUrl, { headers: { Range: 'bytes=99-100' } })).status, 416);
    const database = await createDatabase({ backend, sqlitePath: `${app.cwd}/data/assets.db`, connectionString: process.env.TEST_DATABASE_URL });
    await database.prepare(backend === 'sqlite'
      ? "CREATE TRIGGER block_test_replacement BEFORE UPDATE ON assets WHEN NEW.original_name = 'blocked.txt' BEGIN SELECT RAISE(ABORT, 'Test failure'); END"
      : "ALTER TABLE assets ADD CONSTRAINT block_test_replacement CHECK (original_name != 'blocked.txt')").run();
    const blocked = new FormData(); blocked.set('file', new Blob(['must not overwrite existing bytes']), 'blocked.txt');
    assert.equal((await app.request(`/api/assets/${asset.id}/file`, { method: 'PATCH', body: blocked })).status, 500);
    assert.equal(await (await app.request(asset.downloadUrl)).text(), 'hello world');
    await database.prepare(backend === 'sqlite' ? 'DROP TRIGGER block_test_replacement' : 'ALTER TABLE assets DROP CONSTRAINT block_test_replacement').run();
    await database.close();
    const replacement = new FormData(); replacement.set('file', new Blob(['replacement']), 'new.txt');
    const replaced = await app.request(`/api/assets/${asset.id}/file`, { method: 'PATCH', body: replacement }); assert.equal(replaced.status, 200);
    assert.equal(await (await app.request(asset.downloadUrl)).text(), 'replacement');
    await app.restart();
    assert.equal(await (await app.request(asset.downloadUrl)).text(), 'replacement');
    const listed = await (await app.request('/api/assets')).json(); assert.equal(listed.assets.length, 1);
    assert.equal((await app.request(`/api/assets/${asset.id}/delete`, { method: 'POST' })).status, 415);
    assert.equal((await app.request(`/api/assets/${asset.id}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
    assert.equal((await app.request(`/api/assets/${asset.id}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'invalid' }) })).status, 400);
    assert.equal((await app.request(`/api/assets/${asset.id}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete' }) })).status, 200);
    assert.equal((await (await app.request('/api/assets')).json()).assets.length, 0);
    assert.equal((await app.request(asset.fileUrl)).status, 404);
  });
}

test('browser security policy blocks external connections and all icons are local', async t => {
  const app = await startApp(t);
  const response = await app.request('/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
  const html = await response.text();
  assert.ok(html.includes('<svg'));
  assert.ok(!html.includes('api.iconify.design'));
});
