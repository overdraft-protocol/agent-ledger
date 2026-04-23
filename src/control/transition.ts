import type { Kysely } from "kysely";
import type { Database, JsonValue } from "../storage/postgres/schema.js";
import { LedgerError } from "../core/errors.js";
import { appendAudit } from "../core/audit.js";
import { requireAdmin } from "../core/capabilities.js";
import {
  parseTransitionDefinition,
  type Assert,
  type Op,
  type TransitionDefinition,
} from "../core/transition/grammar.js";
import type { SchemaDsl } from "../core/schema.js";

// Control-plane wrapper around core/transition/registry. Enforces admin
// capability, immutability, and emits audit entries in the same tx as the
// mutation (I29). Use this in place of registerTransition/deprecateTransition
// from core/transition/registry when an actor agent is known.

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;

export async function registerTransition(
  db: Kysely<Database>,
  input: {
    namespaceId: string;
    actorAgentId: string;
    requestId: string;
    name: string;
    version: number;
    params_schema: unknown;
    asserts: unknown;
    ops: unknown;
  },
): Promise<void> {
  await requireAdmin(db, input.namespaceId, input.actorAgentId);
  if (!NAME_RE.test(input.name)) {
    throw new LedgerError("invalid_params",
      "transition name must match /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/");
  }
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new LedgerError("invalid_params", "transition version must be a positive integer");
  }
  const def = parseTransitionDefinition({
    params_schema: input.params_schema,
    asserts: input.asserts,
    ops: input.ops,
  });

  await db.transaction().execute(async (tx) => {
    const existing = await tx
      .selectFrom("transitions")
      .select(["name", "version"])
      .where("namespace_id", "=", input.namespaceId)
      .where("name", "=", input.name)
      .where("version", "=", input.version)
      .executeTakeFirst();
    if (existing) {
      throw new LedgerError("transition_name_taken",
        `transition ${input.name}@v${input.version} already registered`);
    }
    await tx
      .insertInto("transitions")
      .values({
        namespace_id: input.namespaceId,
        name: input.name,
        version: input.version,
        params_schema: JSON.stringify(def.params_schema as unknown as JsonValue),
        asserts: JSON.stringify(def.asserts as unknown as JsonValue),
        ops: JSON.stringify(def.ops as unknown as JsonValue),
        registered_by: input.actorAgentId,
      })
      .execute();

    await appendAudit(tx, {
      namespaceId: input.namespaceId,
      actorAgentId: input.actorAgentId,
      requestId: input.requestId,
      plane: "control",
      kind: "transition.register",
      payload: { name: input.name, version: input.version },
    });
  });
}

export async function deprecateTransition(
  db: Kysely<Database>,
  input: {
    namespaceId: string;
    actorAgentId: string;
    requestId: string;
    name: string;
    version: number;
  },
): Promise<void> {
  await requireAdmin(db, input.namespaceId, input.actorAgentId);
  await db.transaction().execute(async (tx) => {
    const res = await tx
      .updateTable("transitions")
      .set({ deprecated_at: new Date() })
      .where("namespace_id", "=", input.namespaceId)
      .where("name", "=", input.name)
      .where("version", "=", input.version)
      .where("deprecated_at", "is", null)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) {
      throw new LedgerError("not_found", "transition not found or already deprecated", {
        name: input.name, version: input.version,
      });
    }
    await appendAudit(tx, {
      namespaceId: input.namespaceId,
      actorAgentId: input.actorAgentId,
      requestId: input.requestId,
      plane: "control",
      kind: "transition.deprecate",
      payload: { name: input.name, version: input.version },
    });
  });
}

export interface TransitionDetail {
  name: string;
  version: number;
  deprecated: boolean;
  registered_at: Date;
  registered_by: string;
  def: TransitionDefinition;
}

export async function getTransition(
  db: Kysely<Database>,
  namespaceId: string,
  name: string,
  version: number,
): Promise<TransitionDetail> {
  const row = await db
    .selectFrom("transitions")
    .selectAll()
    .where("namespace_id", "=", namespaceId)
    .where("name", "=", name)
    .where("version", "=", version)
    .executeTakeFirst();
  if (!row) {
    throw new LedgerError("not_found", `transition ${name}@v${version} not registered`);
  }
  return {
    name: row.name,
    version: row.version,
    deprecated: row.deprecated_at !== null,
    registered_at: row.registered_at,
    registered_by: row.registered_by,
    def: {
      params_schema: row.params_schema as unknown as SchemaDsl,
      asserts: row.asserts as unknown as Assert[],
      ops: row.ops as unknown as Op[],
    },
  };
}
