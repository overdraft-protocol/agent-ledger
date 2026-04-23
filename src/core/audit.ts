import crypto from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../storage/postgres/schema.js";
import { LedgerError } from "./errors.js";

// Append-only, hash-chained audit log. One row per control-plane or data-plane
// mutation, INSERTed in the same DB transaction as the mutation (I29).
//
// Chain (ARCHITECTURE.md § Audit chain):
//   entry = { namespace_id, seq, created_at, actor_agent_id, request_id,
//             plane, kind, payload, prev_hash }
//   chain_hash = sha256(prev_hash || canonical_json(entry))
//
// Genesis: prev_hash = sha256(namespace_id || created_at_of_first_entry)

export type Plane = "control" | "data";

export interface AuditEntryInput {
  namespaceId: string;
  actorAgentId: string;
  requestId: string;
  plane: Plane;
  kind: string;
  payload: Record<string, unknown>;
}

export interface AuditEntryWritten {
  seq: bigint;
  chainHash: Buffer;
}

// RFC 8785-style canonical JSON: sort object keys lexicographically at every
// level, no insignificant whitespace, UTF-8. Arrays keep insertion order.
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => JSON.stringify(k) + ":" + canonicalJson((v as Record<string, unknown>)[k]),
  );
  return "{" + parts.join(",") + "}";
}

function sha256(...parts: (Buffer | string)[]): Buffer {
  const h = crypto.createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

function genesisPrevHash(namespaceId: string, createdAt: Date): Buffer {
  return sha256(namespaceId, createdAt.toISOString());
}

// Append one audit entry inside an active transaction. Caller supplies the
// transaction handle so the audit row commits atomically with the mutation.
// Advances audit_heads for the namespace (UPSERT).
export async function appendAudit(
  tx: Kysely<Database>,
  input: AuditEntryInput,
): Promise<AuditEntryWritten> {
  // Fetch (and row-lock) current head. SELECT ... FOR UPDATE prevents two
  // concurrent transactions from deriving the same seq+prev_hash.
  const head = await sql<{ seq: string; chain_hash: Buffer } | undefined>`
    SELECT seq, chain_hash FROM audit_heads
    WHERE namespace_id = ${input.namespaceId}
    FOR UPDATE
  `.execute(tx);

  const headRow = head.rows[0];
  const createdAt = new Date();
  const nextSeq = headRow ? BigInt(headRow.seq) + 1n : 1n;
  const prevHash = headRow ? headRow.chain_hash : genesisPrevHash(input.namespaceId, createdAt);

  const entry = {
    namespace_id: input.namespaceId,
    seq: nextSeq.toString(),
    created_at: createdAt.toISOString(),
    actor_agent_id: input.actorAgentId,
    request_id: input.requestId,
    plane: input.plane,
    kind: input.kind,
    payload: input.payload,
    prev_hash: prevHash.toString("hex"),
  };
  const chainHash = sha256(prevHash, canonicalJson(entry));

  await tx
    .insertInto("audit_log")
    .values({
      namespace_id: input.namespaceId,
      seq: nextSeq.toString(),
      created_at: createdAt,
      actor_agent_id: input.actorAgentId,
      request_id: input.requestId,
      plane: input.plane,
      kind: input.kind,
      payload: JSON.stringify(input.payload),
      prev_hash: prevHash,
      chain_hash: chainHash,
    })
    .execute();

  if (headRow) {
    await tx
      .updateTable("audit_heads")
      .set({ seq: nextSeq.toString(), chain_hash: chainHash, updated_at: sql<Date>`now()` })
      .where("namespace_id", "=", input.namespaceId)
      .execute();
  } else {
    await tx
      .insertInto("audit_heads")
      .values({
        namespace_id: input.namespaceId,
        seq: nextSeq.toString(),
        chain_hash: chainHash,
        updated_at: createdAt,
      })
      .execute();
  }

  return { seq: nextSeq, chainHash };
}

// Read back a range of audit entries (for audit.read RPC).
export interface AuditReadRow {
  seq: string;
  created_at: Date;
  actor_agent_id: string;
  request_id: string;
  plane: Plane;
  kind: string;
  payload: unknown;
  prev_hash: Buffer;
  chain_hash: Buffer;
}

export async function readAudit(
  db: Kysely<Database>,
  namespaceId: string,
  fromSeq: bigint,
  limit: number,
): Promise<AuditReadRow[]> {
  if (limit <= 0 || limit > 1000) {
    throw new LedgerError("invalid_params", "limit must be in (0, 1000]");
  }
  const rows = await db
    .selectFrom("audit_log")
    .select([
      "seq",
      "created_at",
      "actor_agent_id",
      "request_id",
      "plane",
      "kind",
      "payload",
      "prev_hash",
      "chain_hash",
    ])
    .where("namespace_id", "=", namespaceId)
    .where("seq", ">=", fromSeq.toString())
    .orderBy("seq", "asc")
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    seq: r.seq,
    created_at: r.created_at,
    actor_agent_id: r.actor_agent_id,
    request_id: r.request_id,
    plane: r.plane as Plane,
    kind: r.kind,
    payload: r.payload,
    prev_hash: r.prev_hash,
    chain_hash: r.chain_hash,
  }));
}

// Current head (for audit.head — external anchoring).
export async function getAuditHead(
  db: Kysely<Database>,
  namespaceId: string,
): Promise<{ seq: bigint; chainHash: Buffer } | null> {
  const r = await db
    .selectFrom("audit_heads")
    .select(["seq", "chain_hash"])
    .where("namespace_id", "=", namespaceId)
    .executeTakeFirst();
  if (!r) return null;
  return { seq: BigInt(r.seq), chainHash: r.chain_hash };
}

// Verify the chain over [fromSeq, toSeq]. Returns the first diverging seq or
// null if the range is consistent. Does NOT verify entries outside the range —
// callers anchor trust by checking the first entry's prev_hash against a
// previously-known chain_hash (or genesis).
export async function verifyAudit(
  db: Kysely<Database>,
  namespaceId: string,
  fromSeq: bigint,
  toSeq: bigint,
): Promise<{ firstDivergentSeq: bigint | null }> {
  if (toSeq < fromSeq) {
    throw new LedgerError("invalid_params", "toSeq must be >= fromSeq");
  }
  if (toSeq - fromSeq > 10_000n) {
    throw new LedgerError("invalid_params", "verify range may not exceed 10000 entries");
  }

  const rows = await db
    .selectFrom("audit_log")
    .select([
      "seq",
      "created_at",
      "actor_agent_id",
      "request_id",
      "plane",
      "kind",
      "payload",
      "prev_hash",
      "chain_hash",
    ])
    .where("namespace_id", "=", namespaceId)
    .where("seq", ">=", fromSeq.toString())
    .where("seq", "<=", toSeq.toString())
    .orderBy("seq", "asc")
    .execute();

  for (const r of rows) {
    const createdAt = r.created_at;
    const entry = {
      namespace_id: namespaceId,
      seq: r.seq,
      created_at: createdAt.toISOString(),
      actor_agent_id: r.actor_agent_id,
      request_id: r.request_id,
      plane: r.plane,
      kind: r.kind,
      payload: r.payload,
      prev_hash: r.prev_hash.toString("hex"),
    };
    const expected = sha256(r.prev_hash, canonicalJson(entry));
    if (!crypto.timingSafeEqual(expected, r.chain_hash)) {
      return { firstDivergentSeq: BigInt(r.seq) };
    }
  }
  return { firstDivergentSeq: null };
}

// Ensure the partition covering `when` exists. Called at server boot and
// opportunistically; idempotent.
export async function ensureAuditPartition(db: Kysely<Database>, when: Date): Promise<void> {
  const y = when.getUTCFullYear();
  const m = when.getUTCMonth(); // 0-indexed
  const monthStart = new Date(Date.UTC(y, m, 1));
  const monthEnd = new Date(Date.UTC(y, m + 1, 1));
  const name = `audit_log_${y}_${String(m + 1).padStart(2, "0")}`;
  const startStr = monthStart.toISOString().slice(0, 10);
  const endStr = monthEnd.toISOString().slice(0, 10);

  // Delegate identifier + literal quoting to Postgres's own `format()` helper.
  // Inputs are server-derived (year/month); no user input reaches this path.
  await sql`
    SELECT format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
      ${name}::text, ${startStr}::date, ${endStr}::date
    ) AS stmt
  `.execute(db).then(async (r) => {
    const stmt = (r.rows[0] as { stmt: string } | undefined)?.stmt;
    if (stmt) await sql.raw(stmt).execute(db);
  });
}
