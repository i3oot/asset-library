import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { startApp } from './helpers.mjs';
import { migrateSqliteToPostgres } from '../scripts/migrate-sqlite-to-postgres.mjs';
import { isolatedPostgres } from './isolated-postgres.mjs';

for (const backend of ['sqlite', 'postgres']) {
  test(`${backend}: restore a coordinated metadata/file backup including historical bytes`, { skip: backend === 'postgres' && !process.env.TEST_DATABASE_URL }, async t => {
    const source = await startApp(t);
    const body = new FormData(); body.set('title', 'Recovery fixture'); body.set('file', new Blob(['original bytes']), 'recovery.txt');
    const { asset } = await (await source.request('/api/assets', { method: 'POST', body })).json();
    const update = new FormData(); update.set('file', new Blob(['new version bytes']), 'recovery.txt');
    assert.equal((await source.request(`/api/assets/${asset.id}/file`, { method: 'PATCH', body: update })).status, 200);
    const directory = await mkdtemp(path.join(tmpdir(), 'asset-history-backup-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const sqlitePath = path.join(directory, 'assets.db');
    const database = new DatabaseSync(path.join(source.cwd, 'data/assets.db'), { readOnly: true });
    try { await backup(database, sqlitePath); } finally { database.close(); }
    await cp(path.join(source.cwd, 'data/uploads'), path.join(directory, 'uploads'), { recursive: true });
    const env = {};
    if (backend === 'postgres') {
      const connectionString = await isolatedPostgres(t);
      await migrateSqliteToPostgres(sqlitePath, connectionString);
      env.DATABASE_BACKEND = 'postgres'; env.DATABASE_URL = connectionString;
    }
    const restored = await startApp(t, env, { dataSource: directory });
    const history = await (await restored.request(`/api/assets/${asset.id}/versions`)).json();
    assert.deepEqual(history.revisions.map(row => [row.revision, row.version]), [[2, 2], [1, 1]]);
    assert.equal(await (await restored.request(history.revisions[1].asset.downloadUrl)).text(), 'original bytes');
    assert.equal(await (await restored.request(history.revisions[0].asset.downloadUrl)).text(), 'new version bytes');
    assert.equal(await (await restored.request(asset.downloadUrl)).text(), 'new version bytes');
  });
}
