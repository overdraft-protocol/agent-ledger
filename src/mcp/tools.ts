import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { requireCtx } from "./context.js";
import { wrap } from "./result.js";

import {
  createNamespace,
  listNamespacesForAgent,
  tombstoneNamespace,
} from "../control/namespace.js";
import {
  registerSchema,
  deprecateSchema,
} from "../control/schema.js";
import {
  registerTransition,
  deprecateTransition,
  getTransition,
} from "../control/transition.js";
import { listTransitions } from "../core/transition/registry.js";
import {
  createRole,
  updateRole,
  deleteRole,
  listRoles,
  getRole,
  grantRole,
  revokeRole,
  listRoleMembers,
  listMyRoles,
} from "../control/role.js";

import {
  requireRead,
  requireManageRoles,
  requireCanInvokeAsRequiredRole,
  type RoleCapability,
} from "../core/capabilities.js";
import { parseSchemaDsl, loadSchema, type SchemaDsl } from "../core/schema.js";
import { LedgerError } from "../core/errors.js";
import {
  readAudit,
  getAuditHead,
  verifyAudit,
} from "../core/audit.js";
import { docGet } from "../core/doc.js";
import { logRead, logGet } from "../core/log.js";
import { counterGet } from "../core/counter.js";
import { lockInspect } from "../core/lock.js";
import { blobPut, blobGet, blobExists } from "../core/blob.js";
import { invoke } from "../core/transition/invoke.js";
import type { Op } from "../core/transition/grammar.js";
import type { Kysely } from "kysely";
import type { Database } from "../storage/postgres/schema.js";

// All MCP tool registrations. Each handler recovers request-scoped
// CallContext via requireCtx() (ALS keyed), enforces authorization up-front
// using the role-based primitives in core/capabilities, then delegates to the
// domain module. Errors raised as LedgerError are surfaced to the client via
// the result wrapper in ./result.ts.

const UUID = z.string().uuid();
const AGENT_ID_OR_WILDCARD = z.union([UUID, z.literal("*")]);

const RoleCapInput = z.object({
  scope_kind: z.enum(["read", "invoke", "manage_roles"]),
  path_glob: z.string().min(1).max(512).nullable().optional(),
  transition_name: z.string().min(1).max(128).nullable().optional(),
});

function normaliseRoleCap(input: z.infer<typeof RoleCapInput>): RoleCapability {
  return {
    scope_kind: input.scope_kind,
    path_glob: input.path_glob ?? null,
    transition_name: input.transition_name ?? null,
  };
}

/**
 * Check the namespace exists and is not tombstoned. Used for read-only
 * discovery tools (transition.list/get) that any registered agent may call —
 * no role required, just like reading a public API spec.
 */
async function requireNamespaceVisible(
  db: Kysely<Database>,
  namespaceId: string,
): Promise<void> {
  const ns = await db
    .selectFrom("namespaces")
    .select("id")
    .where("id", "=", namespaceId)
    .where("tombstoned_at", "is", null)
    .executeTakeFirst();
  if (!ns) {
    throw new LedgerError("not_found", `namespace ${namespaceId} not found`);
  }
}

export function registerAllTools(server: McpServer): void {
  registerNamespaceTools(server);
  registerSchemaTools(server);
  registerRoleTools(server);
  registerTransitionTools(server);
  registerAuditTools(server);
  registerDataTools(server);
  registerBlobTools(server);
}

// ---------- namespace.* ----------

function registerNamespaceTools(server: McpServer): void {
  server.registerTool(
    "namespace.create",
    {
      description:
        "Create a new namespace owned by the caller. The owner has full " +
        "implicit access; everyone else gets access by being granted a role " +
        "(see role.create / role.grant). Hint: your next step is usually " +
        "role.create({ name: 'admin', capabilities: [{ scope_kind: 'manage_roles' }] }) " +
        "so you can delegate further administration without giving away ownership.",
      inputSchema: {
        alias: z.string().min(1).max(64).optional(),
      },
    },
    wrap("namespace.create", async (args) => {
      const ctx = requireCtx();
      const ns = await createNamespace(ctx.db, {
        ownerAgentId: ctx.agentId,
        alias: args.alias ?? null,
        requestId: ctx.requestId,
      });
      return { id: ns.id, alias: ns.alias, owner_agent_id: ns.owner_agent_id };
    }),
  );

  server.registerTool(
    "namespace.list",
    {
      description: "List namespaces the caller owns or holds at least one role in.",
      inputSchema: {},
    },
    wrap("namespace.list", async () => {
      const ctx = requireCtx();
      const rows = await listNamespacesForAgent(ctx.db, ctx.agentId);
      return rows.map((r) => ({
        id: r.id,
        alias: r.alias,
        owner_agent_id: r.owner_agent_id,
        tombstoned_at: r.tombstoned_at,
      }));
    }),
  );

  server.registerTool(
    "namespace.search",
    {
      description:
        "Search all active namespaces on the ledger (not just your own). " +
        "Optionally filter by alias substring. Use this to discover protocols " +
        "created by other agents so you can collaborate with them.",
      inputSchema: {
        alias: z.string().max(64).optional(),
        limit: z.number().int().positive().max(100).default(50),
      },
    },
    wrap("namespace.search", async (args) => {
      const ctx = requireCtx();
      let q = ctx.db
        .selectFrom("namespaces")
        .select(["id", "alias", "owner_agent_id", "created_at"])
        .where("tombstoned_at", "is", null);
      if (args.alias !== undefined) {
        q = q.where("alias", "like", `%${args.alias}%`);
      }
      const rows = await q.orderBy("created_at", "desc").limit(args.limit).execute();
      return rows.map((r) => ({
        id: r.id,
        alias: r.alias,
        owner_agent_id: r.owner_agent_id,
      }));
    }),
  );

  server.registerTool(
    "namespace.tombstone",
    {
      description: "Soft-delete (tombstone) a namespace. Owner-only.",
      inputSchema: { namespace_id: UUID },
    },
    wrap("namespace.tombstone", async (args) => {
      const ctx = requireCtx();
      const ns = await ctx.db
        .selectFrom("namespaces")
        .select(["owner_agent_id"])
        .where("id", "=", args.namespace_id)
        .executeTakeFirst();
      if (!ns || ns.owner_agent_id !== ctx.agentId) {
        throw new LedgerError("forbidden", "only the namespace owner may tombstone");
      }
      await tombstoneNamespace(ctx.db, {
        namespaceId: args.namespace_id,
        actorAgentId: ctx.agentId,
        requestId: ctx.requestId,
      });
      return { tombstoned: true };
    }),
  );
}

// ---------- schema.* ----------
//
// schema.register / schema.deprecate / schema.validate only — schemas are an
// internal artifact of the protocol designer. Agents discover types through
// the inlined `schema_dsl` returned by doc.get / log.head / log.read and
// transition.get's `outputs` field.

function registerSchemaTools(server: McpServer): void {
  server.registerTool(
    "schema.register",
    {
      description:
        "Register a new typed-primitive schema (name, version). Requires " +
        "manage_roles. Schemas are immutable once registered. Agents do not " +
        "need to call this directly — schemas are surfaced inlined wherever " +
        "they are needed.",
      inputSchema: {
        namespace_id: UUID,
        name: z.string().min(1).max(128),
        version: z.number().int().positive(),
        dsl: z.unknown(),
      },
    },
    wrap("schema.register", async (args) => {
      const ctx = requireCtx();
      const r = await registerSchema(ctx.db, {
        namespaceId: args.namespace_id,
        registeredBy: ctx.agentId,
        requestId: ctx.requestId,
        name: args.name,
        version: args.version,
        dsl: args.dsl,
      });
      return r;
    }),
  );

  server.registerTool(
    "schema.deprecate",
    {
      description:
        "Mark a schema version deprecated. New instances refused; history kept. " +
        "Requires manage_roles.",
      inputSchema: {
        namespace_id: UUID,
        name: z.string().min(1).max(128),
        version: z.number().int().positive(),
      },
    },
    wrap("schema.deprecate", async (args) => {
      const ctx = requireCtx();
      await deprecateSchema(ctx.db, {
        namespaceId: args.namespace_id,
        actorAgentId: ctx.agentId,
        requestId: ctx.requestId,
        name: args.name,
        version: args.version,
      });
      return { deprecated: true };
    }),
  );

  server.registerTool(
    "schema.validate",
    {
      description:
        "Validate a schema DSL object without registering it. Use this to " +
        "test your DSL before calling schema.register. Returns " +
        "{ valid: true } or { valid: false, error: string }. No namespace " +
        "or capability required.",
      inputSchema: { dsl: z.unknown() },
    },
    wrap("schema.validate", async (args) => {
      try {
        parseSchemaDsl(args.dsl);
        return { valid: true };
      } catch (e) {
        if (e instanceof LedgerError) {
          const result: { valid: false; error: string; details?: Record<string, unknown> } = {
            valid: false,
            error: e.message,
          };
          if (e.details !== undefined) result.details = e.details;
          return result;
        }
        throw e;
      }
    }),
  );
}

// ---------- role.* ----------

function registerRoleTools(server: McpServer): void {
  server.registerTool(
    "role.create",
    {
      description:
        "Create a new role in a namespace. Requires manage_roles. Caller " +
        "may only grant capabilities they themselves currently hold (no " +
        "privilege escalation). Capability shapes: " +
        "{scope_kind:'read', path_glob}, {scope_kind:'invoke', transition_name}, " +
        "{scope_kind:'manage_roles'}. Use transition_name='*' to permit any " +
        "transition.",
      inputSchema: {
        namespace_id: UUID,
        name: z.string().min(1).max(128),
        description: z.string().max(4096).default(""),
        capabilities: z.array(RoleCapInput).default([]),
      },
    },
    wrap("role.create", async (args) => {
      const ctx = requireCtx();
      return await createRole(ctx.db, {
        namespaceId: args.namespace_id,
        actorAgentId: ctx.agentId,
        requestId: ctx.requestId,
        name: args.name,
        description: args.description,
        capabilities: args.capabilities.map(normaliseRoleCap),
      });
    }),
  );

  server.registerTool(
    "role.update",
    {
      description:
        "Update a role's description and/or replace its capability set. " +
        "Requires manage_roles. No-escalation rule applies to capabilities.",
      inputSchema: {
        namespace_id: UUID,
        name: z.string().min(1).max(128),
        description: z.string().max(4096).optional(),
        capabilities: z.array(RoleCapInput).optional(),
      },
    },
    wrap("role.update", async (args) => {
      const ctx = requireCtx();
      const input: Parameters<typeof updateRole>[1] = {
        namespaceId: args.namespace_id,
        actorAgentId: ctx.agentId,
        requestId: ctx.requestId,
        name: args.name,
      };
      if (args.description !== undefined) input.description = args.description;
      if (args.capabilities !== undefined) {
        input.capabilities = args.capabilities.map(normaliseRoleCap);
      }
      return await updateRole(ctx.db, input);
    }),
  );

  server.registerTool(
    "role.delete",
    {
      description:
        "Delete a role. Requires manage_roles. Refused if the role is " +
        "referenced as `required_role` by any non-deprecated transition.",
      inputSchema: {
        namespace_id: UUID,
        name: z.string().min(1).max(128),
      },
    },
    wrap("role.delete", async (args) => {
      const ctx = requireCtx();
      await deleteRole(ctx.db, {
        namespaceId: args.namespace_id,
        actorAgentId: ctx.agentId,
        requestId: ctx.requestId,
        name: args.name,
      });
      return { deleted: true };
    }),
  );

  server.registerTool(
    "role.list",
    {
      description:
        "List all roles in a namespace. Visible to anyone who can see the " +
        "namespace (no role required) so agents can discover what roles " +
        "they could request to join.",
      inputSchema: { namespace_id: UUID },
    },
    wrap("role.list", async (args) => {
      const ctx = requireCtx();
      await requireNamespaceVisible(ctx.db, args.namespace_id);
      return await listRoles(ctx.db, args.namespace_id);
    }),
  );

  server.registerTool(
    "role.get",
    {
      description:
        "Fetch a role's full capability set. Visible to anyone who can see " +
        "the namespace.",
      inputSchema: {
        namespace_id: UUID,
        name: z.string().min(1).max(128),
      },
    },
    wrap("role.get", async (args) => {
      const ctx = requireCtx();
      await requireNamespaceVisible(ctx.db, args.namespace_id);
      return await getRole(ctx.db, args.namespace_id, args.name);
    }),
  );

  server.registerTool(
    "role.grant",
    {
      description:
        "Grant a role to an agent. Requires manage_roles. Pass agent_id='*' " +
        "to grant the role to every authenticated agent (wildcard / guest " +
        "membership).",
      inputSchema: {
        namespace_id: UUID,
        role: z.string().min(1).max(128),
        agent_id: AGENT_ID_OR_WILDCARD,
      },
    },
    wrap("role.grant", async (args) => {
      const ctx = requireCtx();
      await grantRole(ctx.db, {
        namespaceId: args.namespace_id,
        actorAgentId: ctx.agentId,
        requestId: ctx.requestId,
        role: args.role,
        agentId: args.agent_id,
      });
      return { granted: true };
    }),
  );

  server.registerTool(
    "role.revoke",
    {
      description: "Revoke a role membership from an agent. Requires manage_roles.",
      inputSchema: {
        namespace_id: UUID,
        role: z.string().min(1).max(128),
        agent_id: AGENT_ID_OR_WILDCARD,
      },
    },
    wrap("role.revoke", async (args) => {
      const ctx = requireCtx();
      await revokeRole(ctx.db, {
        namespaceId: args.namespace_id,
        actorAgentId: ctx.agentId,
        requestId: ctx.requestId,
        role: args.role,
        agentId: args.agent_id,
      });
      return { revoked: true };
    }),
  );

  server.registerTool(
    "role.list_members",
    {
      description: "List members of a role. Requires manage_roles.",
      inputSchema: {
        namespace_id: UUID,
        role: z.string().min(1).max(128),
      },
    },
    wrap("role.list_members", async (args) => {
      const ctx = requireCtx();
      await requireManageRoles(ctx.db, args.namespace_id, ctx.agentId);
      return await listRoleMembers(ctx.db, args.namespace_id, args.role);
    }),
  );

  server.registerTool(
    "role.list_my_roles",
    {
      description:
        "List the roles the caller currently holds in a namespace " +
        "(direct memberships and wildcard grants).",
      inputSchema: { namespace_id: UUID },
    },
    wrap("role.list_my_roles", async (args) => {
      const ctx = requireCtx();
      return await listMyRoles(ctx.db, args.namespace_id, ctx.agentId);
    }),
  );
}

// ---------- transition.* ----------

async function buildTransitionOutputs(
  db: Kysely<Database>,
  namespaceId: string,
  ops: Op[],
): Promise<Array<{
  kind: "doc.put" | "log.create";
  schema_name: string;
  schema_version: number;
  schema_dsl: SchemaDsl;
}>> {
  const seen = new Set<string>();
  const out: Array<{
    kind: "doc.put" | "log.create";
    schema_name: string;
    schema_version: number;
    schema_dsl: SchemaDsl;
  }> = [];
  for (const op of ops) {
    if (op.o !== "doc.put" && op.o !== "log.create") continue;
    const key = `${op.o}:${op.schema_name}@${op.schema_version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const { dsl } = await loadSchema(db, namespaceId, op.schema_name, op.schema_version);
      out.push({
        kind: op.o,
        schema_name: op.schema_name,
        schema_version: op.schema_version,
        schema_dsl: dsl,
      });
    } catch {
      // If a referenced schema is somehow missing, skip rather than blocking
      // discovery. transition.register validates referenced schemas at write
      // time so this is only reachable in pathological hand-edited states.
    }
  }
  return out;
}

function registerTransitionTools(server: McpServer): void {
  server.registerTool(
    "transition.register",
    {
      description:
        "Register a transition definition (params_schema, asserts, ops). " +
        "Requires manage_roles. " +
        "`description` is shown to discovering agents via transition.get; " +
        "`required_role` names the role an agent must hold to invoke this " +
        "transition (null = owner-only).",
      inputSchema: {
        namespace_id: UUID,
        name: z.string().min(1).max(128),
        version: z.number().int().positive(),
        params_schema: z.unknown(),
        asserts: z.unknown(),
        ops: z.unknown(),
        description: z.string().max(4096).default(""),
        required_role: z.string().min(1).max(128).nullable().default(null),
      },
    },
    wrap("transition.register", async (args) => {
      const ctx = requireCtx();
      await registerTransition(ctx.db, {
        namespaceId: args.namespace_id,
        actorAgentId: ctx.agentId,
        requestId: ctx.requestId,
        name: args.name,
        version: args.version,
        params_schema: args.params_schema,
        asserts: args.asserts,
        ops: args.ops,
        description: args.description,
        required_role: args.required_role,
      });
      return { registered: true };
    }),
  );

  server.registerTool(
    "transition.list",
    {
      description:
        "List registered transitions in a namespace. Each entry includes " +
        "`description` and `required_role` so agents can decide which to " +
        "invoke. Visible to anyone who can see the namespace.",
      inputSchema: {
        namespace_id: UUID,
        include_deprecated: z.boolean().default(false),
      },
    },
    wrap("transition.list", async (args) => {
      const ctx = requireCtx();
      await requireNamespaceVisible(ctx.db, args.namespace_id);
      return await listTransitions(ctx.db, args.namespace_id, args.include_deprecated);
    }),
  );

  server.registerTool(
    "transition.get",
    {
      description:
        "Fetch a transition's full definition (params_schema, description, " +
        "required_role) and its declared output schemas. Visible to anyone " +
        "who can see the namespace — this is the public interface.",
      inputSchema: {
        namespace_id: UUID,
        name: z.string().min(1).max(128),
        version: z.number().int().positive(),
      },
    },
    wrap("transition.get", async (args) => {
      const ctx = requireCtx();
      await requireNamespaceVisible(ctx.db, args.namespace_id);
      const t = await getTransition(ctx.db, args.namespace_id, args.name, args.version);
      const outputs = await buildTransitionOutputs(ctx.db, args.namespace_id, t.def.ops);
      return {
        name: t.name,
        version: t.version,
        description: t.description,
        required_role: t.required_role,
        deprecated: t.deprecated,
        registered_at: t.registered_at,
        registered_by: t.registered_by,
        params_schema: t.def.params_schema,
        outputs,
      };
    }),
  );

  server.registerTool(
    "transition.deprecate",
    {
      description:
        "Mark a transition version deprecated. Invocation refused; history " +
        "kept. Requires manage_roles.",
      inputSchema: {
        namespace_id: UUID,
        name: z.string().min(1).max(128),
        version: z.number().int().positive(),
      },
    },
    wrap("transition.deprecate", async (args) => {
      const ctx = requireCtx();
      await deprecateTransition(ctx.db, {
        namespaceId: args.namespace_id,
        actorAgentId: ctx.agentId,
        requestId: ctx.requestId,
        name: args.name,
        version: args.version,
      });
      return { deprecated: true };
    }),
  );
}

// ---------- audit.* ----------

function registerAuditTools(server: McpServer): void {
  server.registerTool(
    "audit.read",
    {
      description: "Read audit entries from a namespace starting at from_seq. Requires manage_roles.",
      inputSchema: {
        namespace_id: UUID,
        from_seq: z.string().regex(/^\d+$/),
        limit: z.number().int().positive().max(1000).default(100),
      },
    },
    wrap("audit.read", async (args) => {
      const ctx = requireCtx();
      await requireManageRoles(ctx.db, args.namespace_id, ctx.agentId);
      const rows = await readAudit(ctx.db, args.namespace_id, BigInt(args.from_seq), args.limit);
      return rows.map((r) => ({
        seq: r.seq,
        created_at: r.created_at,
        actor_agent_id: r.actor_agent_id,
        request_id: r.request_id,
        plane: r.plane,
        kind: r.kind,
        payload: r.payload,
        prev_hash: r.prev_hash.toString("hex"),
        chain_hash: r.chain_hash.toString("hex"),
      }));
    }),
  );

  server.registerTool(
    "audit.head",
    {
      description: "Fetch the current audit head (latest seq + chain hash). Requires manage_roles.",
      inputSchema: { namespace_id: UUID },
    },
    wrap("audit.head", async (args) => {
      const ctx = requireCtx();
      await requireManageRoles(ctx.db, args.namespace_id, ctx.agentId);
      const h = await getAuditHead(ctx.db, args.namespace_id);
      if (!h) return null;
      return { seq: h.seq.toString(), chain_hash: h.chainHash.toString("hex") };
    }),
  );

  server.registerTool(
    "audit.verify",
    {
      description: "Verify the audit chain over [from_seq, to_seq]. Requires manage_roles.",
      inputSchema: {
        namespace_id: UUID,
        from_seq: z.string().regex(/^\d+$/),
        to_seq: z.string().regex(/^\d+$/),
      },
    },
    wrap("audit.verify", async (args) => {
      const ctx = requireCtx();
      await requireManageRoles(ctx.db, args.namespace_id, ctx.agentId);
      const r = await verifyAudit(
        ctx.db,
        args.namespace_id,
        BigInt(args.from_seq),
        BigInt(args.to_seq),
      );
      return {
        first_divergent_seq: r.firstDivergentSeq ? r.firstDivergentSeq.toString() : null,
        consistent: r.firstDivergentSeq === null,
      };
    }),
  );
}

// ---------- data plane ----------

function registerDataTools(server: McpServer): void {
  server.registerTool(
    "tx.invoke",
    {
      description:
        "Invoke a registered transition atomically. Caller must hold the " +
        "transition's `required_role` (or be the namespace owner). Use " +
        "transition.get to discover what role is needed.",
      inputSchema: {
        namespace_id: UUID,
        transition_name: z.string().min(1).max(128),
        transition_version: z.number().int().positive().optional(),
        params: z.record(z.unknown()).default({}),
        idempotency_key: z.string().min(8).max(128),
      },
    },
    wrap("tx.invoke", async (args) => {
      const ctx = requireCtx();
      // Resolve the active transition to find its required_role. We deliberately
      // do this before invoke() so unauthorised callers fail fast with the
      // role-aware error rather than the generic capability_missing one.
      const row = await ctx.db
        .selectFrom("transitions")
        .select(["required_role", "deprecated_at"])
        .where("namespace_id", "=", args.namespace_id)
        .where("name", "=", args.transition_name)
        .where((eb) => {
          if (args.transition_version !== undefined) {
            return eb("version", "=", args.transition_version);
          }
          return eb("deprecated_at", "is", null);
        })
        .orderBy("version", "desc")
        .limit(1)
        .executeTakeFirst();
      if (!row) {
        throw new LedgerError("transition_unavailable",
          `transition ${args.transition_name} not registered`);
      }
      await requireCanInvokeAsRequiredRole(
        ctx.db,
        args.namespace_id,
        ctx.agentId,
        args.transition_name,
        row.required_role,
      );
      const input: Parameters<typeof invoke>[1] = {
        namespaceId: args.namespace_id,
        agentId: ctx.agentId,
        requestId: ctx.requestId,
        transitionName: args.transition_name,
        params: args.params,
        idempotencyKey: args.idempotency_key,
      };
      if (args.transition_version !== undefined) input.transitionVersion = args.transition_version;
      return await invoke(ctx.db, input);
    }),
  );

  server.registerTool(
    "doc.get",
    {
      description:
        "Fetch a document by path. Response includes the document's bound " +
        "schema_dsl so the caller can interpret the value without a separate " +
        "schema lookup.",
      inputSchema: {
        namespace_id: UUID,
        path: z.string().min(1).max(512),
      },
    },
    wrap("doc.get", async (args) => {
      const ctx = requireCtx();
      await requireRead(ctx.db, args.namespace_id, ctx.agentId, args.path);
      const doc = await docGet(ctx.db, args.namespace_id, args.path);
      if (!doc) return null;
      let schema_dsl: SchemaDsl | null = null;
      try {
        const { dsl } = await loadSchema(ctx.db, args.namespace_id, doc.schema_name, doc.schema_version);
        schema_dsl = dsl;
      } catch {
        // Schema rows are immutable, but defensive: if the binding is broken
        // surface the doc anyway with a null schema_dsl.
      }
      return { ...doc, schema_dsl };
    }),
  );

  server.registerTool(
    "log.read",
    {
      description:
        "Read entries from a log starting at from_offset. Response includes " +
        "the log's bound schema_dsl so the caller can interpret entries.",
      inputSchema: {
        namespace_id: UUID,
        log_id: z.string().min(1).max(128),
        from_offset: z.string().regex(/^\d+$/),
        limit: z.number().int().positive().max(1000).default(100),
      },
    },
    wrap("log.read", async (args) => {
      const ctx = requireCtx();
      await requireRead(ctx.db, args.namespace_id, ctx.agentId, args.log_id);
      const entries = await logRead(
        ctx.db, args.namespace_id, args.log_id, BigInt(args.from_offset), args.limit,
      );
      const head = await logGet(ctx.db, args.namespace_id, args.log_id);
      let schema_dsl: SchemaDsl | null = null;
      let schema_name: string | null = null;
      let schema_version: number | null = null;
      if (head) {
        schema_name = head.schema_name;
        schema_version = head.schema_version;
        try {
          const { dsl } = await loadSchema(ctx.db, args.namespace_id, head.schema_name, head.schema_version);
          schema_dsl = dsl;
        } catch {
          /* fall through */
        }
      }
      return { entries, schema_name, schema_version, schema_dsl };
    }),
  );

  server.registerTool(
    "log.head",
    {
      description:
        "Fetch log metadata (schema binding, next offset, and inlined schema_dsl).",
      inputSchema: {
        namespace_id: UUID,
        log_id: z.string().min(1).max(128),
      },
    },
    wrap("log.head", async (args) => {
      const ctx = requireCtx();
      await requireRead(ctx.db, args.namespace_id, ctx.agentId, args.log_id);
      const head = await logGet(ctx.db, args.namespace_id, args.log_id);
      if (!head) return null;
      let schema_dsl: SchemaDsl | null = null;
      try {
        const { dsl } = await loadSchema(ctx.db, args.namespace_id, head.schema_name, head.schema_version);
        schema_dsl = dsl;
      } catch {
        /* fall through */
      }
      return { ...head, schema_dsl };
    }),
  );

  server.registerTool(
    "counter.get",
    {
      description: "Fetch a counter by path.",
      inputSchema: {
        namespace_id: UUID,
        path: z.string().min(1).max(512),
      },
    },
    wrap("counter.get", async (args) => {
      const ctx = requireCtx();
      await requireRead(ctx.db, args.namespace_id, ctx.agentId, args.path);
      return await counterGet(ctx.db, args.namespace_id, args.path);
    }),
  );

  server.registerTool(
    "lock.inspect",
    {
      description: "Inspect a lock by path.",
      inputSchema: {
        namespace_id: UUID,
        path: z.string().min(1).max(512),
      },
    },
    wrap("lock.inspect", async (args) => {
      const ctx = requireCtx();
      await requireRead(ctx.db, args.namespace_id, ctx.agentId, args.path);
      return await lockInspect(ctx.db, args.namespace_id, args.path);
    }),
  );
}

// ---------- blob.* ----------

function registerBlobTools(server: McpServer): void {
  server.registerTool(
    "blob.put",
    {
      description:
        "Store a blob (base64-encoded). Server computes sha256 and returns " +
        "it. Requires manage_roles.",
      inputSchema: {
        namespace_id: UUID,
        content_base64: z.string().min(1),
        content_type: z.string().max(128).optional(),
      },
    },
    wrap("blob.put", async (args) => {
      const ctx = requireCtx();
      await requireManageRoles(ctx.db, args.namespace_id, ctx.agentId);
      const bytes = Buffer.from(args.content_base64, "base64");
      return await blobPut(ctx.db, bytes, args.content_type ?? null);
    }),
  );

  server.registerTool(
    "blob.get",
    {
      description:
        "Fetch a blob by sha256 (hex). Returns base64-encoded content. " +
        "Requires manage_roles.",
      inputSchema: {
        namespace_id: UUID,
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      },
    },
    wrap("blob.get", async (args) => {
      const ctx = requireCtx();
      await requireManageRoles(ctx.db, args.namespace_id, ctx.agentId);
      const r = await blobGet(ctx.db, args.sha256);
      return {
        sha256: args.sha256,
        size: r.size,
        content_type: r.contentType,
        content_base64: r.bytes.toString("base64"),
      };
    }),
  );

  server.registerTool(
    "blob.exists",
    {
      description: "Check if a blob exists by sha256 (hex). Requires manage_roles.",
      inputSchema: {
        namespace_id: UUID,
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      },
    },
    wrap("blob.exists", async (args) => {
      const ctx = requireCtx();
      await requireManageRoles(ctx.db, args.namespace_id, ctx.agentId);
      const exists = await blobExists(ctx.db, args.sha256);
      return { exists };
    }),
  );
}
