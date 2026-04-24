import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "../../src/storage/postgres/schema.js";
import { ensureSchema, seedAgent, seedNamespace, seedRole, shutdown } from "../helpers/db.js";

import {
  createRole,
  deleteRole,
  getRole,
  grantRole,
  listMyRoles,
  listRoles,
  listRoleMembers,
  revokeRole,
  updateRole,
} from "../../src/control/role.js";
import {
  registerTransition,
} from "../../src/control/transition.js";
import {
  registerSchema,
} from "../../src/control/schema.js";
import {
  canInvoke,
  canRead,
  hasManageRoles,
  requireCanInvokeAsRequiredRole,
  resolveRoles,
} from "../../src/core/capabilities.js";
import { LedgerError } from "../../src/core/errors.js";

// Tests for the role-based governance model. Cover the lifecycle, no-escalation
// rule, wildcard membership, required_role enforcement on tx.invoke gating,
// and the manage_roles meta-capability.

describe("smoke: governance (roles)", () => {
  let db: Kysely<Database>;

  beforeAll(async () => { db = await ensureSchema(); });
  afterAll(async () => { await shutdown(); });

  it("role lifecycle: create / get / list / update / delete (owner is implicit manage_roles)", async () => {
    const ns = await seedNamespace(db);
    await createRole(db, {
      namespaceId: ns.id,
      actorAgentId: ns.owner.id,
      requestId: crypto.randomUUID(),
      name: "viewer",
      description: "read-only",
      capabilities: [{ scope_kind: "read", path_glob: "entries/**", transition_name: null }],
    });

    const list = await listRoles(db, ns.id);
    expect(list.map((r) => r.name)).toContain("viewer");

    const detail = await getRole(db, ns.id, "viewer");
    expect(detail.capabilities).toEqual([
      { scope_kind: "read", path_glob: "entries/**", transition_name: null },
    ]);

    await updateRole(db, {
      namespaceId: ns.id,
      actorAgentId: ns.owner.id,
      requestId: crypto.randomUUID(),
      name: "viewer",
      description: "still read-only",
      capabilities: [
        { scope_kind: "read", path_glob: "entries/**", transition_name: null },
        { scope_kind: "read", path_glob: "audit/**", transition_name: null },
      ],
    });
    const updated = await getRole(db, ns.id, "viewer");
    expect(updated.description).toBe("still read-only");
    expect(updated.capabilities.length).toBe(2);

    await deleteRole(db, {
      namespaceId: ns.id,
      actorAgentId: ns.owner.id,
      requestId: crypto.randomUUID(),
      name: "viewer",
    });
    await expect(getRole(db, ns.id, "viewer")).rejects.toBeInstanceOf(LedgerError);
  });

  it("manage_roles delegate cannot escalate to capabilities they don't hold", async () => {
    const ns = await seedNamespace(db);
    const delegate = await seedAgent(db);

    // Owner creates a 'admin' role with manage_roles + invoke:foo only,
    // then grants it to the delegate.
    await seedRole(db, {
      namespaceId: ns.id,
      createdBy: ns.owner.id,
      name: "admin",
      capabilities: [
        { scope_kind: "manage_roles" },
        { scope_kind: "invoke", transition_name: "foo" },
      ],
      members: [{ agentId: delegate.id, grantedBy: ns.owner.id }],
    });

    expect(await hasManageRoles(db, ns.id, delegate.id)).toBe(true);

    // Delegate tries to create a role that grants invoke:bar — must fail.
    await expect(createRole(db, {
      namespaceId: ns.id,
      actorAgentId: delegate.id,
      requestId: crypto.randomUUID(),
      name: "evil",
      description: "",
      capabilities: [{ scope_kind: "invoke", transition_name: "bar", path_glob: null }],
    })).rejects.toMatchObject({ code: "forbidden" });

    // But creating a role that grants invoke:foo (which they hold) is fine.
    await createRole(db, {
      namespaceId: ns.id,
      actorAgentId: delegate.id,
      requestId: crypto.randomUUID(),
      name: "scoped",
      description: "",
      capabilities: [{ scope_kind: "invoke", transition_name: "foo", path_glob: null }],
    });
    const scoped = await getRole(db, ns.id, "scoped");
    expect(scoped.capabilities).toEqual([
      { scope_kind: "invoke", transition_name: "foo", path_glob: null },
    ]);
  });

  it("wildcard membership grants the role to every authenticated agent", async () => {
    const ns = await seedNamespace(db);
    const stranger = await seedAgent(db);

    await seedRole(db, {
      namespaceId: ns.id,
      createdBy: ns.owner.id,
      name: "guest",
      capabilities: [
        { scope_kind: "invoke", transition_name: "sign" },
        { scope_kind: "read",   path_glob: "entries/**" },
      ],
      members: [{ agentId: "*", grantedBy: ns.owner.id }],
    });

    const roles = await resolveRoles(db, ns.id, stranger.id);
    expect(roles.map((r) => r.name)).toContain("guest");
    expect(await canInvoke(db, ns.id, stranger.id, "sign")).toBe(true);
    expect(await canRead(db, ns.id, stranger.id, "entries/2025")).toBe(true);
    expect(await canRead(db, ns.id, stranger.id, "private/secret")).toBe(false);

    const my = await listMyRoles(db, ns.id, stranger.id);
    expect(my).toEqual([{ name: "guest", via: "wildcard" }]);
  });

  it("grant / revoke / list_members happy path", async () => {
    const ns = await seedNamespace(db);
    const a = await seedAgent(db);

    await seedRole(db, {
      namespaceId: ns.id,
      createdBy: ns.owner.id,
      name: "writer",
      capabilities: [{ scope_kind: "invoke", transition_name: "sign" }],
    });

    await grantRole(db, {
      namespaceId: ns.id,
      actorAgentId: ns.owner.id,
      requestId: crypto.randomUUID(),
      role: "writer",
      agentId: a.id,
    });

    const members = await listRoleMembers(db, ns.id, "writer");
    expect(members.map((m) => m.agent_id)).toContain(a.id);

    await revokeRole(db, {
      namespaceId: ns.id,
      actorAgentId: ns.owner.id,
      requestId: crypto.randomUUID(),
      role: "writer",
      agentId: a.id,
    });
    const after = await listRoleMembers(db, ns.id, "writer");
    expect(after.map((m) => m.agent_id)).not.toContain(a.id);
  });

  it("required_role gates tx.invoke: owner ok, member ok, stranger rejected, null = owner-only", async () => {
    const ns = await seedNamespace(db);
    const member = await seedAgent(db);
    const stranger = await seedAgent(db);

    await registerSchema(db, {
      namespaceId: ns.id,
      registeredBy: ns.owner.id,
      requestId: crypto.randomUUID(),
      name: "msg", version: 1,
      dsl: { t: "object", props: { txt: { t: "string" } } },
    });

    await seedRole(db, {
      namespaceId: ns.id,
      createdBy: ns.owner.id,
      name: "speaker",
      capabilities: [],
      members: [{ agentId: member.id, grantedBy: ns.owner.id }],
    });

    await registerTransition(db, {
      namespaceId: ns.id,
      actorAgentId: ns.owner.id,
      requestId: crypto.randomUUID(),
      name: "speak", version: 1,
      description: "Anyone holding 'speaker' may emit a message.",
      required_role: "speaker",
      params_schema: { t: "object", props: {} },
      asserts: [],
      ops: [{ o: "log.create", log_id: "msgs", schema_name: "msg" }],
    });

    await expect(requireCanInvokeAsRequiredRole(db, ns.id, ns.owner.id, "speak", "speaker")).resolves.toBeUndefined();
    await expect(requireCanInvokeAsRequiredRole(db, ns.id, member.id, "speak", "speaker")).resolves.toBeUndefined();
    await expect(requireCanInvokeAsRequiredRole(db, ns.id, stranger.id, "speak", "speaker"))
      .rejects.toMatchObject({ code: "capability_missing" });

    // null required_role → owner-only.
    await expect(requireCanInvokeAsRequiredRole(db, ns.id, ns.owner.id, "secret", null)).resolves.toBeUndefined();
    await expect(requireCanInvokeAsRequiredRole(db, ns.id, member.id, "secret", null))
      .rejects.toMatchObject({ code: "capability_missing" });
  });

  it("role.delete is refused while a non-deprecated transition still references it", async () => {
    const ns = await seedNamespace(db);

    await registerSchema(db, {
      namespaceId: ns.id,
      registeredBy: ns.owner.id,
      requestId: crypto.randomUUID(),
      name: "msg", version: 1,
      dsl: { t: "object", props: { txt: { t: "string" } } },
    });

    await createRole(db, {
      namespaceId: ns.id,
      actorAgentId: ns.owner.id,
      requestId: crypto.randomUUID(),
      name: "speaker",
      description: "",
      capabilities: [],
    });

    await registerTransition(db, {
      namespaceId: ns.id,
      actorAgentId: ns.owner.id,
      requestId: crypto.randomUUID(),
      name: "speak", version: 1,
      description: "",
      required_role: "speaker",
      params_schema: { t: "object", props: {} },
      asserts: [],
      ops: [{ o: "log.create", log_id: "msgs", schema_name: "msg" }],
    });

    await expect(deleteRole(db, {
      namespaceId: ns.id,
      actorAgentId: ns.owner.id,
      requestId: crypto.randomUUID(),
      name: "speaker",
    })).rejects.toMatchObject({ code: "conflict" });
  });

  it("transition.register rejects required_role that doesn't exist in the namespace", async () => {
    const ns = await seedNamespace(db);
    await registerSchema(db, {
      namespaceId: ns.id,
      registeredBy: ns.owner.id,
      requestId: crypto.randomUUID(),
      name: "msg", version: 1,
      dsl: { t: "object", props: { txt: { t: "string" } } },
    });
    await expect(registerTransition(db, {
      namespaceId: ns.id,
      actorAgentId: ns.owner.id,
      requestId: crypto.randomUUID(),
      name: "speak", version: 1,
      description: "",
      required_role: "nonexistent",
      params_schema: { t: "object", props: {} },
      asserts: [],
      ops: [{ o: "log.create", log_id: "msgs", schema_name: "msg" }],
    })).rejects.toMatchObject({ code: "not_found" });
  });
});
