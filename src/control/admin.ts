import type { Kysely } from "kysely";
import type { Database } from "../storage/postgres/schema.js";
import { LedgerError } from "../core/errors.js";
import { appendAudit } from "../core/audit.js";
import { requireOwner } from "../core/capabilities.js";

// Admin roster. Only the namespace owner can mutate this (Tier 0 → Tier 1
// promotion). Admins cannot grant further admins; keeping the set owner-only
// prevents privilege-creep via a single compromised admin.

export interface AdminRow {
  namespace_id: string;
  agent_id: string;
  granted_by: string;
  granted_at: Date;
}

export async function grantAdmin(
  db: Kysely<Database>,
  input: {
    namespaceId: string;
    agentId: string;
    grantedBy: string;
    requestId: string;
  },
): Promise<void> {
  await requireOwner(db, input.namespaceId, input.grantedBy);
  if (input.agentId === input.grantedBy) {
    throw new LedgerError("invalid_params", "owner is already implicitly admin");
  }
  await db.transaction().execute(async (tx) => {
    const exists = await tx
      .selectFrom("admins")
      .select("agent_id")
      .where("namespace_id", "=", input.namespaceId)
      .where("agent_id", "=", input.agentId)
      .executeTakeFirst();
    if (exists) {
      throw new LedgerError("conflict", "agent is already an admin of this namespace");
    }
    // Ensure agent row exists (same FK surface as capabilities).
    const agent = await tx
      .selectFrom("agents")
      .select(["id", "disabled_at"])
      .where("id", "=", input.agentId)
      .executeTakeFirst();
    if (!agent) {
      throw new LedgerError("not_found", "agent not found");
    }
    if (agent.disabled_at !== null) {
      throw new LedgerError("forbidden", "agent is disabled");
    }

    await tx
      .insertInto("admins")
      .values({
        namespace_id: input.namespaceId,
        agent_id: input.agentId,
        granted_by: input.grantedBy,
      })
      .execute();

    await appendAudit(tx, {
      namespaceId: input.namespaceId,
      actorAgentId: input.grantedBy,
      requestId: input.requestId,
      plane: "control",
      kind: "admin.grant",
      payload: { agent_id: input.agentId },
    });
  });
}

export async function revokeAdmin(
  db: Kysely<Database>,
  input: {
    namespaceId: string;
    agentId: string;
    revokedBy: string;
    requestId: string;
  },
): Promise<void> {
  await requireOwner(db, input.namespaceId, input.revokedBy);
  await db.transaction().execute(async (tx) => {
    const res = await tx
      .deleteFrom("admins")
      .where("namespace_id", "=", input.namespaceId)
      .where("agent_id", "=", input.agentId)
      .executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) {
      throw new LedgerError("not_found", "agent is not an admin of this namespace");
    }
    await appendAudit(tx, {
      namespaceId: input.namespaceId,
      actorAgentId: input.revokedBy,
      requestId: input.requestId,
      plane: "control",
      kind: "admin.revoke",
      payload: { agent_id: input.agentId },
    });
  });
}

export async function listAdmins(
  db: Kysely<Database>,
  namespaceId: string,
): Promise<AdminRow[]> {
  const rows = await db
    .selectFrom("admins")
    .selectAll()
    .where("namespace_id", "=", namespaceId)
    .orderBy("granted_at", "asc")
    .execute();
  return rows.map((r) => ({
    namespace_id: r.namespace_id,
    agent_id: r.agent_id,
    granted_by: r.granted_by,
    granted_at: r.granted_at,
  }));
}
