import type { Kysely } from "kysely";
import type { Database, JsonValue } from "../storage/postgres/schema.js";
import { LedgerError } from "../core/errors.js";
import {
  parseSchemaDsl,
  toJsonSchema,
  type SchemaDsl,
} from "../core/schema.js";
import { appendAudit } from "../core/audit.js";
import { requireManageRoles } from "../core/capabilities.js";

// Schema.register — control-plane handler for adding a new typed primitive
// schema. Immutable once registered (I9); `deprecate` marks a version unusable
// for new instances but leaves history intact.
//
// Schemas are an internal artifact of the protocol designer; they are not
// exposed as a discoverable surface to ordinary agents (those see schemas
// inlined in doc/log read responses and transition.get descriptions). The
// gate is therefore `manage_roles` — the same gate used for role and
// transition admin.

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;

export interface SchemaSummary {
  name: string;
  version: number;
  deprecated: boolean;
  registered_at: Date;
  registered_by: string;
}

export interface SchemaDetail extends SchemaSummary {
  dsl: SchemaDsl;
  json_schema: unknown;
}

export async function registerSchema(
  db: Kysely<Database>,
  input: {
    namespaceId: string;
    registeredBy: string;
    requestId: string;
    name: string;
    version: number;
    dsl: unknown;
  },
): Promise<SchemaSummary> {
  await requireManageRoles(db, input.namespaceId, input.registeredBy);
  if (!NAME_RE.test(input.name)) {
    throw new LedgerError("invalid_params", "schema name must match /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/");
  }
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new LedgerError("invalid_params", "schema version must be a positive integer");
  }
  const dsl = parseSchemaDsl(input.dsl);

  return await db.transaction().execute(async (tx) => {
    const existing = await tx
      .selectFrom("schemas")
      .select(["name"])
      .where("namespace_id", "=", input.namespaceId)
      .where("name", "=", input.name)
      .where("version", "=", input.version)
      .executeTakeFirst();
    if (existing) {
      throw new LedgerError("schema_immutable",
        `schema ${input.name}@v${input.version} is already registered`);
    }

    const row = await tx
      .insertInto("schemas")
      .values({
        namespace_id: input.namespaceId,
        name: input.name,
        version: input.version,
        json_schema: JSON.stringify(dsl as unknown as JsonValue),
        zod_source: "", // reserved for future authoring roundtrip
        registered_by: input.registeredBy,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await appendAudit(tx, {
      namespaceId: input.namespaceId,
      actorAgentId: input.registeredBy,
      requestId: input.requestId,
      plane: "control",
      kind: "schema.register",
      payload: { name: input.name, version: input.version },
    });

    return {
      name: row.name,
      version: row.version,
      deprecated: false,
      registered_at: row.registered_at,
      registered_by: row.registered_by,
    };
  });
}

export async function deprecateSchema(
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
    const r = await tx
      .updateTable("schemas")
      .set({ deprecated_at: new Date() })
      .where("namespace_id", "=", input.namespaceId)
      .where("name", "=", input.name)
      .where("version", "=", input.version)
      .where("deprecated_at", "is", null)
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) === 0) {
      throw new LedgerError("not_found", "schema not found or already deprecated");
    }
    await appendAudit(tx, {
      namespaceId: input.namespaceId,
      actorAgentId: input.actorAgentId,
      requestId: input.requestId,
      plane: "control",
      kind: "schema.deprecate",
      payload: { name: input.name, version: input.version },
    });
  });
}

export async function listSchemas(
  db: Kysely<Database>,
  namespaceId: string,
  includeDeprecated: boolean,
): Promise<SchemaSummary[]> {
  let q = db
    .selectFrom("schemas")
    .select(["name", "version", "registered_at", "registered_by", "deprecated_at"])
    .where("namespace_id", "=", namespaceId);
  if (!includeDeprecated) q = q.where("deprecated_at", "is", null);
  const rows = await q.orderBy("name", "asc").orderBy("version", "asc").execute();
  return rows.map((r) => ({
    name: r.name,
    version: r.version,
    deprecated: r.deprecated_at !== null,
    registered_at: r.registered_at,
    registered_by: r.registered_by,
  }));
}

export async function getSchema(
  db: Kysely<Database>,
  namespaceId: string,
  name: string,
  version: number,
): Promise<SchemaDetail> {
  const row = await db
    .selectFrom("schemas")
    .selectAll()
    .where("namespace_id", "=", namespaceId)
    .where("name", "=", name)
    .where("version", "=", version)
    .executeTakeFirst();
  if (!row) {
    throw new LedgerError("not_found", `schema ${name}@v${version} not found`);
  }
  const dsl = parseSchemaDsl(row.json_schema);
  return {
    name: row.name,
    version: row.version,
    deprecated: row.deprecated_at !== null,
    registered_at: row.registered_at,
    registered_by: row.registered_by,
    dsl,
    json_schema: toJsonSchema(dsl),
  };
}
