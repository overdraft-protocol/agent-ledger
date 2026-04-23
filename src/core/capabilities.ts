import type { Kysely } from "kysely";
import type { Database } from "../storage/postgres/schema.js";
import { globMatches, isNamespaceWideGlob, validateGlob } from "./path.js";
import { LedgerError } from "./errors.js";

// Capability enforcement. Called by every read/invoke tool handler and by
// `capability.holds` asserts inside transitions.
//
// Tiering (ARCHITECTURE.md § Ownership):
//   Tier 0 owner   — implicit full access (owner column on namespaces)
//   Tier 1 admin   — implicit full read/invoke access (row in admins)
//   Tier 2 agent   — explicit capability rows

type Tier = "owner" | "admin" | "agent" | "none";

export interface TierInfo {
  tier: Tier;
  namespaceId: string;
}

export async function resolveTier(
  db: Kysely<Database>,
  namespaceId: string,
  agentId: string,
): Promise<Tier> {
  const ns = await db
    .selectFrom("namespaces")
    .select(["owner_agent_id", "tombstoned_at"])
    .where("id", "=", namespaceId)
    .executeTakeFirst();
  if (!ns) return "none";
  if (ns.owner_agent_id === agentId) return "owner";

  const admin = await db
    .selectFrom("admins")
    .select("agent_id")
    .where("namespace_id", "=", namespaceId)
    .where("agent_id", "=", agentId)
    .executeTakeFirst();
  if (admin) return "admin";

  return "agent";
}

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

// Check a read capability against a specific path.
// Owner/admin bypass; Tier 2 must hold a matching non-expired read cap.
export async function canRead(
  db: Kysely<Database>,
  namespaceId: string,
  agentId: string,
  path: string,
): Promise<boolean> {
  const tier = await resolveTier(db, namespaceId, agentId);
  if (tier === "none") return false;
  if (tier === "owner" || tier === "admin") return true;

  const caps = await db
    .selectFrom("capabilities")
    .select("path_glob")
    .where("namespace_id", "=", namespaceId)
    .where("agent_id", "=", agentId)
    .where("scope_kind", "=", "read")
    .where((eb) =>
      eb.or([eb("expires_at", "is", null), eb("expires_at", ">", new Date())]),
    )
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

// Invoke capability — can this agent invoke this transition?
export async function canInvoke(
  db: Kysely<Database>,
  namespaceId: string,
  agentId: string,
  transitionName: string,
): Promise<boolean> {
  const tier = await resolveTier(db, namespaceId, agentId);
  if (tier === "none") return false;
  if (tier === "owner" || tier === "admin") return true;

  const row = await db
    .selectFrom("capabilities")
    .select("transition_name")
    .where("namespace_id", "=", namespaceId)
    .where("agent_id", "=", agentId)
    .where("scope_kind", "=", "invoke")
    .where("transition_name", "=", transitionName)
    .where((eb) =>
      eb.or([eb("expires_at", "is", null), eb("expires_at", ">", new Date())]),
    )
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

// Admin gate for control-plane ops.
export async function requireAdmin(
  db: Kysely<Database>,
  namespaceId: string,
  agentId: string,
): Promise<void> {
  const tier = await resolveTier(db, namespaceId, agentId);
  if (tier !== "owner" && tier !== "admin") {
    throw new LedgerError("forbidden", "admin capability required", {
      namespace_id: namespaceId,
    });
  }
}

export async function requireOwner(
  db: Kysely<Database>,
  namespaceId: string,
  agentId: string,
): Promise<void> {
  const tier = await resolveTier(db, namespaceId, agentId);
  if (tier !== "owner") {
    throw new LedgerError("forbidden", "owner capability required", {
      namespace_id: namespaceId,
    });
  }
}

// Grant: admin cannot grant admin; Tier-2 caps cannot use namespace-wide globs (I33).
export function assertGrantableReadGlob(glob: string): void {
  validateGlob(glob);
  if (isNamespaceWideGlob(glob)) {
    throw new LedgerError("forbidden", "namespace-wide read globs are not grantable to Tier-2 agents", {
      glob,
    });
  }
}
