import type { Kysely } from "kysely";
import type { Database, JsonValue } from "../../storage/postgres/schema.js";
import { LedgerError } from "../errors.js";
import {
  parseTransitionDefinition,
  type Assert,
  type Op,
  type TransitionDefinition,
} from "./grammar.js";
import type { SchemaDsl } from "../schema.js";

// Transition registration and lookup.
// Transitions are versioned: re-registering a name with the same version is
// rejected (I5 immutability). New behavior registers a new version. Deprecation
// marks a version as unavailable for new invocations but preserves the body.

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;

export interface RegisteredTransition {
  namespace_id: string;
  name: string;
  version: number;
  description: string;
  required_role: string | null;
  def: TransitionDefinition;
  deprecated: boolean;
}

export async function registerTransition(
  db: Kysely<Database>,
  input: {
    namespaceId: string;
    registeredBy: string;
    name: string;
    version: number;
    params_schema: unknown;
    asserts: unknown;
    ops: unknown;
    description?: string;
    required_role?: string | null;
  },
): Promise<void> {
  if (!NAME_RE.test(input.name)) {
    throw new LedgerError("invalid_params", "transition name must match /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/");
  }
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new LedgerError("invalid_params", "transition version must be a positive integer");
  }
  const def = parseTransitionDefinition({
    params_schema: input.params_schema,
    asserts: input.asserts,
    ops: input.ops,
  });

  // Immutability: reject re-registration of the same (name, version).
  const existing = await db
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

  await db
    .insertInto("transitions")
    .values({
      namespace_id: input.namespaceId,
      name: input.name,
      version: input.version,
      params_schema: JSON.stringify(def.params_schema as unknown as JsonValue),
      asserts: JSON.stringify(def.asserts as unknown as JsonValue),
      ops: JSON.stringify(def.ops as unknown as JsonValue),
      description: input.description ?? "",
      required_role: input.required_role ?? null,
      registered_by: input.registeredBy,
    })
    .execute();
}

export async function deprecateTransition(
  db: Kysely<Database>,
  namespaceId: string,
  name: string,
  version: number,
): Promise<void> {
  const res = await db
    .updateTable("transitions")
    .set({ deprecated_at: new Date() })
    .where("namespace_id", "=", namespaceId)
    .where("name", "=", name)
    .where("version", "=", version)
    .where("deprecated_at", "is", null)
    .executeTakeFirst();
  if (Number(res.numUpdatedRows) === 0) {
    throw new LedgerError("not_found", "transition not found or already deprecated", {
      name, version,
    });
  }
}

// Load the latest non-deprecated version if `version` is undefined; else the
// exact version. Deprecated versions are refused for invocation (I5 derivative).
export async function loadTransition(
  db: Kysely<Database>,
  namespaceId: string,
  name: string,
  version?: number,
): Promise<RegisteredTransition> {
  let q = db
    .selectFrom("transitions")
    .select([
      "name", "version", "params_schema", "asserts", "ops",
      "description", "required_role", "deprecated_at",
    ])
    .where("namespace_id", "=", namespaceId)
    .where("name", "=", name);

  if (version !== undefined) {
    q = q.where("version", "=", version);
  } else {
    q = q.where("deprecated_at", "is", null).orderBy("version", "desc").limit(1);
  }

  const row = await q.executeTakeFirst();
  if (!row) {
    throw new LedgerError("transition_unavailable",
      `transition ${name}${version !== undefined ? `@v${version}` : ""} not registered`);
  }
  if (row.deprecated_at !== null) {
    throw new LedgerError("transition_unavailable",
      `transition ${name}@v${row.version} is deprecated`);
  }

  return {
    namespace_id: namespaceId,
    name: row.name,
    version: row.version,
    description: row.description,
    required_role: row.required_role,
    deprecated: row.deprecated_at !== null,
    def: {
      params_schema: row.params_schema as unknown as SchemaDsl,
      asserts: row.asserts as unknown as Assert[],
      ops: row.ops as unknown as Op[],
    },
  };
}

export async function listTransitions(
  db: Kysely<Database>,
  namespaceId: string,
  includeDeprecated: boolean,
): Promise<Array<{
  name: string;
  version: number;
  description: string;
  required_role: string | null;
  deprecated: boolean;
}>> {
  let q = db
    .selectFrom("transitions")
    .select(["name", "version", "description", "required_role", "deprecated_at"])
    .where("namespace_id", "=", namespaceId);
  if (!includeDeprecated) q = q.where("deprecated_at", "is", null);
  const rows = await q.orderBy("name", "asc").orderBy("version", "asc").execute();
  return rows.map((r) => ({
    name: r.name,
    version: r.version,
    description: r.description,
    required_role: r.required_role,
    deprecated: r.deprecated_at !== null,
  }));
}
