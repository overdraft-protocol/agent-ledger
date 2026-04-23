-- Data-plane primitives: doc, log, counter, blob, lock.

-- ===== doc =====

CREATE TABLE docs (
  namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  path              text NOT NULL,
  schema_name       text NOT NULL,
  schema_version    int  NOT NULL,
  value             jsonb NOT NULL,
  version           bigint NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace_id, path),
  FOREIGN KEY (namespace_id, schema_name, schema_version)
      REFERENCES schemas(namespace_id, name, version)
);

CREATE INDEX docs_value_gin ON docs USING GIN (value jsonb_path_ops);
CREATE INDEX docs_ns_schema ON docs(namespace_id, schema_name, schema_version);

-- ===== log =====

CREATE TABLE logs (
  namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  log_id            text NOT NULL,
  schema_name       text NOT NULL,
  schema_version    int  NOT NULL,
  -- Row-locked counter gives dense offsets (ARCHITECTURE.md I19).
  next_offset       bigint NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace_id, log_id),
  FOREIGN KEY (namespace_id, schema_name, schema_version)
      REFERENCES schemas(namespace_id, name, version)
);

CREATE TABLE log_entries (
  namespace_id      uuid NOT NULL,
  log_id            text NOT NULL,
  offset_id         bigint NOT NULL,
  value             jsonb NOT NULL,
  appended_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace_id, log_id, offset_id),
  FOREIGN KEY (namespace_id, log_id)
      REFERENCES logs(namespace_id, log_id) ON DELETE CASCADE
);

-- ===== counter =====

CREATE TABLE counters (
  namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  path              text NOT NULL,
  n                 bigint NOT NULL,
  min_value         bigint NOT NULL,
  max_value         bigint NOT NULL,
  PRIMARY KEY (namespace_id, path),
  CHECK (n BETWEEN min_value AND max_value),
  CHECK (min_value <= max_value)
);

-- ===== blob =====

CREATE TABLE blobs (
  sha256            bytea PRIMARY KEY,
  size_bytes        bigint NOT NULL CHECK (size_bytes >= 0),
  content_type      text,
  stored_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE blob_refs (
  namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  sha256            bytea NOT NULL REFERENCES blobs(sha256),
  ref_count         bigint NOT NULL DEFAULT 0 CHECK (ref_count >= 0),
  PRIMARY KEY (namespace_id, sha256)
);

CREATE INDEX blob_refs_sha ON blob_refs(sha256);

-- ===== lock =====

CREATE TABLE locks (
  namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  path              text NOT NULL,
  owner_agent_id    uuid NOT NULL REFERENCES agents(id),
  fence             bigint NOT NULL,
  expires_at        timestamptz NOT NULL,
  acquired_at       timestamptz NOT NULL,
  PRIMARY KEY (namespace_id, path)
);

CREATE INDEX locks_expires ON locks(expires_at);

-- Global monotonic fence sequence (ARCHITECTURE.md I15).
CREATE SEQUENCE lock_fence_seq AS bigint START 1;
