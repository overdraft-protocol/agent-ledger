import type { ColumnType, Generated } from "kysely";

// Kysely table types — one-to-one with migration DDL.
// Types mirror ARCHITECTURE.md § Storage schema.

// Use a plain type for timestamp columns. pg's node driver returns Date; on write
// we always pass Date or ISO string — both via sql-level coercion. Kysely's
// Generated<ColumnType<...>> unwrapping doesn't play nicely with
// exactOptionalPropertyTypes in our usage, so we keep the column type concrete.
export type Timestamp = Date;

// JSON column shape: selects yield any JSON value (including scalars); inserts
// and updates take a JSON-serialized string. Kysely's built-in JSONColumnType
// is restricted to object|null; we use a direct ColumnType.
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

export type JsonColumn = ColumnType<JsonValue, string, string>;

export interface Database {
  agents: AgentsTable;
  namespaces: NamespacesTable;
  admins: AdminsTable;
  capabilities: CapabilitiesTable;

  schemas: SchemasTable;
  transitions: TransitionsTable;
  policies: PoliciesTable;

  docs: DocsTable;
  logs: LogsTable;
  log_entries: LogEntriesTable;
  counters: CountersTable;
  blobs: BlobsTable;
  blob_refs: BlobRefsTable;
  locks: LocksTable;

  audit_log: AuditLogTable;
  audit_heads: AuditHeadsTable;

  idempotency: IdempotencyTable;
  rate_buckets: RateBucketsTable;
  system_state: SystemStateTable;

  migrations: MigrationsTable;
}

// ---------- Identity & governance ----------

export interface AgentsTable {
  id: Generated<string>;
  oauth_subject: string;
  created_at: Generated<Timestamp>;
  disabled_at: Timestamp | null;
}

export interface NamespacesTable {
  id: Generated<string>;
  owner_agent_id: string;
  alias: string | null;
  created_at: Generated<Timestamp>;
  tombstoned_at: Timestamp | null;
}

export interface AdminsTable {
  namespace_id: string;
  agent_id: string;
  granted_by: string;
  granted_at: Generated<Timestamp>;
}

export interface CapabilitiesTable {
  id: Generated<string>;
  namespace_id: string;
  agent_id: string;
  scope_kind: "read" | "invoke";
  path_glob: string | null;
  transition_name: string | null;
  granted_by: string;
  granted_at: Generated<Timestamp>;
  expires_at: Timestamp | null;
}

// ---------- Control plane ----------

export interface SchemasTable {
  namespace_id: string;
  name: string;
  version: number;
  json_schema: JsonColumn;
  zod_source: string;
  registered_at: Generated<Timestamp>;
  registered_by: string;
  deprecated_at: Timestamp | null;
}

export interface TransitionsTable {
  namespace_id: string;
  name: string;
  version: number;
  params_schema: JsonColumn;
  asserts: JsonColumn;
  ops: JsonColumn;
  registered_at: Generated<Timestamp>;
  registered_by: string;
  deprecated_at: Timestamp | null;
}

export interface PoliciesTable {
  namespace_id: string;
  id: Generated<string>;
  rule: JsonColumn;
  updated_at: Generated<Timestamp>;
  updated_by: string;
}

// ---------- Data plane ----------

export interface DocsTable {
  namespace_id: string;
  path: string;
  schema_name: string;
  schema_version: number;
  value: JsonColumn;
  version: Generated<string>; // bigint
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface LogsTable {
  namespace_id: string;
  log_id: string;
  schema_name: string;
  schema_version: number;
  next_offset: Generated<string>; // bigint, row-locked counter
  created_at: Generated<Timestamp>;
}

export interface LogEntriesTable {
  namespace_id: string;
  log_id: string;
  offset_id: string; // bigint
  value: JsonColumn;
  appended_at: Generated<Timestamp>;
}

export interface CountersTable {
  namespace_id: string;
  path: string;
  n: string; // bigint
  min_value: string; // bigint
  max_value: string; // bigint
}

export interface BlobsTable {
  sha256: Buffer;
  size_bytes: string; // bigint
  content_type: string | null;
  stored_at: Generated<Timestamp>;
}

export interface BlobRefsTable {
  namespace_id: string;
  sha256: Buffer;
  ref_count: string; // bigint
}

export interface LocksTable {
  namespace_id: string;
  path: string;
  owner_agent_id: string;
  fence: string; // bigint
  expires_at: Timestamp;
  acquired_at: Timestamp;
}

// ---------- Audit ----------

export interface AuditLogTable {
  namespace_id: string;
  seq: string; // bigint
  created_at: Generated<Timestamp>;
  actor_agent_id: string;
  request_id: string;
  plane: "control" | "data";
  kind: string;
  payload: JsonColumn;
  prev_hash: Buffer;
  chain_hash: Buffer;
}

export interface AuditHeadsTable {
  namespace_id: string;
  seq: string; // bigint
  chain_hash: Buffer;
  updated_at: Generated<Timestamp>;
}

// ---------- Infrastructure ----------

export interface IdempotencyTable {
  agent_id: string;
  key: string;
  result: JsonColumn;
  created_at: Generated<Timestamp>;
  expires_at: Timestamp;
}

export interface RateBucketsTable {
  agent_id: string;
  window_second: string; // bigint
  cost_consumed: string; // bigint
}

export interface SystemStateTable {
  key: string;
  value: JsonColumn;
  updated_at: Generated<Timestamp>;
}

export interface MigrationsTable {
  id: number;
  name: string;
  applied_at: Generated<Timestamp>;
}
