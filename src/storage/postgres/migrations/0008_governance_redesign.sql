-- Governance redesign: role-based access control.
--
-- Drops the implicit owner/admin/agent tier system in favour of a fully
-- role-driven model where the only fixed primitives are the namespace owner
-- and wildcard role memberships (agent_id = '*').
--
-- Removed:
--   * admins        (the admin roster — replaced by roles holding `manage_roles`)
--   * capabilities  (per-agent grants — replaced by role_capabilities + role_members)
--   * policies      (deny layer was never wired in; superseded by roles)
--
-- Added:
--   * roles               — namespace-scoped named bundles of capabilities
--   * role_capabilities   — what a role allows
--   * role_members        — which agents hold a role (or '*' for all)
--
-- Augmented:
--   * transitions.description   — human/agent-readable summary of the operation
--   * transitions.required_role — role name needed to invoke (null = owner-only)
--
-- Clean break: any pre-existing dev data in admins/capabilities/policies is
-- discarded. CASCADE only removes the dropped tables themselves; namespace
-- and agent rows are untouched.

DROP TABLE IF EXISTS admins CASCADE;
DROP TABLE IF EXISTS capabilities CASCADE;
DROP TABLE IF EXISTS policies CASCADE;

-- A role is a named bundle of capabilities, scoped to a namespace.
-- Names are unique within a namespace; cross-namespace role names may collide
-- because roles do not exist outside their owning namespace.
CREATE TABLE roles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace_id    uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL REFERENCES agents(id),
  UNIQUE (namespace_id, name),
  CHECK (name ~ '^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$')
);

CREATE INDEX roles_namespace ON roles(namespace_id);

-- Capabilities granted to a role. Mirrors the old `capabilities` table's CHECK
-- discipline but adds `manage_roles` as a third scope kind. `manage_roles` is
-- the meta-capability that lets a role create/modify/grant other roles —
-- bounded by the no-escalation rule enforced in the application layer.
--
--   scope_kind='read'         -> path_glob set, transition_name null
--   scope_kind='invoke'       -> transition_name set, path_glob null
--   scope_kind='manage_roles' -> both null
CREATE TABLE role_capabilities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id         uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  scope_kind      text NOT NULL CHECK (scope_kind IN ('read','invoke','manage_roles')),
  path_glob       text,
  transition_name text,
  CHECK (
    (scope_kind = 'read'         AND path_glob IS NOT NULL AND transition_name IS NULL) OR
    (scope_kind = 'invoke'       AND transition_name IS NOT NULL AND path_glob IS NULL) OR
    (scope_kind = 'manage_roles' AND path_glob IS NULL AND transition_name IS NULL)
  )
);

CREATE INDEX role_capabilities_role         ON role_capabilities(role_id);
CREATE INDEX role_capabilities_scope        ON role_capabilities(scope_kind);
CREATE INDEX role_capabilities_transition   ON role_capabilities(transition_name) WHERE transition_name IS NOT NULL;

-- Role membership. agent_id is text (not uuid) so we can store the literal '*'
-- sentinel meaning "every authenticated agent". Real agent UUIDs are stored
-- as their canonical text form. The application layer is responsible for
-- validating agent_id existence when it isn't '*'.
CREATE TABLE role_members (
  role_id         uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  agent_id        text NOT NULL,
  granted_by      uuid NOT NULL REFERENCES agents(id),
  granted_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, agent_id),
  CHECK (agent_id = '*' OR agent_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);

CREATE INDEX role_members_agent ON role_members(agent_id);

-- Augment the transitions table with self-describing metadata so agents can
-- discover what a transition does and what role they need to invoke it from
-- transition.list / transition.get alone.
ALTER TABLE transitions
  ADD COLUMN description   text NOT NULL DEFAULT '',
  ADD COLUMN required_role text;

-- required_role is application-validated (must reference an existing role in
-- the same namespace at registration time). We deliberately do NOT add a FK:
-- a role may be deleted/renamed later and historical transitions should not
-- prevent that — they simply become uninvokable until the operator either
-- restores the role or registers a new transition version.
