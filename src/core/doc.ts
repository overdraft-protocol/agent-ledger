import type { Kysely } from "kysely";
import { sql } from "kysely";
// Note: Kysely's Generated<Timestamp> narrows update-side types awkwardly under
// exactOptionalPropertyTypes. Use a raw `sql` expression for updated_at.
import type { Database } from "../storage/postgres/schema.js";
import { LedgerError } from "./errors.js";
import { validatePath } from "./path.js";
import { collectBlobRefs, compileToZod, loadSchema, validateWithBudget } from "./schema.js";

// `doc` — typed JSON documents, point get/put, indexed query.
// Reads: direct (capability-gated upstream).
// Mutations: only inside a transition's tx (operations are stateless on `tx`).

export const DOC_INLINE_MAX_BYTES = 256 * 1024;

export interface DocRow {
  namespace_id: string;
  path: string;
  schema_name: string;
  schema_version: number;
  value: unknown;
  version: string; // bigint
  created_at: Date;
  updated_at: Date;
}

export async function docGet(
  db: Kysely<Database>,
  namespaceId: string,
  path: string,
): Promise<DocRow | null> {
  validatePath(path);
  const row = await db
    .selectFrom("docs")
    .selectAll()
    .where("namespace_id", "=", namespaceId)
    .where("path", "=", path)
    .executeTakeFirst();
  if (!row) return null;
  return {
    namespace_id: row.namespace_id,
    path: row.path,
    schema_name: row.schema_name,
    schema_version: row.schema_version,
    value: row.value,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// --- Mutations inside an active tx --------------------------------------

export interface DocPutInput {
  path: string;
  schemaName: string;
  schemaVersion: number;
  value: unknown;
  // Optional expected version for CAS. `0` = must not exist.
  expectedVersion?: bigint;
}

// Validate + insert/update. Adjusts blob_refs in the same transaction.
export async function docPut(
  tx: Kysely<Database>,
  namespaceId: string,
  input: DocPutInput,
): Promise<{ version: bigint; previousBlobs: string[]; newBlobs: string[] }> {
  validatePath(input.path);
  const bytes = Buffer.byteLength(JSON.stringify(input.value), "utf8");
  if (bytes > DOC_INLINE_MAX_BYTES) {
    throw new LedgerError("too_large", `doc exceeds ${DOC_INLINE_MAX_BYTES} bytes; use blob storage`);
  }

  const { dsl, deprecated } = await loadSchema(
    tx,
    namespaceId,
    input.schemaName,
    input.schemaVersion,
  );
  if (deprecated) {
    throw new LedgerError("schema_immutable", "cannot write against a deprecated schema version", {
      schema_name: input.schemaName,
      schema_version: input.schemaVersion,
    });
  }
  const validator = compileToZod(dsl);
  validateWithBudget(validator, input.value, {
    op: "doc.put",
    path: input.path,
    schema_name: input.schemaName,
    schema_version: input.schemaVersion,
    schema_dsl: dsl,
  });
  const newBlobs = collectBlobRefs(dsl, input.value);

  // Lock and read any existing row for CAS + prior-blob accounting.
  const existing = await sql<{
    schema_name: string;
    schema_version: number;
    value: unknown;
    version: string;
  } | undefined>`
    SELECT schema_name, schema_version, value, version
    FROM docs
    WHERE namespace_id = ${namespaceId} AND path = ${input.path}
    FOR UPDATE
  `.execute(tx);

  const prior = existing.rows[0];
  const currentVersion = prior ? BigInt(prior.version) : 0n;

  if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
    throw new LedgerError("version_conflict", "doc version mismatch", {
      path: input.path,
      expected: input.expectedVersion.toString(),
      actual: currentVersion.toString(),
    });
  }

  // Compute prior blob refs using the prior doc's schema (not the new one).
  let previousBlobs: string[] = [];
  if (prior) {
    const priorSchema = await loadSchema(tx, namespaceId, prior.schema_name, prior.schema_version);
    previousBlobs = collectBlobRefs(priorSchema.dsl, prior.value);
  }

  const nextVersion = currentVersion + 1n;
  if (prior) {
    await tx
      .updateTable("docs")
      .set({
        schema_name: input.schemaName,
        schema_version: input.schemaVersion,
        value: JSON.stringify(input.value),
        version: nextVersion.toString(),
        updated_at: sql<Date>`now()`,
      })
      .where("namespace_id", "=", namespaceId)
      .where("path", "=", input.path)
      .execute();
  } else {
    await tx
      .insertInto("docs")
      .values({
        namespace_id: namespaceId,
        path: input.path,
        schema_name: input.schemaName,
        schema_version: input.schemaVersion,
        value: JSON.stringify(input.value),
        version: nextVersion.toString(),
      })
      .execute();
  }

  await adjustBlobRefs(tx, namespaceId, previousBlobs, newBlobs);

  return { version: nextVersion, previousBlobs, newBlobs };
}

export async function docDelete(
  tx: Kysely<Database>,
  namespaceId: string,
  path: string,
  expectedVersion?: bigint,
): Promise<{ previousBlobs: string[] }> {
  validatePath(path);
  const existing = await sql<{
    schema_name: string;
    schema_version: number;
    value: unknown;
    version: string;
  } | undefined>`
    SELECT schema_name, schema_version, value, version
    FROM docs
    WHERE namespace_id = ${namespaceId} AND path = ${path}
    FOR UPDATE
  `.execute(tx);

  const prior = existing.rows[0];
  if (!prior) {
    throw new LedgerError("not_found", `doc not found: ${path}`);
  }
  const currentVersion = BigInt(prior.version);
  if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
    throw new LedgerError("version_conflict", "doc version mismatch", {
      path,
      expected: expectedVersion.toString(),
      actual: currentVersion.toString(),
    });
  }

  const priorSchema = await loadSchema(tx, namespaceId, prior.schema_name, prior.schema_version);
  const previousBlobs = collectBlobRefs(priorSchema.dsl, prior.value);

  await tx
    .deleteFrom("docs")
    .where("namespace_id", "=", namespaceId)
    .where("path", "=", path)
    .execute();

  await adjustBlobRefs(tx, namespaceId, previousBlobs, []);

  return { previousBlobs };
}

// Increment/decrement blob_refs rows transactionally (I22).
// Zero-ref rows remain; a background sweeper removes them and the underlying blob.
async function adjustBlobRefs(
  tx: Kysely<Database>,
  namespaceId: string,
  prior: string[],
  next: string[],
): Promise<void> {
  const delta = new Map<string, number>();
  for (const h of prior) delta.set(h, (delta.get(h) ?? 0) - 1);
  for (const h of next) delta.set(h, (delta.get(h) ?? 0) + 1);

  for (const [hex, d] of delta) {
    if (d === 0) continue;
    const sha = Buffer.from(hex, "hex");
    if (d > 0) {
      await sql`
        INSERT INTO blob_refs (namespace_id, sha256, ref_count)
        VALUES (${namespaceId}, ${sha}, ${d})
        ON CONFLICT (namespace_id, sha256)
        DO UPDATE SET ref_count = blob_refs.ref_count + ${d}
      `.execute(tx);
    } else {
      const r = await sql<{ ref_count: string } | undefined>`
        UPDATE blob_refs
        SET ref_count = ref_count + ${d}
        WHERE namespace_id = ${namespaceId} AND sha256 = ${sha}
        RETURNING ref_count
      `.execute(tx);
      if (!r.rows[0]) {
        throw new LedgerError("internal", "blob_ref decrement missing row", { sha256: hex });
      }
    }
  }
}
