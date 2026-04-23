import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../storage/postgres/schema.js";
import { LedgerError } from "./errors.js";
import { validatePath } from "./path.js";

// `lock` — fenced exclusion lease. Safety properties (ARCHITECTURE.md I15–I18):
//   - Every successful acquire issues a fresh fence from a monotonic sequence.
//   - TTL arithmetic is entirely server-side via now().
//   - TTL bounded [1s, 1h].
//   - Single-statement acquire/takeover via INSERT ... ON CONFLICT DO UPDATE
//     WHERE expires_at < now(), issuing a NEW fence on takeover. Postgres
//     row locks serialize concurrent acquires.

export const LOCK_TTL_MIN_MS = 1000;
export const LOCK_TTL_MAX_MS = 60 * 60 * 1000;

export interface LockRow {
  namespace_id: string;
  path: string;
  owner_agent_id: string;
  fence: string; // bigint
  expires_at: Date;
  acquired_at: Date;
}

export async function lockInspect(
  db: Kysely<Database>,
  namespaceId: string,
  path: string,
): Promise<LockRow | null> {
  validatePath(path);
  const r = await db
    .selectFrom("locks")
    .selectAll()
    .where("namespace_id", "=", namespaceId)
    .where("path", "=", path)
    .executeTakeFirst();
  if (!r) return null;
  return {
    namespace_id: r.namespace_id,
    path: r.path,
    owner_agent_id: r.owner_agent_id,
    fence: r.fence,
    expires_at: r.expires_at,
    acquired_at: r.acquired_at,
  };
}

function checkTtl(ttlMs: number): void {
  if (!Number.isInteger(ttlMs) || ttlMs < LOCK_TTL_MIN_MS || ttlMs > LOCK_TTL_MAX_MS) {
    throw new LedgerError("bounds_violation",
      `ttl_ms must be an integer in [${LOCK_TTL_MIN_MS}, ${LOCK_TTL_MAX_MS}]`);
  }
}

// --- Mutations inside an active tx --------------------------------------

export async function lockAcquire(
  tx: Kysely<Database>,
  namespaceId: string,
  path: string,
  ownerAgentId: string,
  ttlMs: number,
): Promise<{ fence: bigint; expires_at: Date }> {
  validatePath(path);
  checkTtl(ttlMs);

  // Single statement: INSERT on fresh, or UPDATE iff the existing row is
  // expired. On conflict with an unexpired row, RETURNING emits no rows.
  const res = await sql<{ fence: string; expires_at: Date } | undefined>`
    INSERT INTO locks (namespace_id, path, owner_agent_id, fence, expires_at, acquired_at)
    VALUES (
      ${namespaceId}, ${path}, ${ownerAgentId},
      nextval('lock_fence_seq'),
      now() + (${ttlMs}::bigint * interval '1 ms'),
      now()
    )
    ON CONFLICT (namespace_id, path) DO UPDATE
      SET owner_agent_id = EXCLUDED.owner_agent_id,
          fence          = nextval('lock_fence_seq'),
          expires_at     = EXCLUDED.expires_at,
          acquired_at    = now()
      WHERE locks.expires_at < now()
    RETURNING fence, expires_at
  `.execute(tx);

  const row = res.rows[0];
  if (!row) {
    throw new LedgerError("lock_held", "lock held by another agent", {
      namespace_id: namespaceId,
      path,
    });
  }
  return { fence: BigInt(row.fence), expires_at: row.expires_at };
}

export async function lockRefresh(
  tx: Kysely<Database>,
  namespaceId: string,
  path: string,
  ownerAgentId: string,
  fence: bigint,
  ttlMs: number,
): Promise<{ expires_at: Date }> {
  validatePath(path);
  checkTtl(ttlMs);

  const res = await sql<{ expires_at: Date } | undefined>`
    UPDATE locks
    SET expires_at = now() + (${ttlMs}::bigint * interval '1 ms')
    WHERE namespace_id = ${namespaceId}
      AND path = ${path}
      AND owner_agent_id = ${ownerAgentId}
      AND fence = ${fence.toString()}::bigint
      AND expires_at > now()
    RETURNING expires_at
  `.execute(tx);

  const row = res.rows[0];
  if (!row) {
    throw new LedgerError("lock_fence_mismatch",
      "lock not held by caller at the given fence (or expired)", {
        namespace_id: namespaceId,
        path,
        fence: fence.toString(),
      });
  }
  return { expires_at: row.expires_at };
}

export async function lockRelease(
  tx: Kysely<Database>,
  namespaceId: string,
  path: string,
  ownerAgentId: string,
  fence: bigint,
): Promise<void> {
  validatePath(path);
  const res = await tx
    .deleteFrom("locks")
    .where("namespace_id", "=", namespaceId)
    .where("path", "=", path)
    .where("owner_agent_id", "=", ownerAgentId)
    .where("fence", "=", fence.toString())
    .executeTakeFirst();
  if (Number(res.numDeletedRows) === 0) {
    throw new LedgerError("lock_fence_mismatch", "lock not held by caller at the given fence", {
      namespace_id: namespaceId,
      path,
      fence: fence.toString(),
    });
  }
}

// Assert that a given fence currently holds the lock. Used by transition
// assert grammar `lock.fence_matches`.
export async function assertLockFence(
  tx: Kysely<Database>,
  namespaceId: string,
  path: string,
  fence: bigint,
): Promise<void> {
  const r = await tx
    .selectFrom("locks")
    .select(["fence", "expires_at"])
    .where("namespace_id", "=", namespaceId)
    .where("path", "=", path)
    .executeTakeFirst();
  if (!r) {
    throw new LedgerError("lock_fence_mismatch", "lock not held", { path });
  }
  if ((r.expires_at) <= new Date()) {
    throw new LedgerError("lock_fence_mismatch", "lock expired", { path });
  }
  if (BigInt(r.fence) !== fence) {
    throw new LedgerError("lock_fence_mismatch", "lock fence mismatch", {
      path,
      expected: fence.toString(),
      actual: r.fence,
    });
  }
}
