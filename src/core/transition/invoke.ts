import crypto from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Database, JsonValue } from "../../storage/postgres/schema.js";
import { LedgerError } from "../errors.js";
import { compileToZod, validateWithBudget } from "../schema.js";
import { appendAudit } from "../audit.js";
import { evaluateAsserts } from "./asserts.js";
import { executeOps, type OpResult } from "./ops.js";
import { loadTransition } from "./registry.js";
import type { SubstitutionEnv } from "./substitute.js";

// `tx.invoke` execution model (ARCHITECTURE.md §Transitions.Execution):
// 1. Load transition (throws if missing/deprecated)
// 2. Validate params vs params_schema
// 3. Idempotency check
// 4. BEGIN SERIALIZABLE transaction
// 5. Evaluate asserts (FOR UPDATE / FOR SHARE row locks inside)
// 6. Execute ops (in declaration order)
// 7. Append audit entry (same tx)
// 8. Store idempotency result
// 9. COMMIT
//
// On serialization failure, Postgres raises SQLSTATE 40001; the caller retries
// transparently a bounded number of times.

const IDEMPOTENCY_TTL_HOURS = 24;
// At SERIALIZABLE, any hot row (counter, shared doc) forces retries. 3 was too
// low under realistic contention — 10 gives ~1000x headroom while still
// surfacing pathological hotspots.
const MAX_RETRIES = 10;
const BACKOFF_BASE_MS = 2;

export interface InvokeInput {
  namespaceId: string;
  agentId: string;
  requestId: string;
  transitionName: string;
  transitionVersion?: number;
  params: Record<string, unknown>;
  idempotencyKey: string; // mandatory per I3
}

export interface InvokeResult {
  transition: { name: string; version: number };
  txId: string;
  auditSeq: string;
  auditChainHash: string; // hex
  ops: OpResult[];
  idempotent: boolean;
}

export async function invoke(
  db: Kysely<Database>,
  input: InvokeInput,
): Promise<InvokeResult> {
  if (typeof input.idempotencyKey !== "string" ||
      input.idempotencyKey.length < 8 ||
      input.idempotencyKey.length > 128) {
    throw new LedgerError("invalid_params", "idempotency_key must be 8..128 chars");
  }

  // 1) Load definition.
  const t = await loadTransition(
    db, input.namespaceId, input.transitionName, input.transitionVersion,
  );

  // 2) Validate params.
  const paramsValidator = compileToZod(t.def.params_schema);
  validateWithBudget(paramsValidator, input.params, {
    against: "params_schema",
    transition: { name: t.name, version: t.version },
    params_schema: t.def.params_schema,
  });

  // 3) Idempotency check (outside tx; any stored result short-circuits).
  const stored = await db
    .selectFrom("idempotency")
    .select(["result", "expires_at"])
    .where("agent_id", "=", input.agentId)
    .where("key", "=", input.idempotencyKey)
    .where("expires_at", ">", new Date())
    .executeTakeFirst();
  if (stored) {
    const r = stored.result as unknown as InvokeResult;
    return { ...r, idempotent: true };
  }

  // 4–9) Retry-on-serialization-conflict loop.
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    try {
      const txId = crypto.randomUUID();
      const now = new Date();
      const env: SubstitutionEnv = {
        caller: input.agentId,
        now: now.toISOString(),
        requestId: input.requestId,
        txId,
        params: Object.freeze({ ...input.params }),
      };

      const result = await db.transaction().setIsolationLevel("serializable").execute(async (tx) => {
        await evaluateAsserts(tx, input.namespaceId, t.def.asserts, env);
        const opResults = await executeOps(tx, input.namespaceId, t.def.ops, env);

        const auditPayload: Record<string, unknown> = {
          transition: { name: t.name, version: t.version },
          tx_id: txId,
          params: input.params,
          op_results: opResults,
        };
        const audit = await appendAudit(tx, {
          namespaceId: input.namespaceId,
          actorAgentId: input.agentId,
          requestId: input.requestId,
          plane: "data",
          kind: "tx.invoke",
          payload: auditPayload,
        });

        const resultPayload: InvokeResult = {
          transition: { name: t.name, version: t.version },
          txId,
          auditSeq: audit.seq.toString(),
          auditChainHash: audit.chainHash.toString("hex"),
          ops: opResults,
          idempotent: false,
        };

        // Idempotency row — same tx as mutation so on retry we either see
        // committed result or see nothing.
        const expires = new Date(now.getTime() + IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000);
        await tx
          .insertInto("idempotency")
          .values({
            agent_id: input.agentId,
            key: input.idempotencyKey,
            result: JSON.stringify(resultPayload as unknown as JsonValue),
            expires_at: expires,
          })
          .onConflict((oc) => oc.columns(["agent_id", "key"]).doNothing())
          .execute();

        return resultPayload;
      });

      return result;
    } catch (e) {
      // Postgres serialization failure — retry with jittered exponential backoff
      // to avoid thundering-herd on a hot row.
      const code = (e as { code?: string }).code;
      if (code === "40001" && attempt < MAX_RETRIES) {
        const delay = BACKOFF_BASE_MS * 2 ** (attempt - 1) * (0.5 + Math.random());
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      // Unique-violation on idempotency (23505) means a concurrent invocation
      // won the race; re-read and return that result.
      if (code === "23505") {
        const row = await db
          .selectFrom("idempotency")
          .select("result")
          .where("agent_id", "=", input.agentId)
          .where("key", "=", input.idempotencyKey)
          .executeTakeFirst();
        if (row) {
          const r = row.result as unknown as InvokeResult;
          return { ...r, idempotent: true };
        }
      }
      throw e;
    }
  }
}

// Garbage-collect expired idempotency rows. Called by a background sweeper.
export async function sweepExpiredIdempotency(db: Kysely<Database>): Promise<number> {
  const r = await sql<{ n: string }>`
    WITH deleted AS (
      DELETE FROM idempotency WHERE expires_at < now() RETURNING 1
    )
    SELECT count(*)::bigint AS n FROM deleted
  `.execute(db);
  return Number((r.rows[0]?.n) ?? 0);
}
