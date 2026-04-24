import crypto from "node:crypto";
import { sql, type Kysely } from "kysely";
import { getDb, closeDb, getPool } from "../../src/storage/postgres/client.js";
import { runMigrations } from "../../src/storage/postgres/migrate.js";
import type { Database, JsonValue } from "../../src/storage/postgres/schema.js";
import type { SchemaDsl } from "../../src/core/schema.js";

// Shared integration harness. One DB process for all tests (singleFork in vitest
// config). Each test allocates its own namespace + agent so state cannot leak.

let migrated = false;

export async function ensureSchema(): Promise<Kysely<Database>> {
  // Fail fast with a clear message if the DB is unreachable — avoids hanging.
  const pool = getPool();
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    throw new Error(
      `Cannot reach Postgres at DATABASE_URL. Run 'docker compose up -d postgres' ` +
        `and wait for it to become healthy. Root cause: ${(err as Error).message}`,
    );
  }
  if (!migrated) {
    await runMigrations();
    migrated = true;
  }
  return getDb();
}

// With vitest `singleFork`, both test files run in the same process and share
// the pool singleton. The first afterAll closes it; the second would then fail
// with "Called end on pool more than once". Guard both steps idempotently so
// teardown order doesn't matter.
let shuttingDown: Promise<void> | null = null;
export async function shutdown(): Promise<void> {
  if (!shuttingDown) {
    shuttingDown = closeDb().catch(() => undefined).then(() => {
      migrated = false;
    });
  }
  await shuttingDown;
}

export interface SeededAgent {
  id: string;
  oauthSubject: string;
}

export async function seedAgent(
  db: Kysely<Database>,
  subject = `test-${crypto.randomUUID()}`,
): Promise<SeededAgent> {
  const row = await db
    .insertInto("agents")
    .values({ oauth_subject: subject })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: row.id, oauthSubject: subject };
}

export interface SeededNamespace {
  id: string;
  owner: SeededAgent;
}

export async function seedNamespace(
  db: Kysely<Database>,
  alias: string | null = null,
): Promise<SeededNamespace> {
  const owner = await seedAgent(db);
  const row = await db
    .insertInto("namespaces")
    .values({ owner_agent_id: owner.id, alias })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: row.id, owner };
}

// Direct schema insertion — bypasses any control-plane handler that doesn't yet
// exist. Mirrors the future `schema.register` tool.
export async function seedSchema(
  db: Kysely<Database>,
  input: {
    namespaceId: string;
    registeredBy: string;
    name: string;
    version: number;
    dsl: SchemaDsl;
  },
): Promise<void> {
  await db
    .insertInto("schemas")
    .values({
      namespace_id: input.namespaceId,
      name: input.name,
      version: input.version,
      json_schema: JSON.stringify(input.dsl as unknown as JsonValue),
      zod_source: "// test-seeded",
      registered_by: input.registeredBy,
    })
    .execute();
}

// Truncate all data tables in FK-safe order. Use between tests if you need a
// blank slate without re-running migrations.
export async function truncateAll(db: Kysely<Database>): Promise<void> {
  await sql`
    TRUNCATE TABLE
      audit_log, audit_heads,
      idempotency, rate_buckets,
      locks, blob_refs, blobs,
      counters, log_entries, logs, docs,
      transitions, schemas,
      role_members, role_capabilities, roles,
      enrollment_requests,
      namespaces, agents
    RESTART IDENTITY CASCADE
  `.execute(db);
}

// Test helper: convenience wrapper that creates a role and grants it to an
// agent (or '*'). Bypasses the manage_roles gate by inserting directly.
export async function seedRole(
  db: Kysely<Database>,
  input: {
    namespaceId: string;
    createdBy: string;
    name: string;
    description?: string;
    capabilities: Array<{
      scope_kind: "read" | "invoke" | "manage_roles";
      path_glob?: string | null;
      transition_name?: string | null;
    }>;
    members?: Array<{ agentId: string; grantedBy: string }>;
  },
): Promise<{ roleId: string }> {
  const role = await db
    .insertInto("roles")
    .values({
      namespace_id: input.namespaceId,
      name: input.name,
      description: input.description ?? "",
      created_by: input.createdBy,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (input.capabilities.length > 0) {
    await db
      .insertInto("role_capabilities")
      .values(input.capabilities.map((c) => ({
        role_id: role.id,
        scope_kind: c.scope_kind,
        path_glob: c.path_glob ?? null,
        transition_name: c.transition_name ?? null,
      })))
      .execute();
  }
  for (const m of input.members ?? []) {
    await db
      .insertInto("role_members")
      .values({
        role_id: role.id,
        agent_id: m.agentId,
        granted_by: m.grantedBy,
      })
      .execute();
  }
  return { roleId: role.id };
}
