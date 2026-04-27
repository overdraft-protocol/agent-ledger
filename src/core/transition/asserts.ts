import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../../storage/postgres/schema.js";
import { LedgerError } from "../errors.js";
import { validatePath } from "../path.js";
import { assertLockFence } from "../lock.js";
import type { Assert } from "./grammar.js";
import { asBigint, asString, resolveExpr, type SubstitutionEnv } from "./substitute.js";

// Assert evaluator. Called inside the transition tx AFTER row-locking the rows
// an assert or op will touch (step 5 of tx.invoke execution model, simplified:
// we rely on FOR UPDATE inside each primitive instead of a separate lock pass).

export async function evaluateAsserts(
  tx: Kysely<Database>,
  namespaceId: string,
  asserts: Assert[],
  env: SubstitutionEnv,
): Promise<void> {
  for (let i = 0; i < asserts.length; i++) {
    try {
      await evaluateAssert(tx, namespaceId, asserts[i]!, env);
    } catch (e) {
      if (e instanceof LedgerError) {
        // Re-tag precondition failures with the failing assert's index AND its
        // declared structure, so callers can pinpoint which precondition tripped
        // without a separate transition.get round-trip.
        const tag = { assert_index: i, assert: asserts[i] };
        if (e.details === undefined) {
          (e as { details: unknown }).details = tag;
        } else {
          Object.assign((e as { details: Record<string, unknown> }).details, tag);
        }
        throw e;
      }
      throw e;
    }
  }
}

async function evaluateAssert(
  tx: Kysely<Database>,
  namespaceId: string,
  a: Assert,
  env: SubstitutionEnv,
): Promise<void> {
  switch (a.a) {
    case "doc.exists": {
      const path = validatePath(asString(resolveExpr(a.path, env), "doc.exists.path"));
      const row = await sql<{ exists: boolean } | undefined>`
        SELECT true AS exists FROM docs
        WHERE namespace_id = ${namespaceId} AND path = ${path}
        FOR SHARE
      `.execute(tx);
      if (!row.rows[0]) fail("doc.exists", { path });
      return;
    }
    case "doc.version_eq": {
      const path = validatePath(asString(resolveExpr(a.path, env), "doc.version_eq.path"));
      const version = asBigint(resolveExpr(a.version, env), "doc.version_eq.version");
      const row = await sql<{ version: string } | undefined>`
        SELECT version FROM docs
        WHERE namespace_id = ${namespaceId} AND path = ${path}
        FOR UPDATE
      `.execute(tx);
      if (!row.rows[0]) fail("doc.version_eq: doc missing", { path });
      if (BigInt(row.rows[0].version) !== version) {
        fail("doc.version_eq", { path, expected: version.toString(), actual: row.rows[0].version });
      }
      return;
    }
    case "doc.field_eq": {
      const path = validatePath(asString(resolveExpr(a.path, env), "doc.field_eq.path"));
      const field = asString(resolveExpr(a.field, env), "doc.field_eq.field");
      const expected = resolveExpr(a.value, env);
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) {
        throw new LedgerError("invalid_params", "doc.field_eq.field must be a simple identifier");
      }
      const row = await sql<{ value: unknown } | undefined>`
        SELECT value -> ${field} AS value FROM docs
        WHERE namespace_id = ${namespaceId} AND path = ${path}
        FOR SHARE
      `.execute(tx);
      if (!row.rows[0]) fail("doc.field_eq: doc missing", { path });
      const actual = row.rows[0].value;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        fail("doc.field_eq", { path, field, expected, actual });
      }
      return;
    }
    case "counter.eq":
    case "counter.gte":
    case "counter.lte": {
      const path = validatePath(asString(resolveExpr(a.path, env), `${a.a}.path`));
      const value = asBigint(resolveExpr(a.value, env), `${a.a}.value`);
      const row = await sql<{ n: string } | undefined>`
        SELECT n FROM counters
        WHERE namespace_id = ${namespaceId} AND path = ${path}
        FOR SHARE
      `.execute(tx);
      if (!row.rows[0]) fail(`${a.a}: counter missing`, { path });
      const n = BigInt(row.rows[0].n);
      const ok = a.a === "counter.eq" ? n === value
              : a.a === "counter.gte" ? n >= value
              : n <= value;
      if (!ok) fail(a.a, { path, value: value.toString(), actual: n.toString() });
      return;
    }
    case "counter.in_range": {
      const path = validatePath(asString(resolveExpr(a.path, env), "counter.in_range.path"));
      const min = asBigint(resolveExpr(a.min, env), "counter.in_range.min");
      const max = asBigint(resolveExpr(a.max, env), "counter.in_range.max");
      const row = await sql<{ n: string } | undefined>`
        SELECT n FROM counters
        WHERE namespace_id = ${namespaceId} AND path = ${path}
        FOR SHARE
      `.execute(tx);
      if (!row.rows[0]) fail("counter.in_range: counter missing", { path });
      const n = BigInt(row.rows[0].n);
      if (n < min || n > max) {
        fail("counter.in_range", { path, min: min.toString(), max: max.toString(), actual: n.toString() });
      }
      return;
    }
    case "log.offset_eq": {
      const logId = asString(resolveExpr(a.log_id, env), "log.offset_eq.log_id");
      const offset = asBigint(resolveExpr(a.offset, env), "log.offset_eq.offset");
      const row = await sql<{ next_offset: string } | undefined>`
        SELECT next_offset FROM logs
        WHERE namespace_id = ${namespaceId} AND log_id = ${logId}
        FOR SHARE
      `.execute(tx);
      if (!row.rows[0]) fail("log.offset_eq: log missing", { log_id: logId });
      if (BigInt(row.rows[0].next_offset) !== offset) {
        fail("log.offset_eq", {
          log_id: logId,
          expected: offset.toString(),
          actual: row.rows[0].next_offset,
        });
      }
      return;
    }
    case "log.length_gte": {
      const logId = asString(resolveExpr(a.log_id, env), "log.length_gte.log_id");
      const length = asBigint(resolveExpr(a.length, env), "log.length_gte.length");
      const row = await sql<{ next_offset: string } | undefined>`
        SELECT next_offset FROM logs
        WHERE namespace_id = ${namespaceId} AND log_id = ${logId}
        FOR SHARE
      `.execute(tx);
      if (!row.rows[0]) fail("log.length_gte: log missing", { log_id: logId });
      if (BigInt(row.rows[0].next_offset) < length) {
        fail("log.length_gte", {
          log_id: logId,
          min: length.toString(),
          actual: row.rows[0].next_offset,
        });
      }
      return;
    }
    case "lock.fence_matches": {
      const path = validatePath(asString(resolveExpr(a.path, env), "lock.fence_matches.path"));
      const fence = asBigint(resolveExpr(a.fence, env), "lock.fence_matches.fence");
      await assertLockFence(tx, namespaceId, path, fence);
      return;
    }
    case "expr.cmp": {
      // Pure-expression comparison — no DB access. Resolves both Exprs and
      // compares them. eq/ne use deep JSON equality (matching doc.field_eq).
      // Ordered ops (lt/lte/gt/gte) require both sides to be the same
      // primitive scalar type (string OR number); anything else is a caller
      // bug and surfaces as invalid_params, not a precondition_failed.
      const lhs = resolveExpr(a.lhs, env);
      const rhs = resolveExpr(a.rhs, env);
      const ok = compareValues(a.op, lhs, rhs);
      if (!ok) fail("expr.cmp", { op: a.op, lhs, rhs });
      return;
    }
  }
}

function compareValues(
  op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte",
  lhs: unknown,
  rhs: unknown,
): boolean {
  if (op === "eq") return JSON.stringify(lhs) === JSON.stringify(rhs);
  if (op === "ne") return JSON.stringify(lhs) !== JSON.stringify(rhs);
  // Ordered ops: same primitive scalar type required.
  const bothStrings = typeof lhs === "string" && typeof rhs === "string";
  const bothNumbers =
    typeof lhs === "number" && Number.isFinite(lhs) &&
    typeof rhs === "number" && Number.isFinite(rhs);
  if (!bothStrings && !bothNumbers) {
    throw new LedgerError("invalid_params",
      `expr.cmp op "${op}" requires both sides to be the same scalar type ` +
      `(string or finite number); got ${describeType(lhs)} vs ${describeType(rhs)}`);
  }
  switch (op) {
    case "lt":  return (lhs as string | number) <  (rhs as string | number);
    case "lte": return (lhs as string | number) <= (rhs as string | number);
    case "gt":  return (lhs as string | number) >  (rhs as string | number);
    case "gte": return (lhs as string | number) >= (rhs as string | number);
  }
}

function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function fail(kind: string, details: Record<string, unknown>): never {
  throw new LedgerError("precondition_failed", `assert failed: ${kind}`, details);
}
