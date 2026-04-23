import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, closeDb } from "./client.js";
import { logger } from "../../telemetry/logger.js";

// Plain-SQL migrations, numbered, append-only. Applied in a transaction per file.

const MIGRATIONS_DIR = path.dirname(fileURLToPath(import.meta.url)) + "/migrations";

const MIGRATIONS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS migrations (
    id          int PRIMARY KEY,
    name        text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  );
`;

export async function runMigrations(): Promise<void> {
  const pool = getPool();
  await pool.query(MIGRATIONS_TABLE_DDL);

  const files = (await fs.readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied = new Set(
    (await pool.query<{ id: number }>("SELECT id FROM migrations")).rows.map((r) => r.id),
  );

  for (const file of files) {
    const match = file.match(/^(\d+)_/);
    if (!match?.[1]) {
      throw new Error(`Migration file '${file}' does not start with a numeric prefix`);
    }
    const id = Number(match[1]);
    if (applied.has(id)) continue;

    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO migrations (id, name) VALUES ($1, $2)", [id, file]);
      await client.query("COMMIT");
      logger.info({ migration: file }, "migration applied");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
}

// CLI entry point
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runMigrations()
    .then(async () => {
      logger.info("migrations complete");
      await closeDb();
      process.exit(0);
    })
    .catch(async (err) => {
      logger.error({ err }, "migration failed");
      await closeDb().catch(() => undefined);
      process.exit(1);
    });
}
