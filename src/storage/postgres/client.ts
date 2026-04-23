import pg from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { loadConfig } from "../../config.js";
import type { Database } from "./schema.js";

// Invariant: one Pool per process; serializable isolation is per-transaction, not connection-wide.
// The tail/notify listener uses its own dedicated Client, see core/log.ts.

let pool: pg.Pool | null = null;
let db: Kysely<Database> | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;
  const config = loadConfig();
  pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.PG_POOL_MAX,
    idleTimeoutMillis: 30_000,
    // Allow long-running tails and transitions; statement timeout is per-query.
    statement_timeout: 30_000,
    query_timeout: 30_000,
    application_name: "agent-ledger",
  });
  return pool;
}

export function getDb(): Kysely<Database> {
  if (db) return db;
  db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: getPool() }),
  });
  return db;
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.destroy();
    db = null;
  }
  if (pool) {
    await pool.end();
    pool = null;
  }
}
