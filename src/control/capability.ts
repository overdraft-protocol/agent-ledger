import type { Kysely } from "kysely";
import type { Database } from "../storage/postgres/schema.js";
import { LedgerError } from "../core/errors.js";
import { appendAudit } from "../core/audit.js";
import {
  assertGrantableReadGlob,
  requireAdmin,
} from "../core/capabilities.js";

// Capability grants. Admins (and owners) can grant/revoke.
// Read grants must not be namespace-wide (I33). Invoke grants target one
// transition name.

export interface CapabilityRow {
  id: string;
  namespace_id: string;
  agent_id: string;
  scope_kind: "read" | "invoke";
  path_glob: string | null;
  transition_name: string | null;
  granted_by: string;
  granted_at: Date;
  expires_at: Date | null;
}

const TRANSITION_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;

async function ensureGrantee(
  db: Kysely<Database>,
  agentId: string,
): Promise<void> {
  const agent = await db
    .selectFrom("agents")
    .select(["id", "disabled_at"])
    .where("id", "=", agentId)
    .executeTakeFirst();
  if (!agent) {
    throw new LedgerError("not_found", "agent not found");
  }
  if (agent.disabled_at !== null) {
    throw new LedgerError("forbidden", "agent is disabled");
  }
}

export async function grantReadCapability(
  db: Kysely<Database>,
  input: {
    namespaceId: string;
    agentId: string;
    pathGlob: string;
    grantedBy: string;
    expiresAt?: Date;
    requestId: string;
  },
): Promise<CapabilityRow> {
  await requireAdmin(db, input.namespaceId, input.grantedBy);
  await ensureGrantee(db, input.agentId);
  assertGrantableReadGlob(input.pathGlob);
  if (input.expiresAt !== undefined && input.expiresAt <= new Date()) {
    throw new LedgerError("invalid_params", "expires_at must be in the future");
  }

  return await db.transaction().execute(async (tx) => {
    const row = await tx
      .insertInto("capabilities")
      .values({
        namespace_id: input.namespaceId,
        agent_id: input.agentId,
        scope_kind: "read",
        path_glob: input.pathGlob,
        transition_name: null,
        granted_by: input.grantedBy,
        expires_at: input.expiresAt ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await appendAudit(tx, {
      namespaceId: input.namespaceId,
      actorAgentId: input.grantedBy,
      requestId: input.requestId,
      plane: "control",
      kind: "capability.grant.read",
      payload: {
        capability_id: row.id,
        agent_id: input.agentId,
        path_glob: input.pathGlob,
        expires_at: input.expiresAt ? input.expiresAt.toISOString() : null,
      },
    });

    return mapRow(row);
  });
}

export async function grantInvokeCapability(
  db: Kysely<Database>,
  input: {
    namespaceId: string;
    agentId: string;
    transitionName: string;
    grantedBy: string;
    expiresAt?: Date;
    requestId: string;
  },
): Promise<CapabilityRow> {
  await requireAdmin(db, input.namespaceId, input.grantedBy);
  await ensureGrantee(db, input.agentId);
  if (!TRANSITION_NAME_RE.test(input.transitionName)) {
    throw new LedgerError("invalid_params",
      "transition_name must match /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/");
  }
  if (input.expiresAt !== undefined && input.expiresAt <= new Date()) {
    throw new LedgerError("invalid_params", "expires_at must be in the future");
  }

  return await db.transaction().execute(async (tx) => {
    const row = await tx
      .insertInto("capabilities")
      .values({
        namespace_id: input.namespaceId,
        agent_id: input.agentId,
        scope_kind: "invoke",
        path_glob: null,
        transition_name: input.transitionName,
        granted_by: input.grantedBy,
        expires_at: input.expiresAt ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await appendAudit(tx, {
      namespaceId: input.namespaceId,
      actorAgentId: input.grantedBy,
      requestId: input.requestId,
      plane: "control",
      kind: "capability.grant.invoke",
      payload: {
        capability_id: row.id,
        agent_id: input.agentId,
        transition_name: input.transitionName,
        expires_at: input.expiresAt ? input.expiresAt.toISOString() : null,
      },
    });

    return mapRow(row);
  });
}

export async function revokeCapability(
  db: Kysely<Database>,
  input: {
    namespaceId: string;
    capabilityId: string;
    revokedBy: string;
    requestId: string;
  },
): Promise<void> {
  await requireAdmin(db, input.namespaceId, input.revokedBy);
  await db.transaction().execute(async (tx) => {
    const existing = await tx
      .selectFrom("capabilities")
      .select(["id", "namespace_id", "agent_id", "scope_kind"])
      .where("id", "=", input.capabilityId)
      .executeTakeFirst();
    if (!existing || existing.namespace_id !== input.namespaceId) {
      throw new LedgerError("not_found", "capability not found in namespace");
    }
    await tx
      .deleteFrom("capabilities")
      .where("id", "=", input.capabilityId)
      .execute();
    await appendAudit(tx, {
      namespaceId: input.namespaceId,
      actorAgentId: input.revokedBy,
      requestId: input.requestId,
      plane: "control",
      kind: "capability.revoke",
      payload: {
        capability_id: existing.id,
        agent_id: existing.agent_id,
        scope_kind: existing.scope_kind,
      },
    });
  });
}

export async function listCapabilities(
  db: Kysely<Database>,
  namespaceId: string,
  filter?: { agentId?: string },
): Promise<CapabilityRow[]> {
  let q = db
    .selectFrom("capabilities")
    .selectAll()
    .where("namespace_id", "=", namespaceId);
  if (filter?.agentId !== undefined) {
    q = q.where("agent_id", "=", filter.agentId);
  }
  const rows = await q.orderBy("granted_at", "asc").execute();
  return rows.map(mapRow);
}

function mapRow(r: {
  id: string;
  namespace_id: string;
  agent_id: string;
  scope_kind: "read" | "invoke";
  path_glob: string | null;
  transition_name: string | null;
  granted_by: string;
  granted_at: Date;
  expires_at: Date | null;
}): CapabilityRow {
  return {
    id: r.id,
    namespace_id: r.namespace_id,
    agent_id: r.agent_id,
    scope_kind: r.scope_kind,
    path_glob: r.path_glob,
    transition_name: r.transition_name,
    granted_by: r.granted_by,
    granted_at: r.granted_at,
    expires_at: r.expires_at,
  };
}
