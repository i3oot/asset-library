import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../src/lib/server/database.ts';
import { migrateSqliteToPostgres } from '../scripts/migrate-sqlite-to-postgres.mjs';

const row = { id: 'migration-test', title: 'Migration test', description: '', tags_json: '[]', licenses_json: '["CC0"]', source_url: '', metadata_edited: 1, upload_date: '2026-01-01T00:00:00.000Z', original_name: 'sample.txt', stored_name: 'sample.txt', file_type: 'txt', hash: 'test-only-hash', mime_type: 'text/plain', size: 5_000_000_000, category: 'script', preview_kind: 'text', width: null, height: null };
async function insert(database, value = row) {
  const columns = Object.keys(value);
  return database.prepare(`INSERT INTO assets (${columns.join(',')}) VALUES (${columns.map(key => '@' + key).join(',')})`).run(value);
}
for (const backend of ['sqlite', 'postgres']) {
  test(`${backend}: transaction rollback and bound parameters`, { skip: backend === 'postgres' && !process.env.TEST_DATABASE_URL }, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'asset-db-test-'));
    const database = await createDatabase({ backend, sqlitePath: path.join(directory, 'assets.db'), connectionString: process.env.TEST_DATABASE_URL });
    t.after(async () => { await database.close(); await rm(directory, { recursive: true, force: true }); });
    await database.prepare('DELETE FROM assets').run();
    await assert.rejects(database.transaction(async transaction => {
      await insert(transaction);
      await insert(transaction);
    }));
    assert.equal(Number((await database.prepare('SELECT COUNT(*) AS count FROM assets').get()).count), 0);
    await insert(database, { ...row, title: "x'); DROP TABLE assets; --" });
    const result = await database.prepare('SELECT * FROM assets WHERE id = ?').get(row.id);
    assert.equal(result.title, "x'); DROP TABLE assets; --");
    assert.equal(Number(result.size), 5_000_000_000);
    await database.prepare('DELETE FROM assets').run();
  });
}

test('SQLite to PostgreSQL migration preserves values and refuses a nonempty target', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'asset-migration-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sqlitePath = path.join(directory, 'assets.db');
  const source = await createDatabase({ sqlitePath });
  await insert(source); await source.close();
  const target = await createDatabase({ backend: 'postgres', connectionString: process.env.TEST_DATABASE_URL });
  t.after(() => target.close());
  await target.prepare('DELETE FROM assets').run();
  assert.equal(await migrateSqliteToPostgres(sqlitePath, process.env.TEST_DATABASE_URL), 1);
  const migrated = await target.prepare('SELECT * FROM assets WHERE id = ?').get(row.id);
  for (const column of Object.keys(row)) assert.equal(migrated[column] === null ? null : String(migrated[column]), row[column] === null ? null : String(row[column]));
  await assert.rejects(migrateSqliteToPostgres(sqlitePath, process.env.TEST_DATABASE_URL), /nonempty/);
  await target.prepare('DELETE FROM assets').run();
});
