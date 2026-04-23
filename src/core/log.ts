import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../storage/postgres/schema.js";
import { LedgerError } from "./errors.js";
import { compileToZod, loadSchema, validateWithBudget } from "./schema.js";

// `log` — dense append-only event streams. I19: offsets assigned by row-locked
// per-log counter (not a Postgres SEQUENCE), so no gaps on rollback.

export const LOG_ENTRY_MAX_BYTES = 256 * 1024;
const LOG_ID_MAX = 128;

function validateLogId(id: string): void {
  if (typeof id !== "string" || id.length === 0 || id.length > LOG_ID_MAX) {
    throw new LedgerError("invalid_params", "log_id must be 1..128 chars");
  }
  if (!/^[a-zA-Z0-9._\-/]+$/.test(id)) {
    throw new LedgerError("invalid_params", "log_id contains disallowed characters");
  }
}

export interface LogInfo {
  log_id: string;
  schema_name: string;
  schema_version: number;
  next_offset: string; // bigint
}

export async function logGet(
  db: Kysely<Database>,
  namespaceId: string,
  logId: string,
): Promise<LogInfo | null> {
  validateLogId(logId);
  const r = await db
    .selectFrom("logs")
    .select(["log_id", "schema_name", "schema_version", "next_offset"])
    .where("namespace_id", "=", namespaceId)
    .where("log_id", "=", logId)
    .executeTakeFirst();
  return r ?? null;
}

export interface LogEntry {
  offset: string; // bigint
  value: unknown;
  appended_at: Date;
}

export async function logRead(
  db: Kysely<Database>,
  namespaceId: string,
  logId: string,
  fromOffset: bigint,
  limit: number,
): Promise<LogEntry[]> {
  validateLogId(logId);
  if (limit <= 0 || limit > 1000) {
    throw new LedgerError("invalid_params", "limit must be in (0, 1000]");
  }
  const rows = await db
    .selectFrom("log_entries")
    .select(["offset_id", "value", "appended_at"])
    .where("namespace_id", "=", namespaceId)
    .where("log_id", "=", logId)
    .where("offset_id", ">=", fromOffset.toString())
    .orderBy("offset_id", "asc")
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    offset: r.offset_id,
    value: r.value,
    appended_at: r.appended_at,
  }));
}

// --- Mutations inside an active tx --------------------------------------

// Create a new log bound to a schema version. Idempotent on (namespace, log_id)
// iff the same schema binding is supplied.
export async function logCreate(
  tx: Kysely<Database>,
  namespaceId: string,
  logId: string,
  schemaName: string,
  schemaVersion: number,
): Promise<void> {
  validateLogId(logId);
  // Ensure schema exists (throws not_found otherwise).
  const { deprecated } = await loadSchema(tx, namespaceId, schemaName, schemaVersion);
  if (deprecated) {
    throw new LedgerError("schema_immutable", "cannot bind a log to a deprecated schema");
  }

  const existing = await tx
    .selectFrom("logs")
    .select(["schema_name", "schema_version"])
    .where("namespace_id", "=", namespaceId)
    .where("log_id", "=", logId)
    .executeTakeFirst();
  if (existing) {
    if (existing.schema_name !== schemaName || existing.schema_version !== schemaVersion) {
      throw new LedgerError("conflict", "log already exists with different schema binding", {
        log_id: logId,
      });
    }
    return;
  }

  await tx
    .insertInto("logs")
    .values({
      namespace_id: namespaceId,
      log_id: logId,
      schema_name: schemaName,
      schema_version: schemaVersion,
    })
    .execute();
}

export async function logAppend(
  tx: Kysely<Database>,
  namespaceId: string,
  logId: string,
  value: unknown,
): Promise<{ offset: bigint }> {
  validateLogId(logId);
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > LOG_ENTRY_MAX_BYTES) {
    throw new LedgerError("too_large", `log entry exceeds ${LOG_ENTRY_MAX_BYTES} bytes`);
  }

  // Row-lock the log row + bump next_offset in a single statement (I19).
  const offsetRow = await sql<{ offset_id: string; schema_name: string; schema_version: number } | undefined>`
    UPDATE logs
    SET next_offset = next_offset + 1
    WHERE namespace_id = ${namespaceId} AND log_id = ${logId}
    RETURNING (next_offset - 1)::bigint AS offset_id, schema_name, schema_version
  `.execute(tx);

  const row = offsetRow.rows[0];
  if (!row) {
    throw new LedgerError("not_found", `log not found: ${logId}`);
  }

  // Validate against the log's bound schema.
  const { dsl } = await loadSchema(tx, namespaceId, row.schema_name, row.schema_version);
  const validator = compileToZod(dsl);
  validateWithBudget(validator, value);

  const offset = BigInt(row.offset_id);
  await tx
    .insertInto("log_entries")
    .values({
      namespace_id: namespaceId,
      log_id: logId,
      offset_id: offset.toString(),
      value: JSON.stringify(value),
    })
    .execute();

  return { offset };
}
