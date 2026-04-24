import type { Kysely } from "kysely";
import type { Database, RoleScopeKind } from "../storage/postgres/schema.js";
import { globMatches, isNamespaceWideGlob, validateGlob } from "./path.js";
import { LedgerError } from "./errors.js";

// Role-based capability enforcement.
//
// The only fixed principal is the namespace owner (recorded on
// `namespaces.owner_agent_id`); the owner has full access to every operation
// in their namespace, full stop. Everyone else — including agents holding
// `manage_roles` — gets capabilities via roles.
//
// Role membership has two flavours:
//   * direct      role_members.agent_id = <agent uuid>
//   * wildcard    role_members.agent_id = '*'  (every authenticated agent)
//
// Role capabilities have three scope kinds:
//   * read         path_glob match against requested path
//   * invoke       transition_name match against requested transition
//   * manage_roles meta-cap; gates the role.* control-plane tools and is
//                  the seed for the no-escalation rule below.
//
// No-escalation rule (assertCapsSubset):
//   An agent holding `manage_roles` may only grant capabilities that are
//   already covered by a role they themselves hold. This prevents privilege
//   creep: a delegated role-administrator cannot bootstrap their way into
//   reading/invoking things their grantor never permitted.

export interface ResolvedRole {
  id: string;
  name: string;
}

export interface RoleCapability {
  scope_kind: RoleScopeKind;
  path_glob: string | null;
  transition_name: string | null;
}

// ---------- Namespace gates ----------

export async function requireNamespaceExists(
  db: Kysely<Database>,
  namespaceId: string,
): Promise<{ ownerAgentId: string; tombstoned: boolean }> {
  const ns = await db
    .selectFrom("namespaces")
    .select(["owner_agent_id", "tombstoned_at"])
    .where("id", "=", namespaceId)
    .executeTakeFirst();
  if (!ns) {
    throw new LedgerError("not_found", `namespace ${namespaceId} not found`);
  }
  return { ownerAgentId: ns.owner_agent_id, tombstoned: ns.tombstoned_at !== null };
}

async function isOwner(
  db: Kysely<Database>,
  namespaceId: string,
  agentId: string,
): Promise<boolean> {
  const ns = await db
    .selectFrom("namespaces")
    .select("owner_agent_id")
    .where("id", "=", namespaceId)
    .executeTakeFirst();
  return ns?.owner_agent_id === agentId;
}

export async function requireOwner(
  db: Kysely<Database>,
  namespaceId: string,
  agentId: string,
): Promise<void> {
  if (!(await isOwner(db, namespaceId, agentId))) {
    throw new LedgerError("forbidden", "namespace owner required", {
      namespace_id: namespaceId,
    });
  }
}

// ---------- Role resolution ----------

/**
 * Returns the ids of all roles the agent holds in the namespace. Includes
 * direct grants AND wildcard ('*') memberships. Owner is NOT included — owner
 * is treated separately by every gate function so it can never be locked out.
 */
export async function resolveRoles(
  db: Kysely<Database>,
  namespaceId: string,
  agentId: string,
): Promise<ResolvedRole[]> {
  const rows = await db
    .selectFrom("role_members as rm")
    .innerJoin("roles as r", "r.id", "rm.role_id")
    .select(["r.id as id", "r.name as name"])
    .where("r.namespace_id", "=", namespaceId)
    .where((eb) => eb.or([eb("rm.agent_id", "=", agentId), eb("rm.agent_id", "=", "*")]))
    .execute();
  // Deduplicate (agent could hold a role both directly and via wildcard).
  const seen = new Set<string>();
  const out: ResolvedRole[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ id: r.id, name: r.name });
  }
  return out;
}

/**
 * Load the full capability set held by an agent (across every role they hold).
 * Owner is materialised as a virtual "*"-everything bundle so callers can use
 * a single decision path.
 */
export async function loadAgentCapabilities(
  db: Kysely<Database>,
  namespaceId: string,
  agentId: string,
): Promise<RoleCapability[]> {
  if (await isOwner(db, namespaceId, agentId)) {
    // Owner sees everything; we synthesise the maximal capability set so that
    // assertCapsSubset() works uniformly.
    return [
      { scope_kind: "read", path_glob: "**", transition_name: null },
      { scope_kind: "invoke", path_glob: null, transition_name: "*" },
      { scope_kind: "manage_roles", path_glob: null, transition_name: null },
    ];
  }
  const roles = await resolveRoles(db, namespaceId, agentId);
  if (roles.length === 0) return [];
  const rows = await db
    .selectFrom("role_capabilities")
    .select(["scope_kind", "path_glob", "transition_name"])
    .where(
      "role_id",
      "in",
      roles.map((r) => r.id),
    )
    .execute();
  return rows.map((r) => ({
    scope_kind: r.scope_kind,
    path_glob: r.path_glob,
    transition_name: r.transition_name,
  }));
}

// ---------- Read / invoke gates ----------

export async function canRead(
  db: Kysely<Database>,
  namespaceId: string,
  agentId: string,
  path: string,
): Promise<boolean> {
  if (await isOwner(db, namespaceId, agentId)) return true;
  const roles = await resolveRoles(db, namespaceId, agentId);
  if (roles.length === 0) return false;
  const caps = await db
    .selectFrom("role_capabilities")
    .select("path_glob")
    .where(
      "role_id",
      "in",
      roles.map((r) => r.id),
    )
    .where("scope_kind", "=", "read")
    .execute();
  return caps.some((c) => c.path_glob !== null && globMatches(c.path_glob, path));
}

export async function requireRead(
  db: Kysely<Database>,
  namespaceId: string,
  agentId: string,
  path: string,
): Promise<void> {
  if (!(await canRead(db, namespaceId, agentId, path))) {
    throw new LedgerError("capability_missing", "read capability missing for path", {
      namespace_id: namespaceId,
      path,
    });
  }
}

export async function canInvoke(
  db: Kysely<Database>,
  namespaceId: string,
  agentId: string,
  transitionName: string,
): Promise<boolean> {
  if (await isOwner(db, namespaceId, agentId)) return true;
  const roles = await resolveRoles(db, namespaceId, agentId);
  if (roles.length === 0) return false;
  const row = await db
    .selectFrom("role_capabilities")
    .select("transition_name")
    .where(
      "role_id",
      "in",
      roles.map((r) => r.id),
    )
    .where("scope_kind", "=", "invoke")
    .where((eb) => eb.or([eb("transition_name", "=", transitionName), eb("transition_name", "=", "*")]))
    .executeTakeFirst();
  return Boolean(row);
}

export async function requireInvoke(
  db: Kysely<Database>,
  namespaceId: string,
  agentId: string,
  transitionName: string,
): Promise<void> {
  if (!(await canInvoke(db, namespaceId, agentId, transitionName))) {
    throw new LedgerError("capability_missing", "invoke capability missing for transition", {
      namespace_id: namespaceId,
      transition_name: transitionName,
    });
  }
}

/**
 * Gate `tx.invoke` by the transition's declared `required_role`.
 *   - required_role = null     → owner-only
 *   - required_role = "<name>" → caller must hold a role with that name in the
 *                                same namespace, OR be the namespace owner.
 *
 * This is a coarser check than the per-capability `requireInvoke`: a role can
 * be set as `required_role` without any explicit `invoke` capability rows on
 * it. Calling `tx.invoke` is the contract — agents discover what role they
 * need by reading `transition.get`.
 */
export async function requireCanInvokeAsRequiredRole(
  db: Kysely<Database>,
  namespaceId: string,
  agentId: string,
  transitionName: string,
  requiredRole: string | null,
): Promise<void> {
  if (await isOwner(db, namespaceId, agentId)) return;
  if (requiredRole === null) {
    throw new LedgerError("capability_missing",
      "transition requires the namespace owner", {
        namespace_id: namespaceId,
        transition_name: transitionName,
      });
  }
  const roles = await resolveRoles(db, namespaceId, agentId);
  if (!roles.some((r) => r.name === requiredRole)) {
    throw new LedgerError("capability_missing",
      `caller does not hold required role '${requiredRole}'`, {
        namespace_id: namespaceId,
        transition_name: transitionName,
        required_role: requiredRole,
      });
  }
}

// ---------- manage_roles gate ----------

export async function hasManageRoles(
  db: Kysely<Database>,
  namespaceId: string,
  agentId: string,
): Promise<boolean> {
  if (await isOwner(db, namespaceId, agentId)) return true;
  const roles = await resolveRoles(db, namespaceId, agentId);
  if (roles.length === 0) return false;
  const row = await db
    .selectFrom("role_capabilities")
    .select("scope_kind")
    .where(
      "role_id",
      "in",
      roles.map((r) => r.id),
    )
    .where("scope_kind", "=", "manage_roles")
    .executeTakeFirst();
  return Boolean(row);
}

export async function requireManageRoles(
  db: Kysely<Database>,
  namespaceId: string,
  agentId: string,
): Promise<void> {
  if (!(await hasManageRoles(db, namespaceId, agentId))) {
    throw new LedgerError("forbidden", "manage_roles capability required", {
      namespace_id: namespaceId,
    });
  }
}

// ---------- No-escalation enforcement ----------

/**
 * Validate a single capability shape (used at role-definition time).
 *   read  → path_glob set; invoke → transition_name set; manage_roles → both null.
 * Also enforces the I33 grantability rule: namespace-wide read globs are not
 * grantable through normal roles.
 */
export function validateRoleCapability(c: RoleCapability): void {
  switch (c.scope_kind) {
    case "read":
      if (!c.path_glob || c.transition_name) {
        throw new LedgerError("invalid_params", "read capability requires path_glob only");
      }
      validateGlob(c.path_glob);
      if (isNamespaceWideGlob(c.path_glob)) {
        throw new LedgerError("forbidden", "namespace-wide read globs are not grantable", {
          glob: c.path_glob,
        });
      }
      break;
    case "invoke":
      if (!c.transition_name || c.path_glob) {
        throw new LedgerError("invalid_params", "invoke capability requires transition_name only");
      }
      // '*' is permitted (matches any transition). Otherwise enforce the
      // standard transition-name grammar.
      if (c.transition_name !== "*" && !/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(c.transition_name)) {
        throw new LedgerError("invalid_params",
          "transition_name must be '*' or match /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/");
      }
      break;
    case "manage_roles":
      if (c.path_glob || c.transition_name) {
        throw new LedgerError("invalid_params", "manage_roles capability has no scope arguments");
      }
      break;
  }
}

/**
 * No-escalation: every capability in `requested` must be subsumed by some
 * capability the grantor already holds. "Subsumed" means same scope_kind plus:
 *   read         grantor.path_glob is namespace-wide-or-superset OR equal to requested
 *   invoke       grantor.transition_name = '*' or equal to requested
 *   manage_roles grantor holds manage_roles
 *
 * We deliberately don't try to do glob-implication algebra beyond exact-match
 * and `**`/`*`-prefix subset checks — anything more is a recipe for subtle
 * privilege leaks. Holders can grant exactly the globs they hold (or sub-globs
 * computable trivially).
 */
export function assertCapsSubset(
  grantor: RoleCapability[],
  requested: RoleCapability[],
): void {
  for (const r of requested) {
    if (!grantorCovers(grantor, r)) {
      throw new LedgerError("forbidden",
        `escalation refused: caller does not hold capability ` +
        describeCap(r), { capability: r as unknown as Record<string, unknown> });
    }
  }
}

function describeCap(c: RoleCapability): string {
  switch (c.scope_kind) {
    case "read":         return `read:${c.path_glob}`;
    case "invoke":       return `invoke:${c.transition_name}`;
    case "manage_roles": return "manage_roles";
  }
}

function grantorCovers(grantor: RoleCapability[], req: RoleCapability): boolean {
  return grantor.some((g) => capCovers(g, req));
}

function capCovers(g: RoleCapability, r: RoleCapability): boolean {
  if (g.scope_kind !== r.scope_kind) return false;
  switch (g.scope_kind) {
    case "manage_roles":
      return true;
    case "invoke": {
      if (g.transition_name === "*") return true;
      return g.transition_name !== null && g.transition_name === r.transition_name;
    }
    case "read": {
      if (!g.path_glob || !r.path_glob) return false;
      // Exact glob match always covers.
      if (g.path_glob === r.path_glob) return true;
      // Owner-synthesised "**" covers everything.
      if (g.path_glob === "**") return true;
      // "<prefix>/**" covers itself, "<prefix>/...", and globs strictly under <prefix>/.
      if (g.path_glob.endsWith("/**")) {
        const prefix = g.path_glob.slice(0, -3);
        if (r.path_glob === `${prefix}/**`) return true;
        if (r.path_glob.startsWith(`${prefix}/`)) return true;
      }
      return false;
    }
  }
}

// ---------- Re-exported helper for legacy import sites ----------

export function assertGrantableReadGlob(glob: string): void {
  validateGlob(glob);
  if (isNamespaceWideGlob(glob)) {
    throw new LedgerError("forbidden", "namespace-wide read globs are not grantable", {
      glob,
    });
  }
}
