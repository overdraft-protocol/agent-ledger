import type { Kysely } from "kysely";
import type { Database, JsonValue } from "../storage/postgres/schema.js";
import { LedgerError } from "../core/errors.js";
import { appendAudit } from "../core/audit.js";
import { requireManageRoles } from "../core/capabilities.js";
import {
  parseTransitionDefinition,
  type Assert,
  type Op,
  type TransitionDefinition,
} from "../core/transition/grammar.js";
import type { SchemaDsl } from "../core/schema.js";

// Control-plane wrapper around core/transition/registry. Enforces the
// manage_roles capability (or owner), immutability, and emits an audit entry
// in the same tx as the mutation (I29). Persists the new self-describing
// metadata: `description` (free text) and `required_role` (the role name an
// agent must hold to invoke this transition; null = owner-only).

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;
const MAX_DESCRIPTION_BYTES = 4096;

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
    description: string;
    required_role: string | null;
  },
): Promise<void> {
  await requireManageRoles(db, input.namespaceId, input.actorAgentId);
  if (!NAME_RE.test(input.name)) {
    throw new LedgerError("invalid_params",
      "transition name must match /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/");
  }
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new LedgerError("invalid_params", "transition version must be a positive integer");
  }
  if (typeof input.description !== "string") {
    throw new LedgerError("invalid_params", "transition description must be a string");
  }
  if (Buffer.byteLength(input.description, "utf8") > MAX_DESCRIPTION_BYTES) {
    throw new LedgerError("invalid_params",
      `transition description exceeds ${MAX_DESCRIPTION_BYTES} bytes`);
  }
  if (input.required_role !== null && !NAME_RE.test(input.required_role)) {
    throw new LedgerError("invalid_params",
      "required_role must be null or match /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/");
  }
  const def = parseTransitionDefinition({
    params_schema: input.params_schema,
    asserts: input.asserts,
    ops: input.ops,
  });

  // If a required_role is supplied it must reference an existing role in this
  // namespace at registration time. We do NOT add a FK so historical
  // transitions remain queryable after a role is later renamed/deleted.
  if (input.required_role !== null) {
    const role = await db
      .selectFrom("roles")
      .select("id")
      .where("namespace_id", "=", input.namespaceId)
      .where("name", "=", input.required_role)
      .executeTakeFirst();
    if (!role) {
      throw new LedgerError("not_found",
        `required_role '${input.required_role}' does not exist in namespace`);
    }
  }

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
        description: input.description,
        required_role: input.required_role,
        registered_by: input.actorAgentId,
      })
      .execute();

    await appendAudit(tx, {
      namespaceId: input.namespaceId,
      actorAgentId: input.actorAgentId,
      requestId: input.requestId,
      plane: "control",
      kind: "transition.register",
      payload: {
        name: input.name,
        version: input.version,
        required_role: input.required_role,
      },
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
  await requireManageRoles(db, input.namespaceId, input.actorAgentId);
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
  description: string;
  required_role: string | null;
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
    description: row.description,
    required_role: row.required_role,
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
