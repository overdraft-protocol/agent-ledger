import type { Kysely } from "kysely";
import type { Database, RoleScopeKind } from "../storage/postgres/schema.js";
import { LedgerError } from "../core/errors.js";
import { appendAudit } from "../core/audit.js";
import {
  assertCapsSubset,
  loadAgentCapabilities,
  requireManageRoles,
  requireNamespaceExists,
  validateRoleCapability,
  type RoleCapability,
} from "../core/capabilities.js";

// Role lifecycle. All mutations require the caller to hold `manage_roles`
// (or be the namespace owner). Capability grants are bounded by the
// no-escalation rule in core/capabilities.ts: holders may only grant
// capabilities they themselves currently hold.
//
// Roles are namespace-scoped. Role names follow the same grammar as
// transition names so they're safe to use in `required_role` references and
// in audit payloads.

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;
const MAX_DESCRIPTION_BYTES = 4096;

export interface RoleSummary {
  id: string;
  name: string;
  description: string;
  created_at: Date;
  created_by: string;
}

export interface RoleDetail extends RoleSummary {
  capabilities: RoleCapability[];
}

export interface RoleMember {
  agent_id: string; // uuid or '*'
  granted_by: string;
  granted_at: Date;
}

// ---------- helpers ----------

function validateName(name: string): void {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new LedgerError("invalid_params",
      "role name must match /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/");
  }
}

function validateDescription(d: string): void {
  if (typeof d !== "string") {
    throw new LedgerError("invalid_params", "role description must be a string");
  }
  if (Buffer.byteLength(d, "utf8") > MAX_DESCRIPTION_BYTES) {
    throw new LedgerError("invalid_params",
      `role description exceeds ${MAX_DESCRIPTION_BYTES} bytes`);
  }
}

function validateCaps(caps: RoleCapability[]): void {
  if (!Array.isArray(caps)) {
    throw new LedgerError("invalid_params", "capabilities must be an array");
  }
  for (const c of caps) {
    validateRoleCapability(c);
  }
}

async function loadRole(
  db: Kysely<Database>,
  namespaceId: string,
  name: string,
): Promise<{ id: string; name: string; description: string; created_at: Date; created_by: string } | null> {
  const r = await db
    .selectFrom("roles")
    .select(["id", "name", "description", "created_at", "created_by"])
    .where("namespace_id", "=", namespaceId)
    .where("name", "=", name)
    .executeTakeFirst();
  return r ?? null;
}

async function loadRoleCapabilities(
  db: Kysely<Database>,
  roleId: string,
): Promise<RoleCapability[]> {
  const rows = await db
    .selectFrom("role_capabilities")
    .select(["scope_kind", "path_glob", "transition_name"])
    .where("role_id", "=", roleId)
    .execute();
  return rows.map((r) => ({
    scope_kind: r.scope_kind as RoleScopeKind,
    path_glob: r.path_glob,
    transition_name: r.transition_name,
  }));
}

// ---------- CRUD ----------

export async function createRole(
  db: Kysely<Database>,
  input: {
    namespaceId: string;
    actorAgentId: string;
    requestId: string;
    name: string;
    description: string;
    capabilities: RoleCapability[];
  },
): Promise<RoleSummary> {
  await requireNamespaceExists(db, input.namespaceId);
  await requireManageRoles(db, input.namespaceId, input.actorAgentId);
  validateName(input.name);
  validateDescription(input.description);
  validateCaps(input.capabilities);

  // No-escalation: actor must already hold each requested capability.
  const grantorCaps = await loadAgentCapabilities(db, input.namespaceId, input.actorAgentId);
  assertCapsSubset(grantorCaps, input.capabilities);

  return await db.transaction().execute(async (tx) => {
    const existing = await tx
      .selectFrom("roles")
      .select("id")
      .where("namespace_id", "=", input.namespaceId)
      .where("name", "=", input.name)
      .executeTakeFirst();
    if (existing) {
      throw new LedgerError("conflict", `role '${input.name}' already exists`);
    }
    const row = await tx
      .insertInto("roles")
      .values({
        namespace_id: input.namespaceId,
        name: input.name,
        description: input.description,
        created_by: input.actorAgentId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    if (input.capabilities.length > 0) {
      await tx
        .insertInto("role_capabilities")
        .values(input.capabilities.map((c) => ({
          role_id: row.id,
          scope_kind: c.scope_kind,
          path_glob: c.path_glob,
          transition_name: c.transition_name,
        })))
        .execute();
    }

    await appendAudit(tx, {
      namespaceId: input.namespaceId,
      actorAgentId: input.actorAgentId,
      requestId: input.requestId,
      plane: "control",
      kind: "role.create",
      payload: {
        role_id: row.id,
        name: input.name,
        capability_count: input.capabilities.length,
      },
    });

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      created_at: row.created_at,
      created_by: row.created_by,
    };
  });
}

export async function updateRole(
  db: Kysely<Database>,
  input: {
    namespaceId: string;
    actorAgentId: string;
    requestId: string;
    name: string;
    description?: string;
    capabilities?: RoleCapability[];
  },
): Promise<RoleSummary> {
  await requireNamespaceExists(db, input.namespaceId);
  await requireManageRoles(db, input.namespaceId, input.actorAgentId);
  validateName(input.name);
  if (input.description !== undefined) validateDescription(input.description);
  if (input.capabilities !== undefined) {
    validateCaps(input.capabilities);
    const grantorCaps = await loadAgentCapabilities(db, input.namespaceId, input.actorAgentId);
    assertCapsSubset(grantorCaps, input.capabilities);
  }

  return await db.transaction().execute(async (tx) => {
    const role = await tx
      .selectFrom("roles")
      .select(["id", "name", "description", "created_at", "created_by"])
      .where("namespace_id", "=", input.namespaceId)
      .where("name", "=", input.name)
      .executeTakeFirst();
    if (!role) {
      throw new LedgerError("not_found", `role '${input.name}' not found`);
    }

    if (input.description !== undefined && input.description !== role.description) {
      await tx
        .updateTable("roles")
        .set({ description: input.description })
        .where("id", "=", role.id)
        .execute();
    }

    if (input.capabilities !== undefined) {
      await tx
        .deleteFrom("role_capabilities")
        .where("role_id", "=", role.id)
        .execute();
      if (input.capabilities.length > 0) {
        await tx
          .insertInto("role_capabilities")
          .values(input.capabilities.map((c) => ({
            role_id: role.id,
            scope_kind: c.scope_kind,
            path_glob: c.path_glob,
            transition_name: c.transition_name,
          })))
          .execute();
      }
    }

    await appendAudit(tx, {
      namespaceId: input.namespaceId,
      actorAgentId: input.actorAgentId,
      requestId: input.requestId,
      plane: "control",
      kind: "role.update",
      payload: {
        role_id: role.id,
        name: role.name,
        description_changed: input.description !== undefined,
        capabilities_changed: input.capabilities !== undefined,
      },
    });

    return {
      id: role.id,
      name: role.name,
      description: input.description ?? role.description,
      created_at: role.created_at,
      created_by: role.created_by,
    };
  });
}

export async function deleteRole(
  db: Kysely<Database>,
  input: {
    namespaceId: string;
    actorAgentId: string;
    requestId: string;
    name: string;
  },
): Promise<void> {
  await requireNamespaceExists(db, input.namespaceId);
  await requireManageRoles(db, input.namespaceId, input.actorAgentId);
  validateName(input.name);

  await db.transaction().execute(async (tx) => {
    const role = await tx
      .selectFrom("roles")
      .select("id")
      .where("namespace_id", "=", input.namespaceId)
      .where("name", "=", input.name)
      .executeTakeFirst();
    if (!role) {
      throw new LedgerError("not_found", `role '${input.name}' not found`);
    }

    // Refuse to delete a role still referenced by a non-deprecated transition.
    const ref = await tx
      .selectFrom("transitions")
      .select(["name", "version"])
      .where("namespace_id", "=", input.namespaceId)
      .where("required_role", "=", input.name)
      .where("deprecated_at", "is", null)
      .executeTakeFirst();
    if (ref) {
      throw new LedgerError("conflict",
        `role '${input.name}' is required by active transition ${ref.name}@v${ref.version}`,
        { transition: ref.name, version: ref.version });
    }

    await tx
      .deleteFrom("roles")
      .where("id", "=", role.id)
      .execute();

    await appendAudit(tx, {
      namespaceId: input.namespaceId,
      actorAgentId: input.actorAgentId,
      requestId: input.requestId,
      plane: "control",
      kind: "role.delete",
      payload: { role_id: role.id, name: input.name },
    });
  });
}

export async function listRoles(
  db: Kysely<Database>,
  namespaceId: string,
): Promise<RoleSummary[]> {
  await requireNamespaceExists(db, namespaceId);
  const rows = await db
    .selectFrom("roles")
    .select(["id", "name", "description", "created_at", "created_by"])
    .where("namespace_id", "=", namespaceId)
    .orderBy("name", "asc")
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    created_at: r.created_at,
    created_by: r.created_by,
  }));
}

export async function getRole(
  db: Kysely<Database>,
  namespaceId: string,
  name: string,
): Promise<RoleDetail> {
  await requireNamespaceExists(db, namespaceId);
  validateName(name);
  const role = await loadRole(db, namespaceId, name);
  if (!role) {
    throw new LedgerError("not_found", `role '${name}' not found`);
  }
  const caps = await loadRoleCapabilities(db, role.id);
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    created_at: role.created_at,
    created_by: role.created_by,
    capabilities: caps,
  };
}

// ---------- Membership ----------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function grantRole(
  db: Kysely<Database>,
  input: {
    namespaceId: string;
    actorAgentId: string;
    requestId: string;
    role: string;
    agentId: string; // uuid or '*'
  },
): Promise<void> {
  await requireNamespaceExists(db, input.namespaceId);
  await requireManageRoles(db, input.namespaceId, input.actorAgentId);
  validateName(input.role);
  if (input.agentId !== "*" && !UUID_RE.test(input.agentId)) {
    throw new LedgerError("invalid_params", "agent_id must be a UUID or the wildcard '*'");
  }

  return await db.transaction().execute(async (tx) => {
    const role = await tx
      .selectFrom("roles")
      .select("id")
      .where("namespace_id", "=", input.namespaceId)
      .where("name", "=", input.role)
      .executeTakeFirst();
    if (!role) {
      throw new LedgerError("not_found", `role '${input.role}' not found`);
    }

    if (input.agentId !== "*") {
      const agent = await tx
        .selectFrom("agents")
        .select(["id", "disabled_at"])
        .where("id", "=", input.agentId)
        .executeTakeFirst();
      if (!agent) throw new LedgerError("not_found", "agent not found");
      if (agent.disabled_at !== null) {
        throw new LedgerError("forbidden", "agent is disabled");
      }
    }

    const exists = await tx
      .selectFrom("role_members")
      .select("agent_id")
      .where("role_id", "=", role.id)
      .where("agent_id", "=", input.agentId)
      .executeTakeFirst();
    if (exists) {
      throw new LedgerError("conflict", "agent already holds this role");
    }

    await tx
      .insertInto("role_members")
      .values({
        role_id: role.id,
        agent_id: input.agentId,
        granted_by: input.actorAgentId,
      })
      .execute();

    await appendAudit(tx, {
      namespaceId: input.namespaceId,
      actorAgentId: input.actorAgentId,
      requestId: input.requestId,
      plane: "control",
      kind: "role.grant",
      payload: { role: input.role, agent_id: input.agentId },
    });
  });
}

export async function revokeRole(
  db: Kysely<Database>,
  input: {
    namespaceId: string;
    actorAgentId: string;
    requestId: string;
    role: string;
    agentId: string;
  },
): Promise<void> {
  await requireNamespaceExists(db, input.namespaceId);
  await requireManageRoles(db, input.namespaceId, input.actorAgentId);
  validateName(input.role);

  await db.transaction().execute(async (tx) => {
    const role = await tx
      .selectFrom("roles")
      .select("id")
      .where("namespace_id", "=", input.namespaceId)
      .where("name", "=", input.role)
      .executeTakeFirst();
    if (!role) {
      throw new LedgerError("not_found", `role '${input.role}' not found`);
    }
    const res = await tx
      .deleteFrom("role_members")
      .where("role_id", "=", role.id)
      .where("agent_id", "=", input.agentId)
      .executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) {
      throw new LedgerError("not_found", "agent does not hold this role");
    }
    await appendAudit(tx, {
      namespaceId: input.namespaceId,
      actorAgentId: input.actorAgentId,
      requestId: input.requestId,
      plane: "control",
      kind: "role.revoke",
      payload: { role: input.role, agent_id: input.agentId },
    });
  });
}

export async function listRoleMembers(
  db: Kysely<Database>,
  namespaceId: string,
  role: string,
): Promise<RoleMember[]> {
  await requireNamespaceExists(db, namespaceId);
  validateName(role);
  const r = await loadRole(db, namespaceId, role);
  if (!r) throw new LedgerError("not_found", `role '${role}' not found`);
  const rows = await db
    .selectFrom("role_members")
    .select(["agent_id", "granted_by", "granted_at"])
    .where("role_id", "=", r.id)
    .orderBy("granted_at", "asc")
    .execute();
  return rows.map((x) => ({
    agent_id: x.agent_id,
    granted_by: x.granted_by,
    granted_at: x.granted_at,
  }));
}

/**
 * Convenience for an agent to introspect what roles they hold in a namespace
 * (direct + wildcard).
 */
export async function listMyRoles(
  db: Kysely<Database>,
  namespaceId: string,
  agentId: string,
): Promise<{ name: string; via: "direct" | "wildcard" }[]> {
  await requireNamespaceExists(db, namespaceId);
  const rows = await db
    .selectFrom("role_members as rm")
    .innerJoin("roles as r", "r.id", "rm.role_id")
    .select(["r.name as name", "rm.agent_id as agent_id"])
    .where("r.namespace_id", "=", namespaceId)
    .where((eb) => eb.or([eb("rm.agent_id", "=", agentId), eb("rm.agent_id", "=", "*")]))
    .execute();

  const seen = new Map<string, "direct" | "wildcard">();
  for (const r of rows) {
    const via: "direct" | "wildcard" = r.agent_id === "*" ? "wildcard" : "direct";
    const prev = seen.get(r.name);
    // Prefer 'direct' over 'wildcard' if both apply.
    if (!prev || (prev === "wildcard" && via === "direct")) seen.set(r.name, via);
  }
  return Array.from(seen.entries()).map(([name, via]) => ({ name, via }));
}
