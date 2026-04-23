-- Identity and governance tables.

CREATE TABLE agents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oauth_subject     text UNIQUE NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  disabled_at       timestamptz
);

CREATE TABLE namespaces (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_agent_id    uuid NOT NULL REFERENCES agents(id),
  alias             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  tombstoned_at     timestamptz,
  UNIQUE (owner_agent_id, alias)
);

CREATE INDEX namespaces_owner ON namespaces(owner_agent_id);

CREATE TABLE admins (
  namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  agent_id          uuid NOT NULL REFERENCES agents(id),
  granted_by        uuid NOT NULL REFERENCES agents(id),
  granted_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace_id, agent_id)
);

CREATE INDEX admins_agent ON admins(agent_id);

CREATE TABLE capabilities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  agent_id          uuid NOT NULL REFERENCES agents(id),
  scope_kind        text NOT NULL CHECK (scope_kind IN ('read','invoke')),
  path_glob         text,
  transition_name   text,
  granted_by        uuid NOT NULL REFERENCES agents(id),
  granted_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz,
  -- A read capability has a path; an invoke capability has a transition name. Not both.
  CHECK (
    (scope_kind = 'read'   AND path_glob IS NOT NULL AND transition_name IS NULL) OR
    (scope_kind = 'invoke' AND transition_name IS NOT NULL AND path_glob IS NULL)
  )
);

CREATE INDEX capabilities_agent_ns ON capabilities(agent_id, namespace_id);
CREATE INDEX capabilities_granted_by ON capabilities(granted_by);
CREATE INDEX capabilities_expires ON capabilities(expires_at) WHERE expires_at IS NOT NULL;
