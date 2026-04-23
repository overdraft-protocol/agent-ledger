import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../storage/postgres/schema.js";
import { LedgerError } from "./errors.js";
import { validatePath } from "./path.js";

// `counter` — atomic bounded int64. Bounds declared at creation; violations
// are explicit errors. Single-statement increment with row lock.

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

function checkInt64(n: bigint, label: string): void {
  if (n < I64_MIN || n > I64_MAX) {
    throw new LedgerError("bounds_violation", `${label} exceeds int64 range`);
  }
}

export interface CounterInfo {
  path: string;
  n: string;
  min_value: string;
  max_value: string;
}

export async function counterGet(
  db: Kysely<Database>,
  namespaceId: string,
  path: string,
): Promise<CounterInfo | null> {
  validatePath(path);
  const r = await db
    .selectFrom("counters")
    .select(["path", "n", "min_value", "max_value"])
    .where("namespace_id", "=", namespaceId)
    .where("path", "=", path)
    .executeTakeFirst();
  return r ?? null;
}

// --- Mutations inside an active tx --------------------------------------

export async function counterCreate(
  tx: Kysely<Database>,
  namespaceId: string,
  path: string,
  initial: bigint,
  minValue: bigint,
  maxValue: bigint,
): Promise<void> {
  validatePath(path);
  checkInt64(initial, "initial");
  checkInt64(minValue, "min_value");
  checkInt64(maxValue, "max_value");
  if (minValue > maxValue) {
    throw new LedgerError("bounds_violation", "min_value > max_value");
  }
  if (initial < minValue || initial > maxValue) {
    throw new LedgerError("bounds_violation", "initial outside [min,max]");
  }

  const existing = await tx
    .selectFrom("counters")
    .select("path")
    .where("namespace_id", "=", namespaceId)
    .where("path", "=", path)
    .executeTakeFirst();
  if (existing) {
    throw new LedgerError("conflict", "counter already exists", { path });
  }

  await tx
    .insertInto("counters")
    .values({
      namespace_id: namespaceId,
      path,
      n: initial.toString(),
      min_value: minValue.toString(),
      max_value: maxValue.toString(),
    })
    .execute();
}

export async function counterIncr(
  tx: Kysely<Database>,
  namespaceId: string,
  path: string,
  delta: bigint,
): Promise<{ n: bigint }> {
  validatePath(path);
  checkInt64(delta, "delta");

  // Single-statement atomic update under the PK row lock. The CHECK constraint
  // (`n BETWEEN min_value AND max_value`) enforces bounds at the DB layer; we
  // translate the violation into a typed bounds_violation for clients.
  try {
    const r = await sql<{ n: string } | undefined>`
      UPDATE counters
      SET n = n + ${delta.toString()}::bigint
      WHERE namespace_id = ${namespaceId} AND path = ${path}
      RETURNING n
    `.execute(tx);
    const row = r.rows[0];
    if (!row) throw new LedgerError("not_found", `counter not found: ${path}`);
    return { n: BigInt(row.n) };
  } catch (e) {
    if (e instanceof LedgerError) throw e;
    // Postgres CHECK violation → 23514.
    const msg = (e as { code?: string; message?: string }).code === "23514"
      ? "counter would exceed declared bounds"
      : (e as Error).message;
    if ((e as { code?: string }).code === "23514") {
      throw new LedgerError("bounds_violation", msg, { path });
    }
    throw e;
  }
}

export async function counterReset(
  tx: Kysely<Database>,
  namespaceId: string,
  path: string,
  to: bigint,
): Promise<void> {
  validatePath(path);
  checkInt64(to, "to");

  // Fetch bounds under lock to validate the target.
  const cur = await sql<{ min_value: string; max_value: string } | undefined>`
    SELECT min_value, max_value FROM counters
    WHERE namespace_id = ${namespaceId} AND path = ${path}
    FOR UPDATE
  `.execute(tx);
  const row = cur.rows[0];
  if (!row) throw new LedgerError("not_found", `counter not found: ${path}`);
  const min = BigInt(row.min_value);
  const max = BigInt(row.max_value);
  if (to < min || to > max) {
    throw new LedgerError("bounds_violation", "reset target outside [min,max]", { path });
  }

  await tx
    .updateTable("counters")
    .set({ n: to.toString() })
    .where("namespace_id", "=", namespaceId)
    .where("path", "=", path)
    .execute();
}
