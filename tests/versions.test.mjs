import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir } from 'node:fs/promises';
import { startApp } from './helpers.mjs';
import { createDatabase } from '../src/lib/server/database.ts';
import { isolatedPostgres } from './isolated-postgres.mjs';

for (const backend of ['sqlite', 'postgres']) {
  test(`${backend}: immutable file/metadata history, explicit upload decisions, concurrent update protection and restart`, {
    skip: backend === 'postgres' && !process.env.TEST_DATABASE_URL,
  }, async t => {
    const connectionString = backend === 'postgres' ? await isolatedPostgres(t) : undefined;
    const app = await startApp(t, backend === 'postgres' ? { DATABASE_BACKEND: backend, DATABASE_URL: connectionString } : {});
    const upload = (text, fields = {}) => {
      const body = new FormData(); body.set('title', 'History fixture'); body.set('licenses', 'MIT');
      body.set('file', new Blob([text], { type: 'text/plain' }), 'history.txt');
      for (const [key, value] of Object.entries(fields)) body.set(key, String(value));
      return app.request('/api/assets', { method: 'POST', body });
    };
    const created = await upload('first'); assert.equal(created.status, 201);
    const { asset } = await created.json();
    const history = async () => (await app.request(`/api/assets/${asset.id}/versions`)).json();
    assert.equal((await history()).total, 1);
    const conflict = await upload('second'); assert.equal(conflict.status, 409);
    const detail = await conflict.json(); assert.equal(detail.code, 'upload_conflict');
    assert.equal(detail.matches[0].revision, 1);
    assert.equal(await (await app.request(asset.downloadUrl)).text(), 'first');
    assert.equal((await upload('second', { targetAssetId: asset.id, mode: 'new-version' })).status, 400);
    assert.equal((await upload('second', { targetAssetId: asset.id, mode: 'new-version', expectedRevision: 1, note: 'Version two' })).status, 200);
    const metadata = { title: 'Edited title', description: 'Updated description', tags: ['fixture'], licenses: ['MIT'], sourceUrl: 'https://example.com', expectedRevision: 2, note: 'Metadata change', actor: { name: 'FORGED' } };
    assert.equal((await app.request(`/api/assets/${asset.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata) })).status, 200);
    assert.equal((await upload('third', { targetAssetId: asset.id, mode: 'replace', expectedRevision: 3, note: 'Correct current version' })).status, 200);
    let result = await history(); assert.equal(result.total, 4);
    assert.deepEqual(result.revisions.map(row => [row.revision, row.version, row.operation]), [[4, 2, 'replaced'], [3, 2, 'metadata'], [2, 2, 'new-version'], [1, 1, 'created']]);
    assert.equal(result.revisions[0].asset.title, 'Edited title');
    assert.equal(result.revisions[0].note, 'Correct current version');
    assert.equal(result.revisions[0].actor, null);
    for (const row of result.revisions) {
      assert.equal(row.asset.storedName, '');
      const file = await app.request(row.asset.downloadUrl);
      assert.equal(file.status, 200);
      assert.equal(file.headers.get('cache-control'), 'private, no-store');
      assert.match(file.headers.get('content-security-policy'), /^sandbox;/);
      assert.equal(await file.text(), row.revision === 1 ? 'first' : row.revision === 4 ? 'third' : 'second');
    }
    const range = await app.request(result.revisions[3].asset.fileUrl, { headers: { Range: 'bytes=1-3' } });
    assert.equal(range.status, 206); assert.equal(await range.text(), 'irs');
    assert.equal((await (await app.request(result.revisions[3].asset.textPreviewUrl)).json()).text, 'first');
    const concurrent = await Promise.all(['fourth', 'fifth'].map(text => upload(text, { targetAssetId: asset.id, mode: 'new-version', expectedRevision: 4 })));
    assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 409]);
    result = await history(); assert.equal(result.total, 5); assert.equal(result.revisions[0].version, 3);
    assert.equal((await app.request(`/api/assets/${asset.id}/versions?limit=999`)).status, 400);
    assert.equal((await app.request(`/api/assets/${asset.id}/versions/999/download`)).status, 404);
    const page = await (await app.request(`/api/assets/${asset.id}/versions?offset=1&limit=2`)).json();
    assert.deepEqual(page.revisions.map(row => row.revision), [4, 3]);
    // Failed database writes must leave both current state and history intact.
    const database = await createDatabase({ backend, sqlitePath: `${app.cwd}/data/assets.db`, connectionString });
    await database.prepare(backend === 'sqlite'
      ? "CREATE TRIGGER reject_history_metadata BEFORE UPDATE ON assets WHEN NEW.title = 'blocked' BEGIN SELECT RAISE(ABORT, 'Test failure'); END"
      : "ALTER TABLE assets ADD CONSTRAINT reject_history_metadata CHECK (title != 'blocked')").run();
    assert.equal((await app.request(`/api/assets/${asset.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...metadata, title: 'blocked', expectedRevision: 5 }) })).status, 500);
    assert.equal((await history()).total, 5);
    await database.prepare(backend === 'sqlite' ? 'DROP TRIGGER reject_history_metadata' : 'ALTER TABLE assets DROP CONSTRAINT reject_history_metadata').run();
    await database.close();
    await app.restart();
    assert.equal((await history()).total, 5);
    assert.equal(await (await app.request(`/api/assets/${asset.id}/versions/1/download`)).text(), 'first');
    assert.equal((await readdir(`${app.cwd}/data/uploads`)).length, 4);
    assert.equal((await app.request(`/api/assets/${asset.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await app.request(`/api/assets/${asset.id}/versions/1/download`)).status, 404);
    assert.deepEqual(await readdir(`${app.cwd}/data/uploads`), []);
  });
}

test('legacy assets acquire a baseline without inventing earlier history', async t => {
  const app = await startApp(t);
  const body = new FormData(); body.set('title', 'Legacy'); body.set('file', new Blob(['legacy bytes']), 'legacy.txt');
  const { asset } = await (await app.request('/api/assets', { method: 'POST', body })).json();
  const database = await createDatabase({ sqlitePath: `${app.cwd}/data/assets.db` });
  await database.prepare('DELETE FROM asset_revisions WHERE asset_id = ?').run(asset.id); await database.close();
  const result = await (await app.request(`/api/assets/${asset.id}/versions`)).json();
  assert.equal(result.total, 1); assert.equal(result.revisions[0].operation, 'baseline');
  assert.equal(result.revisions[0].createdAt, asset.uploadDate);
  assert.equal(await (await app.request(result.revisions[0].asset.downloadUrl)).text(), 'legacy bytes');
});
