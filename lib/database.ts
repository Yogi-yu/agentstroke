import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface QueryResult<T> { rows: T[]; rowCount: number }
export interface DatabaseClient {
  kind: "postgres" | "sqlite";
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}
interface DatabaseHandle { transaction<T>(action: (client: DatabaseClient) => Promise<T>): Promise<T>; close(): Promise<void> }
// Next route bundles and hot reloads can evaluate this module more than once.
// Share connections/queues, never application records: SQLite cannot safely
// block one connection while another transaction awaits this same event loop.
const databaseGlobals = globalThis as typeof globalThis & { __noemaDurableDatabaseHandles?: Map<string, Promise<DatabaseHandle>> };
const handles = databaseGlobals.__noemaDurableDatabaseHandles ??= new Map<string, Promise<DatabaseHandle>>();

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS noema_visitors (owner_id TEXT PRIMARY KEY, agents_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, brush_sequence INTEGER NOT NULL DEFAULT 0, latest_sky_request TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS noema_artworks (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, payload TEXT NOT NULL, agent_json TEXT, created_at BIGINT NOT NULL, source TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS noema_artworks_owner_created ON noema_artworks(owner_id, created_at, id)`,
  `CREATE TABLE IF NOT EXISTS noema_canvas (owner_id TEXT NOT NULL REFERENCES noema_visitors(owner_id), artwork_id TEXT NOT NULL REFERENCES noema_artworks(id), hidden INTEGER NOT NULL DEFAULT 0, transform_json TEXT, added_at BIGINT NOT NULL, PRIMARY KEY(owner_id, artwork_id))`,
  `CREATE TABLE IF NOT EXISTS noema_sky_jobs (owner_id TEXT NOT NULL REFERENCES noema_visitors(owner_id), request_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, lease_id TEXT, lease_until BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, PRIMARY KEY(owner_id, request_id))`,
  `CREATE INDEX IF NOT EXISTS noema_sky_owner_status ON noema_sky_jobs(owner_id, status, lease_until)`,
  `CREATE TABLE IF NOT EXISTS noema_legacy_snapshots (id TEXT PRIMARY KEY, source TEXT NOT NULL, content_sha256 TEXT NOT NULL, payload TEXT NOT NULL, created_at BIGINT NOT NULL, UNIQUE(source,content_sha256))`,
];

async function openDatabase(): Promise<DatabaseHandle> {
  const url = process.env.DATABASE_URL?.trim();
  const sqlitePath = process.env.NOEMA_SQLITE_PATH?.trim();
  if (!url && (process.env.RENDER === "true" || process.env.NODE_ENV === "production") && !sqlitePath) {
    throw new Error("Persistent storage is not configured. DATABASE_URL is required in production.");
  }
  // A Render ephemeral filesystem must never silently become the production DB.
  if (process.env.RENDER === "true" && !url) throw new Error("Render requires a persistent PostgreSQL DATABASE_URL.");
  if (url) {
    const { Pool } = await import("pg");
    const parsed = new URL(url);
    const external = parsed.hostname.includes(".") && !["localhost", "127.0.0.1"].includes(parsed.hostname);
    // Keep normal CA/hostname verification; never weaken TLS to hide failures.
    const pool = new Pool({ connectionString: url, max: 4, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000,
      application_name: "noema", ...(external && !parsed.searchParams.has("sslmode") ? { ssl: { rejectUnauthorized: true } } : {}) });
    // An idle connection can fail between requests. pg removes that connection;
    // avoid an unhandled EventEmitter crash without logging its secret-bearing URL.
    pool.on("error", () => { console.error("[Noema storage] An idle database connection was interrupted."); });
    let initializationError: unknown;
    const initial = await pool.connect().catch(async error => { await pool.end(); throw error; });
    try {
      await initial.query("BEGIN");
      await initial.query("SELECT pg_advisory_xact_lock(704020261103)");
      for (const statement of SCHEMA) await initial.query(statement);
      await initial.query("COMMIT");
    } catch (error) { initializationError = error; await initial.query("ROLLBACK").catch(() => {}); }
    finally { initial.release(); }
    if (initializationError) { await pool.end(); throw initializationError; }
    return {
      async transaction<T>(action: (client: DatabaseClient) => Promise<T>) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await action({ kind: "postgres", async query<U>(sql: string, params: unknown[] = []) {
            const answer = await client.query(sql, params);
            return { rows: answer.rows as U[], rowCount: answer.rowCount ?? 0 };
          } });
          await client.query("COMMIT");
          return result;
        } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
        finally { client.release(); }
      },
      async close() { await pool.end(); },
    };
  }
  const file = resolve(/* turbopackIgnore: true */ sqlitePath || ".noema/noema.sqlite");
  mkdirSync(dirname(file), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(file);
  sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;");
  for (const statement of SCHEMA) sqlite.exec(statement);
  let pending: Promise<unknown> = Promise.resolve();
  const client: DatabaseClient = { kind: "sqlite", async query<T>(sql: string, params: unknown[] = []) {
    const ordered: (string | number | bigint | null | Uint8Array)[] = [];
    const converted = sql.replace(/\$(\d+)/g, (_match, number) => {
      const value = params[Number(number) - 1];
      ordered.push(value == null ? null : typeof value === "boolean" ? Number(value) : value as string | number | bigint | Uint8Array);
      return "?";
    }).replace(/\s+FOR UPDATE\s*$/i, "");
    const prepared = sqlite.prepare(converted);
    if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(converted) || /\bRETURNING\b/i.test(converted)) {
      const rows = prepared.all(...ordered) as T[];
      return { rows, rowCount: rows.length };
    }
    const result = prepared.run(...ordered);
    return { rows: [], rowCount: Number(result.changes) };
  } };
  return {
    transaction<T>(action: (client: DatabaseClient) => Promise<T>): Promise<T> {
      const operation = pending.then(async () => {
        sqlite.exec("BEGIN IMMEDIATE");
        try { const value = await action(client); sqlite.exec("COMMIT"); return value; }
        catch (error) { sqlite.exec("ROLLBACK"); throw error; }
      });
      pending = operation.catch(() => {});
      return operation;
    },
    async close() { await pending; sqlite.close(); },
  };
}

export async function databaseTransaction<T>(action: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const key = process.env.DATABASE_URL || `${process.env.RENDER}:${process.env.NODE_ENV}:${resolve(/* turbopackIgnore: true */ process.env.NOEMA_SQLITE_PATH || ".noema/noema.sqlite")}`;
  let handle = handles.get(key);
  if (!handle) {
    handle = openDatabase(); handles.set(key, handle);
    handle.catch(() => { if (handles.get(key) === handle) handles.delete(key); });
  }
  return (await handle).transaction(action);
}

/** Test/maintenance shutdown; application data remains on disk or in Postgres. */
export async function closeDatabases(): Promise<void> {
  const current = [...handles.values()]; handles.clear();
  await Promise.all(current.map(async handle => { try { await (await handle).close(); } catch { /* Failed initialization already closed. */ } }));
}

export async function storageHealth() {
  return databaseTransaction(async db => { await db.query("SELECT 1 AS healthy"); return { durable: true, backend: db.kind }; });
}
