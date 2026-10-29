import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

/** Every new history test owns a fresh schema; never clear a configured shared assets table. */
export async function isolatedPostgres(t) {
  const schema = 'asset_history_test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  try { await admin.query(`CREATE SCHEMA "${schema}"`); }
  catch (error) { await admin.end(); throw error; }
  t.after(async () => {
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.end(); }
  });
  const connection = new URL(process.env.TEST_DATABASE_URL);
  connection.searchParams.set('options', `-c search_path=${schema}`);
  return connection.href;
}
