import crypto from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { Database, EnrollmentStatus } from "../storage/postgres/schema.js";
import { LedgerError } from "../core/errors.js";

// Operator-gated agent enrollment.
//
// Lifecycle:
//   submit  -> 'pending'                 (caller receives enrollment_id + claim_secret)
//   approve -> 'approved'  + agent row   (operator action; CLI only)
//   reject  -> 'rejected'                (operator action; CLI only)
//   claim   -> 'claimed'                 (caller exchanges secret for agent_id; secret burned)
//   sweep   -> 'expired'                 (housekeeping; honours expires_at)
//
// Invariants enforced by the schema (CHECK constraints):
//   * Active rows (pending/approved) hold the secret hash.
//   * Closed rows (claimed/rejected/expired) do NOT hold the secret hash.
//   * approved/claimed rows have an agent_id; others do not.
//   * One active (pending|approved) row per oauth_subject (UNIQUE partial index).

const OAUTH_SUBJECT_RE = /^[a-zA-Z0-9_.+@:\-]{1,255}$/;
const NOTE_MAX = 512;
const REJECT_REASON_MAX = 512;

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h for both pending and approved-unclaimed

export interface EnrollmentRequest {
  id: string;
  oauth_subject: string;
  note: string | null;
  status: EnrollmentStatus;
  agent_id: string | null;
  reviewed_by_subject: string | null;
  reject_reason: string | null;
  requested_at: Date;
  reviewed_at: Date | null;
  claimed_at: Date | null;
  expires_at: Date;
}

export interface SubmitResult {
  enrollment_id: string;
  claim_secret: string;
  expires_at: Date;
  status: "pending";
}

export interface ClaimResult {
  status: EnrollmentStatus;
  agent_id?: string;
  reject_reason?: string;
}

function hashSecret(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

// Constant-time compare on equal-length buffers; false on length mismatch
// without short-circuiting in a way that leaks length differences for the
// authentic case (both inputs are sha256 digests in practice).
function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function submitEnrollment(
  db: Kysely<Database>,
  input: { oauthSubject: string; note?: string | null; ttlMs?: number },
): Promise<SubmitResult> {
  if (!OAUTH_SUBJECT_RE.test(input.oauthSubject)) {
    throw new LedgerError(
      "invalid_params",
      "oauth_subject must match /^[a-zA-Z0-9_.+@:-]{1,255}$/",
    );
  }
  if (input.note !== undefined && input.note !== null && input.note.length > NOTE_MAX) {
    throw new LedgerError("invalid_params", `note must be at most ${NOTE_MAX} characters`);
  }

  const ttl = input.ttlMs ?? DEFAULT_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl);

  // Sweep first so a previously-active-but-now-expired request doesn't block
  // a fresh submission. Cheap; runs in the same transaction.
  return await db.transaction().execute(async (tx) => {
    await sweepExpiredTx(tx);

    // Pre-check for an active row to surface a typed error rather than the
    // bare unique-constraint violation from the partial index.
    const active = await tx
      .selectFrom("enrollment_requests")
      .select("status")
      .where("oauth_subject", "=", input.oauthSubject)
      .where("status", "in", ["pending", "approved"])
      .executeTakeFirst();
    if (active) {
      throw new LedgerError(
        "conflict",
        `an enrollment request for this oauth_subject is already ${active.status}`,
      );
    }

    // If the subject is already a live agent, refuse — operator should have
    // told the caller to reuse the existing agent_id.
    const existingAgent = await tx
      .selectFrom("agents")
      .select(["id", "disabled_at"])
      .where("oauth_subject", "=", input.oauthSubject)
      .executeTakeFirst();
    if (existingAgent && existingAgent.disabled_at === null) {
      throw new LedgerError(
        "conflict",
        "an active agent already exists for this oauth_subject",
      );
    }

    // 32 bytes = 256 bits of entropy; base64url-encoded for transport.
    const claimSecret = crypto.randomBytes(32).toString("base64url");
    const row = await tx
      .insertInto("enrollment_requests")
      .values({
        oauth_subject: input.oauthSubject,
        note: input.note ?? null,
        claim_secret_hash: hashSecret(claimSecret),
        expires_at: expiresAt,
      })
      .returning(["id", "expires_at"])
      .executeTakeFirstOrThrow();

    return {
      enrollment_id: row.id,
      claim_secret: claimSecret,
      expires_at: row.expires_at,
      status: "pending" as const,
    };
  });
}

export async function approveEnrollment(
  db: Kysely<Database>,
  input: { enrollmentId: string; reviewedBySubject: string },
): Promise<{ enrollment_id: string; agent_id: string; oauth_subject: string }> {
  return await db.transaction().execute(async (tx) => {
    await sweepExpiredTx(tx);
    const req = await tx
      .selectFrom("enrollment_requests")
      .selectAll()
      .where("id", "=", input.enrollmentId)
      .forUpdate()
      .executeTakeFirst();
    if (!req) {
      throw new LedgerError("not_found", "enrollment request not found");
    }
    if (req.status !== "pending") {
      throw new LedgerError(
        "conflict",
        `enrollment request is ${req.status}; only pending requests may be approved`,
      );
    }

    // Reuse an existing (re-enabled) agent row keyed by oauth_subject if one
    // exists; otherwise create a new one. The unique constraint on
    // agents.oauth_subject keeps this honest.
    const existing = await tx
      .selectFrom("agents")
      .select(["id", "disabled_at"])
      .where("oauth_subject", "=", req.oauth_subject)
      .executeTakeFirst();

    let agentId: string;
    if (existing) {
      if (existing.disabled_at !== null) {
        throw new LedgerError(
          "conflict",
          "an agent for this oauth_subject exists but is disabled; re-enable it manually instead of approving",
        );
      }
      agentId = existing.id;
    } else {
      const agentRow = await tx
        .insertInto("agents")
        .values({ oauth_subject: req.oauth_subject })
        .returning("id")
        .executeTakeFirstOrThrow();
      agentId = agentRow.id;
    }

    await tx
      .updateTable("enrollment_requests")
      .set({
        status: "approved",
        agent_id: agentId,
        reviewed_by_subject: input.reviewedBySubject,
        reviewed_at: new Date(),
      })
      .where("id", "=", req.id)
      .execute();

    return { enrollment_id: req.id, agent_id: agentId, oauth_subject: req.oauth_subject };
  });
}

export async function rejectEnrollment(
  db: Kysely<Database>,
  input: { enrollmentId: string; reviewedBySubject: string; reason?: string | null },
): Promise<void> {
  if (input.reason && input.reason.length > REJECT_REASON_MAX) {
    throw new LedgerError("invalid_params", `reason must be at most ${REJECT_REASON_MAX} characters`);
  }
  await db.transaction().execute(async (tx) => {
    await sweepExpiredTx(tx);
    const req = await tx
      .selectFrom("enrollment_requests")
      .select(["id", "status"])
      .where("id", "=", input.enrollmentId)
      .forUpdate()
      .executeTakeFirst();
    if (!req) {
      throw new LedgerError("not_found", "enrollment request not found");
    }
    if (req.status !== "pending") {
      throw new LedgerError(
        "conflict",
        `enrollment request is ${req.status}; only pending requests may be rejected`,
      );
    }
    await tx
      .updateTable("enrollment_requests")
      .set({
        status: "rejected",
        claim_secret_hash: null,
        reviewed_by_subject: input.reviewedBySubject,
        reviewed_at: new Date(),
        reject_reason: input.reason ?? null,
      })
      .where("id", "=", req.id)
      .execute();
  });
}

export async function claimEnrollment(
  db: Kysely<Database>,
  input: { enrollmentId: string; claimSecret: string },
): Promise<ClaimResult> {
  const presented = hashSecret(input.claimSecret);
  return await db.transaction().execute(async (tx) => {
    await sweepExpiredTx(tx);
    const req = await tx
      .selectFrom("enrollment_requests")
      .selectAll()
      .where("id", "=", input.enrollmentId)
      .forUpdate()
      .executeTakeFirst();

    // Generic 'not_found' to avoid leaking whether an enrollment_id is real.
    if (!req) {
      throw new LedgerError("not_found", "enrollment request not found or no longer claimable");
    }

    // For closed rows the secret hash is null. Compare a dummy buffer first to
    // keep the timing roughly uniform across pending/closed rows; this is
    // best-effort, as the overall code path differs.
    const stored = req.claim_secret_hash ?? Buffer.alloc(presented.length);
    const ok = safeEqual(stored, presented);
    if (!ok || req.claim_secret_hash === null) {
      throw new LedgerError("not_found", "enrollment request not found or no longer claimable");
    }

    if (req.status === "rejected") {
      // Unreachable in practice (claim_secret_hash is null for rejected) but
      // kept for clarity if the schema invariant ever changes.
      return { status: "rejected", reject_reason: req.reject_reason ?? "" };
    }
    if (req.status === "pending") {
      return { status: "pending" };
    }
    if (req.status !== "approved") {
      throw new LedgerError("not_found", "enrollment request not found or no longer claimable");
    }

    // Approved: hand back the agent_id and burn the secret.
    if (req.agent_id === null) {
      throw new LedgerError("internal", "approved enrollment request missing agent_id");
    }
    await tx
      .updateTable("enrollment_requests")
      .set({
        status: "claimed",
        claim_secret_hash: null,
        claimed_at: new Date(),
      })
      .where("id", "=", req.id)
      .execute();

    return { status: "claimed", agent_id: req.agent_id };
  });
}

export async function listPendingEnrollments(
  db: Kysely<Database>,
  opts: { includeAll?: boolean; limit?: number } = {},
): Promise<EnrollmentRequest[]> {
  await sweepExpiredTx(db);
  let q = db
    .selectFrom("enrollment_requests")
    .select([
      "id",
      "oauth_subject",
      "note",
      "status",
      "agent_id",
      "reviewed_by_subject",
      "reject_reason",
      "requested_at",
      "reviewed_at",
      "claimed_at",
      "expires_at",
    ])
    .orderBy("requested_at", "asc")
    .limit(opts.limit ?? 200);
  if (!opts.includeAll) q = q.where("status", "=", "pending");
  return await q.execute();
}

export async function getEnrollment(
  db: Kysely<Database>,
  enrollmentId: string,
): Promise<EnrollmentRequest | null> {
  const r = await db
    .selectFrom("enrollment_requests")
    .select([
      "id",
      "oauth_subject",
      "note",
      "status",
      "agent_id",
      "reviewed_by_subject",
      "reject_reason",
      "requested_at",
      "reviewed_at",
      "claimed_at",
      "expires_at",
    ])
    .where("id", "=", enrollmentId)
    .executeTakeFirst();
  return r ?? null;
}

// Sweep marks past-due rows as 'expired' and burns their secrets. Idempotent;
// safe to run inline before any read or write that cares about freshness.
async function sweepExpiredTx(
  tx: Kysely<Database> | Transaction<Database>,
): Promise<void> {
  await tx
    .updateTable("enrollment_requests")
    .set({
      status: "expired",
      claim_secret_hash: null,
      // agent_id must be NULL for non-approved/claimed rows per the CHECK; if
      // an approved row expires before claim we deliberately do NOT clear
      // agent_id because the agents row already exists. Skip those here.
    })
    .where("expires_at", "<", new Date())
    .where("status", "=", "pending")
    .execute();

  // Approved-but-unclaimed past TTL: burn the secret only (status stays
  // 'approved' so the agent_id linkage is preserved for audit, but no further
  // claim is possible).
  await tx
    .updateTable("enrollment_requests")
    .set({ claim_secret_hash: null })
    .where("expires_at", "<", new Date())
    .where("status", "=", "approved")
    .where("claim_secret_hash", "is not", null)
    .execute();
}

export async function sweepExpired(db: Kysely<Database>): Promise<void> {
  await sweepExpiredTx(db);
}
