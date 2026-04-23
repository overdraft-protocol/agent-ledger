import type { Kysely } from "kysely";
import type { Database } from "../../storage/postgres/schema.js";
import { LedgerError } from "../errors.js";
import { docDelete, docPut } from "../doc.js";
import { logAppend, logCreate } from "../log.js";
import { counterCreate, counterIncr, counterReset } from "../counter.js";
import { lockAcquire, lockRefresh, lockRelease } from "../lock.js";
import type { Op } from "./grammar.js";
import {
  asBigint,
  asInteger,
  asString,
  resolveExpr,
  type SubstitutionEnv,
} from "./substitute.js";

// Op dispatcher. Every op is a primitive mutation with parameter slots already
// resolved. Ordered; stops at first error. Parent tx handles rollback (I4).

export interface OpResult {
  op: string;
  result: Record<string, unknown>;
}

export async function executeOps(
  tx: Kysely<Database>,
  namespaceId: string,
  ops: Op[],
  env: SubstitutionEnv,
): Promise<OpResult[]> {
  const results: OpResult[] = [];
  for (let i = 0; i < ops.length; i++) {
    try {
      results.push(await executeOp(tx, namespaceId, ops[i]!, env));
    } catch (e) {
      if (e instanceof LedgerError) {
        const prev = e.details ?? {};
        (e as { details: Record<string, unknown> }).details = { ...prev, op_index: i };
      }
      throw e;
    }
  }
  return results;
}

async function executeOp(
  tx: Kysely<Database>,
  namespaceId: string,
  op: Op,
  env: SubstitutionEnv,
): Promise<OpResult> {
  switch (op.o) {
    case "doc.put": {
      const path = asString(resolveExpr(op.path, env), "doc.put.path");
      const value = resolveExpr(op.value, env);
      const input: Parameters<typeof docPut>[2] = {
        path,
        schemaName: op.schema_name,
        schemaVersion: op.schema_version,
        value,
      };
      if (op.expected_version !== undefined) {
        input.expectedVersion = asBigint(resolveExpr(op.expected_version, env), "doc.put.expected_version");
      }
      const r = await docPut(tx, namespaceId, input);
      return { op: "doc.put", result: {
        path, version: r.version.toString(),
        added_blobs: r.newBlobs, removed_blobs: r.previousBlobs,
      } };
    }
    case "doc.del": {
      const path = asString(resolveExpr(op.path, env), "doc.del.path");
      const expected = op.expected_version !== undefined
        ? asBigint(resolveExpr(op.expected_version, env), "doc.del.expected_version")
        : undefined;
      const r = await docDelete(tx, namespaceId, path, expected);
      return { op: "doc.del", result: { path, removed_blobs: r.previousBlobs } };
    }
    case "log.create": {
      const logId = asString(resolveExpr(op.log_id, env), "log.create.log_id");
      await logCreate(tx, namespaceId, logId, op.schema_name, op.schema_version);
      return { op: "log.create", result: { log_id: logId } };
    }
    case "log.append": {
      const logId = asString(resolveExpr(op.log_id, env), "log.append.log_id");
      const value = resolveExpr(op.value, env);
      const r = await logAppend(tx, namespaceId, logId, value);
      return { op: "log.append", result: { log_id: logId, offset: r.offset.toString() } };
    }
    case "counter.create": {
      const path = asString(resolveExpr(op.path, env), "counter.create.path");
      const initial = asBigint(resolveExpr(op.initial, env), "counter.create.initial");
      const min = asBigint(resolveExpr(op.min, env), "counter.create.min");
      const max = asBigint(resolveExpr(op.max, env), "counter.create.max");
      await counterCreate(tx, namespaceId, path, initial, min, max);
      return { op: "counter.create", result: { path } };
    }
    case "counter.incr": {
      const path = asString(resolveExpr(op.path, env), "counter.incr.path");
      const delta = asBigint(resolveExpr(op.delta, env), "counter.incr.delta");
      const r = await counterIncr(tx, namespaceId, path, delta);
      return { op: "counter.incr", result: { path, n: r.n.toString() } };
    }
    case "counter.reset": {
      const path = asString(resolveExpr(op.path, env), "counter.reset.path");
      const to = asBigint(resolveExpr(op.to, env), "counter.reset.to");
      await counterReset(tx, namespaceId, path, to);
      return { op: "counter.reset", result: { path, n: to.toString() } };
    }
    case "lock.acquire": {
      const path = asString(resolveExpr(op.path, env), "lock.acquire.path");
      const ttlMs = asInteger(resolveExpr(op.ttl_ms, env), "lock.acquire.ttl_ms");
      const r = await lockAcquire(tx, namespaceId, path, env.caller, ttlMs);
      return { op: "lock.acquire", result: {
        path, fence: r.fence.toString(),
        expires_at: r.expires_at.toISOString(),
      } };
    }
    case "lock.refresh": {
      const path = asString(resolveExpr(op.path, env), "lock.refresh.path");
      const fence = asBigint(resolveExpr(op.fence, env), "lock.refresh.fence");
      const ttlMs = asInteger(resolveExpr(op.ttl_ms, env), "lock.refresh.ttl_ms");
      const r = await lockRefresh(tx, namespaceId, path, env.caller, fence, ttlMs);
      return { op: "lock.refresh", result: {
        path, expires_at: r.expires_at.toISOString(),
      } };
    }
    case "lock.release": {
      const path = asString(resolveExpr(op.path, env), "lock.release.path");
      const fence = asBigint(resolveExpr(op.fence, env), "lock.release.fence");
      await lockRelease(tx, namespaceId, path, env.caller, fence);
      return { op: "lock.release", result: { path } };
    }
  }
  throw new LedgerError("internal", "unreachable: unknown op");
}
