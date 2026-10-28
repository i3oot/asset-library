import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolClient } from "pg";

export type Value = string | number | null;
export type Parameters = Value[] | Record<string, Value>;
export interface Database {
  prepare(sql: string): {
    all(...args: [Record<string, Value>] | Value[]): Promise<unknown[]>;
    get(...args: [Record<string, Value>] | Value[]): Promise<unknown>;
    run(...args: [Record<string, Value>] | Value[]): Promise<{ changes: number }>;
  };
  transaction<T>(fn: (database: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const schema = `
  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
    tags_json TEXT NOT NULL, licenses_json TEXT NOT NULL, source_url TEXT NOT NULL,
    metadata_edited INTEGER NOT NULL, upload_date TEXT NOT NULL,
    original_name TEXT NOT NULL, stored_name TEXT NOT NULL, file_type TEXT NOT NULL,
    hash TEXT, thumbhash TEXT, mime_type TEXT NOT NULL, size BIGINT NOT NULL,
    category TEXT NOT NULL, preview_kind TEXT NOT NULL, width INTEGER, height INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_assets_upload_date ON assets(upload_date DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_hash ON assets(hash);
  CREATE TABLE IF NOT EXISTS asset_revisions (
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL, version INTEGER NOT NULL,
    operation TEXT NOT NULL, created_at TEXT NOT NULL,
    actor_json TEXT, note TEXT NOT NULL, snapshot_json TEXT NOT NULL,
    PRIMARY KEY (asset_id, revision)
  );
  CREATE TABLE IF NOT EXISTS oidc_transactions (
    id_hash TEXT PRIMARY KEY, state TEXT NOT NULL, verifier TEXT NOT NULL,
    nonce TEXT NOT NULL, return_path TEXT NOT NULL, expires_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id_hash TEXT PRIMARY KEY, user_json TEXT NOT NULL, expires_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_oidc_transactions_expiry ON oidc_transactions(expires_at);
`;

// SQL is application-owned; parameter values are always sent separately.
function postgresQuery(sql: string, args: [Record<string, Value>] | Value[]) {
  const named = typeof args[0] === "object" && args[0] !== null ? args[0] : undefined;
  const values: Value[] = [];
  let position = 0;
  const text = sql.replace(/@([a-z_]+)|\?/g, (_match, name: string | undefined) => {
    const value = name ? named?.[name] : args[position++];
    if (value === undefined || typeof value === "object" && value !== null) {
      throw new Error("Missing database parameter");
    }
    values.push(value);
    return `$${values.length}`;
  });
  return { text, values };
}

export async function createDatabase(options: {
  backend?: string;
  connectionString?: string;
  sqlitePath?: string;
} = {}): Promise<Database> {
  const backend = options.backend ?? process.env.DATABASE_BACKEND ?? "sqlite";
  if (backend === "sqlite") {
    const filename = options.sqlitePath ?? path.join(process.cwd(), "data/assets.db");
    await mkdir(path.dirname(filename), { recursive: true });
    const sqlite = new DatabaseSync(filename);
    sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    sqlite.exec(schema);
    const columns = sqlite.prepare("PRAGMA table_info(assets)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "thumbhash")) sqlite.exec("ALTER TABLE assets ADD COLUMN thumbhash TEXT");
    let transactionTail = Promise.resolve();
    const database: Database = {
      prepare(sql) {
        const statement = sqlite.prepare(sql);
        const parameters = (args: [Record<string, Value>] | Value[]) => args as [Record<string, SQLInputValue>];
        return {
          all: async (...args) => statement.all(...parameters(args)),
          get: async (...args) => statement.get(...parameters(args)),
          run: async (...args) => ({ changes: Number(statement.run(...parameters(args)).changes) }),
        };
      },
      async transaction(fn) {
        const previous = transactionTail;
        let release!: () => void;
        transactionTail = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try {
          sqlite.exec("BEGIN IMMEDIATE");
          try {
            const result = await fn(database);
            sqlite.exec("COMMIT");
            return result;
          } catch (error) {
            sqlite.exec("ROLLBACK");
            throw error;
          }
        } finally { release(); }
      },
      close: async () => sqlite.close(),
    };
    return database;
  }
  if (backend !== "postgres") throw new Error("DATABASE_BACKEND must be sqlite or postgres");
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for PostgreSQL");
  const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
  // Do not log driver error objects: connection information can contain credentials.
  pool.on("error", () => console.error("PostgreSQL idle connection failed"));
  const wrap = (client: Pool | PoolClient): Database => ({
    prepare(sql) {
      const query = async (args: [Record<string, Value>] | Value[]) => client.query(postgresQuery(sql, args));
      return {
        all: async (...args) => (await query(args)).rows,
        get: async (...args) => (await query(args)).rows[0],
        run: async (...args) => ({ changes: (await query(args)).rowCount ?? 0 }),
      };
    },
    async transaction(fn) {
      const connection = await pool.connect();
      try {
        await connection.query("BEGIN");
        const result = await fn(wrap(connection));
        await connection.query("COMMIT");
        return result;
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally { connection.release(); }
    },
    close: async () => pool.end(),
  });
  try { await pool.query(schema); await pool.query("ALTER TABLE assets ADD COLUMN IF NOT EXISTS thumbhash TEXT"); }
  catch (error) { await pool.end(); throw error; }
  return wrap(pool);
}
