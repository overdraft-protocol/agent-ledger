-- Control-plane artifacts: schemas, transitions, policies.
-- Immutable once registered (enforced in application layer; DB permits deprecation updates).

CREATE TABLE schemas (
  namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  name              text NOT NULL,
  version           int  NOT NULL CHECK (version > 0),
  json_schema       jsonb NOT NULL,
  zod_source        text  NOT NULL,
  registered_at     timestamptz NOT NULL DEFAULT now(),
  registered_by     uuid NOT NULL REFERENCES agents(id),
  deprecated_at     timestamptz,
  PRIMARY KEY (namespace_id, name, version)
);

CREATE TABLE transitions (
  namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  name              text NOT NULL,
  version           int  NOT NULL CHECK (version > 0),
  params_schema     jsonb NOT NULL,
  asserts           jsonb NOT NULL,
  ops               jsonb NOT NULL,
  registered_at     timestamptz NOT NULL DEFAULT now(),
  registered_by     uuid NOT NULL REFERENCES agents(id),
  deprecated_at     timestamptz,
  PRIMARY KEY (namespace_id, name, version)
);

CREATE INDEX transitions_active
  ON transitions(namespace_id, name)
  WHERE deprecated_at IS NULL;

CREATE TABLE policies (
  namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  rule              jsonb NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid NOT NULL REFERENCES agents(id),
  PRIMARY KEY (namespace_id, id)
);
