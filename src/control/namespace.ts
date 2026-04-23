import type { Kysely } from "kysely";
import type { Database } from "../storage/postgres/schema.js";
import { LedgerError } from "../core/errors.js";
import { appendAudit } from "../core/audit.js";

// Namespace lifecycle. Ownership is immutable after creation (I1). Tombstone
// soft-deletes; the row stays for audit correlation.

const ALIAS_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export interface Namespace {
  id: string;
  owner_agent_id: string;
  alias: string | null;
  created_at: Date;
  tombstoned_at: Date | null;
}

export async function createNamespace(
  db: Kysely<Database>,
  input: { ownerAgentId: string; alias?: string | null; requestId: string },
): Promise<Namespace> {
  if (input.alias !== undefined && input.alias !== null && !ALIAS_RE.test(input.alias)) {
    throw new LedgerError("invalid_params",
      "alias must match /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/");
  }
  return await db.transaction().execute(async (tx) => {
    const row = await tx
      .insertInto("namespaces")
      .values({ owner_agent_id: input.ownerAgentId, alias: input.alias ?? null })
      .returningAll()
      .executeTakeFirstOrThrow();
    await appendAudit(tx, {
      namespaceId: row.id,
      actorAgentId: input.ownerAgentId,
      requestId: input.requestId,
      plane: "control",
      kind: "namespace.create",
      payload: { alias: row.alias },
    });
    return row;
  });
}

export async function listNamespacesForAgent(
  db: Kysely<Database>,
  agentId: string,
): Promise<Namespace[]> {
  // Owner + admin — everything the agent can administer.
  return await db
    .selectFrom("namespaces")
    .selectAll()
    .where((eb) =>
      eb.or([
        eb("owner_agent_id", "=", agentId),
        eb("id", "in", eb.selectFrom("admins").select("namespace_id").where("agent_id", "=", agentId)),
      ]),
    )
    .orderBy("created_at", "asc")
    .execute();
}

export async function tombstoneNamespace(
  db: Kysely<Database>,
  input: { namespaceId: string; actorAgentId: string; requestId: string },
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    const r = await tx
      .updateTable("namespaces")
      .set({ tombstoned_at: new Date() })
      .where("id", "=", input.namespaceId)
      .where("tombstoned_at", "is", null)
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) === 0) {
      throw new LedgerError("not_found", "namespace not found or already tombstoned");
    }
    await appendAudit(tx, {
      namespaceId: input.namespaceId,
      actorAgentId: input.actorAgentId,
      requestId: input.requestId,
      plane: "control",
      kind: "namespace.tombstone",
      payload: {},
    });
  });
}
