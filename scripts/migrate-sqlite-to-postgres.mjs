import { DatabaseSync } from 'node:sqlite';
import { createDatabase } from '../src/lib/server/database.ts';

export async function migrateSqliteToPostgres(sqlitePath, connectionString) {
  if (!sqlitePath || !connectionString) throw new Error('SQLite path and DATABASE_URL are required');
  const source = new DatabaseSync(sqlitePath, { readOnly: true });
  let target;
  try {
    target = await createDatabase({ backend: 'postgres', connectionString });
    const rows = source.prepare('SELECT * FROM assets').all();
    const history = source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'asset_revisions'").get()
      ? source.prepare('SELECT * FROM asset_revisions ORDER BY asset_id, revision').all() : [];
    const historyColumns = ['asset_id', 'revision', 'version', 'operation', 'created_at', 'actor_json', 'note', 'snapshot_json'];
    const columns = ['id', 'title', 'description', 'tags_json', 'licenses_json', 'source_url', 'metadata_edited', 'upload_date', 'original_name', 'stored_name', 'file_type', 'hash', 'thumbhash', 'mime_type', 'size', 'category', 'preview_kind', 'width', 'height'];
    await target.transaction(async transaction => {
      // Maintenance mode is required. Lock against concurrent app writes too.
      await transaction.prepare('LOCK TABLE assets, asset_revisions IN ACCESS EXCLUSIVE MODE').run();
      const count = await transaction.prepare('SELECT COUNT(*) AS count FROM assets').get();
      if (Number(count.count) !== 0) throw new Error('Refusing migration into a nonempty PostgreSQL assets table');
      const insert = transaction.prepare(`INSERT INTO assets (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
      for (const row of rows) await insert.run(...columns.map(column => row[column] ?? null));
      const insertHistory = transaction.prepare(`INSERT INTO asset_revisions (${historyColumns.join(',')}) VALUES (${historyColumns.map(() => '?').join(',')})`);
      for (const row of history) await insertHistory.run(...historyColumns.map(column => row[column] ?? null));
      for (const row of history) {
        const saved = await transaction.prepare('SELECT * FROM asset_revisions WHERE asset_id = ? AND revision = ?').get(row.asset_id, row.revision);
        if (historyColumns.some(column => (saved[column] == null ? null : String(saved[column])) !== (row[column] == null ? null : String(row[column])))) throw new Error('History migration verification failed');
      }
      const result = await transaction.prepare('SELECT COUNT(*) AS count FROM assets').get();
      if (Number(result.count) !== rows.length) throw new Error('Migration row count mismatch');
      for (const row of rows) {
        const saved = await transaction.prepare('SELECT * FROM assets WHERE id = ?').get(row.id);
        if (columns.some(column => (saved[column] === null ? null : String(saved[column])) !== (row[column] == null ? null : String(row[column])))) {
          throw new Error('Migration value verification failed');
        }
      }
    });
    return rows.length;
  } finally {
    source.close();
    await target?.close();
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  try {
    const count = await migrateSqliteToPostgres(process.argv[2], process.env.DATABASE_URL);
    console.log(`Migrated ${count} asset records. Source SQLite was opened read-only; asset files were not moved.`);
  } catch {
    // Driver exceptions can contain connection details or asset metadata.
    console.error('Migration failed. Verify maintenance mode, schema compatibility, connection settings, and an empty target. No source data was changed.');
    process.exitCode = 1;
  }
}
