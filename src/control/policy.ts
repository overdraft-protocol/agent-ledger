import type { Kysely } from "kysely";
import type { Database, JsonValue } from "../storage/postgres/schema.js";
import { LedgerError } from "../core/errors.js";
import { appendAudit } from "../core/audit.js";
import { parsePolicyRule, type PolicyRule } from "../core/policy.js";
import { requireAdmin } from "../core/capabilities.js";

// Policy rule CRUD. Admin-only mutations. Policy evaluation lives in
// core/policy.ts; this module owns persistence + audit.

export interface StoredPolicyRow {
  id: string;
  namespace_id: string;
  rule: PolicyRule;
  updated_at: Date;
  updated_by: string;
}

export async function upsertPolicy(
  db: Kysely<Database>,
  input: {
    namespaceId: string;
    updatedBy: string;
    requestId: string;
    rule: unknown;
    // Optional: when provided, update an existing policy by id; otherwise insert.
    id?: string;
  },
): Promise<StoredPolicyRow> {
  await requireAdmin(db, input.namespaceId, input.updatedBy);
  const rule = parsePolicyRule(input.rule);

  return await db.transaction().execute(async (tx) => {
    let row;
    let kind: "policy.insert" | "policy.update";
    if (input.id !== undefined) {
      const existing = await tx
        .selectFrom("policies")
        .select(["id", "namespace_id"])
        .where("id", "=", input.id)
        .executeTakeFirst();
      if (!existing || existing.namespace_id !== input.namespaceId) {
        throw new LedgerError("not_found", "policy not found in namespace");
      }
      row = await tx
        .updateTable("policies")
        .set({
          rule: JSON.stringify(rule as unknown as JsonValue),
          updated_by: input.updatedBy,
        })
        .where("id", "=", input.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      kind = "policy.update";
    } else {
      row = await tx
        .insertInto("policies")
        .values({
          namespace_id: input.namespaceId,
          rule: JSON.stringify(rule as unknown as JsonValue),
          updated_by: input.updatedBy,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      kind = "policy.insert";
    }

    await appendAudit(tx, {
      namespaceId: input.namespaceId,
      actorAgentId: input.updatedBy,
      requestId: input.requestId,
      plane: "control",
      kind,
      payload: { policy_id: row.id, rule: rule as unknown as Record<string, unknown> },
    });

    return {
      id: row.id,
      namespace_id: row.namespace_id,
      rule,
      updated_at: row.updated_at,
      updated_by: row.updated_by,
    };
  });
}

export async function deletePolicy(
  db: Kysely<Database>,
  input: {
    namespaceId: string;
    policyId: string;
    actorAgentId: string;
    requestId: string;
  },
): Promise<void> {
  await requireAdmin(db, input.namespaceId, input.actorAgentId);
  await db.transaction().execute(async (tx) => {
    const existing = await tx
      .selectFrom("policies")
      .select(["id", "namespace_id"])
      .where("id", "=", input.policyId)
      .executeTakeFirst();
    if (!existing || existing.namespace_id !== input.namespaceId) {
      throw new LedgerError("not_found", "policy not found in namespace");
    }
    await tx.deleteFrom("policies").where("id", "=", input.policyId).execute();
    await appendAudit(tx, {
      namespaceId: input.namespaceId,
      actorAgentId: input.actorAgentId,
      requestId: input.requestId,
      plane: "control",
      kind: "policy.delete",
      payload: { policy_id: input.policyId },
    });
  });
}

export async function listPolicies(
  db: Kysely<Database>,
  namespaceId: string,
): Promise<StoredPolicyRow[]> {
  const rows = await db
    .selectFrom("policies")
    .selectAll()
    .where("namespace_id", "=", namespaceId)
    .orderBy("updated_at", "asc")
    .execute();
  return rows.map((r) => {
    // Parse defensively — surface corrupt rules as policy_invalid rather than
    // silently dropping them. listPolicies is administrative.
    const rule = parsePolicyRule(r.rule);
    return {
      id: r.id,
      namespace_id: r.namespace_id,
      rule,
      updated_at: r.updated_at,
      updated_by: r.updated_by,
    };
  });
}
