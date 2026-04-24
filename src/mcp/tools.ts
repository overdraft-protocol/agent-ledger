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
  listSchemas,
  getSchema,
} from "../control/schema.js";
import {
  registerTransition,
  deprecateTransition,
  getTransition,
} from "../control/transition.js";
import { listTransitions } from "../core/transition/registry.js";
import {
  upsertPolicy,
  deletePolicy,
  listPolicies,
} from "../control/policy.js";
import {
  grantAdmin,
  revokeAdmin,
  listAdmins,
} from "../control/admin.js";
import {
  grantReadCapability,
  grantInvokeCapability,
  revokeCapability,
  listCapabilities,
} from "../control/capability.js";

import {
  requireRead,
  requireInvoke,
  requireAdmin,
} from "../core/capabilities.js";
import { parseSchemaDsl } from "../core/schema.js";
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

// All MCP tool registrations. Each handler recovers request-scoped
// CallContext via requireCtx() (ALS keyed), enforces authorization up-front
// using the Tier-0/1/2 primitives in core/capabilities, then delegates to the
// domain module. Errors raised as LedgerError are surfaced to the client via
// the result wrapper in ./result.ts.

const UUID = z.string().uuid();

export function registerAllTools(server: McpServer): void {
  registerNamespaceTools(server);
  registerSchemaTools(server);
  registerTransitionTools(server);
  registerPolicyTools(server);
  registerAdminTools(server);
  registerCapabilityTools(server);
  registerAuditTools(server);
  registerDataTools(server);
  registerBlobTools(server);
}

// ---------- namespace.* ----------

function registerNamespaceTools(server: McpServer): void {
  server.registerTool(
    "namespace.create",
    {
      description: "Create a new namespace owned by the caller.",
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
      description: "List namespaces the caller owns or administers.",
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
    "namespace.tombstone",
    {
      description: "Soft-delete (tombstone) a namespace. Owner-only.",
      inputSchema: { namespace_id: UUID },
    },
    wrap("namespace.tombstone", async (args) => {
      const ctx = requireCtx();
      // Ownership is enforced implicitly: only the owner's agent id can
      // tombstone. Re-check here to emit a cleaner error than a stale no-op.
      const ns = await ctx.db
        .selectFrom("namespaces")
        .select(["owner_agent_id"])
        .where("id", "=", args.namespace_id)
        .executeTakeFirst();
      if (!ns || ns.owner_agent_id !== ctx.agentId) {
        const { LedgerError } = await import("../core/errors.js");
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

function registerSchemaTools(server: McpServer): void {
  server.registerTool(
    "schema.register",
    {
      description: "Register a new typed-primitive schema (name, version).",
      inputSchema: {
        namespace_id: UUID,
        name: z.string().min(1).max(128),
        version: z.number().int().positive(),
        dsl: z.unknown(),
      },
    },
    wrap("schema.register", async (args) => {
      const ctx = requireCtx();
      await requireAdmin(ctx.db, args.namespace_id, ctx.agentId);
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
    "schema.list",
    {
      description: "List registered schemas in a namespace.",
      inputSchema: {
        namespace_id: UUID,
        include_deprecated: z.boolean().default(false),
      },
    },
    wrap("schema.list", async (args) => {
      const ctx = requireCtx();
      await requireAdmin(ctx.db, args.namespace_id, ctx.agentId);
      return await listSchemas(ctx.db, args.namespace_id, args.include_deprecated);
    }),
  );

  server.registerTool(
    "schema.get",
    {
      description: "Fetch a schema (DSL + JSON Schema) by name and version.",
      inputSchema: {
        namespace_id: UUID,
        name: z.string().min(1).max(128),
        version: z.number().int().positive(),
      },
    },
    wrap("schema.get", async (args) => {
      const ctx = requireCtx();
      await requireAdmin(ctx.db, args.namespace_id, ctx.agentId);
      return await getSchema(ctx.db, args.namespace_id, args.name, args.version);
    }),
  );

  server.registerTool(
    "schema.deprecate",
    {
      description: "Mark a schema version deprecated. New instances refused; history kept.",
      inputSchema: {
        namespace_id: UUID,
        name: z.string().min(1).max(128),
        version: z.number().int().positive(),
      },
    },
    wrap("schema.deprecate", async (args) => {
      const ctx = requireCtx();
      await requireAdmin(ctx.db, args.namespace_id, ctx.agentId);
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
        "Validate a schema DSL object without registering it. Use this to test your DSL before calling schema.register. Returns { valid: true } or { valid: false, error: string }. No namespace or capability required.",
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

// ---------- transition.* ----------

function registerTransitionTools(server: McpServer): void {
  server.registerTool(
    "transition.register",
    {
      description: "Register a transition definition (params_schema, asserts, ops).",
      inputSchema: {
        namespace_id: UUID,
        name: z.string().min(1).max(128),
        version: z.number().int().positive(),
        params_schema: z.unknown(),
        asserts: z.unknown(),
        ops: z.unknown(),
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
      });
      return { registered: true };
    }),
  );

  server.registerTool(
    "transition.list",
    {
      description: "List registered transitions in a namespace.",
      inputSchema: {
        namespace_id: UUID,
        include_deprecated: z.boolean().default(false),
      },
    },
    wrap("transition.list", async (args) => {
      const ctx = requireCtx();
      await requireAdmin(ctx.db, args.namespace_id, ctx.agentId);
      return await listTransitions(ctx.db, args.namespace_id, args.include_deprecated);
    }),
  );

  server.registerTool(
    "transition.get",
    {
      description: "Fetch a transition definition by name and version.",
      inputSchema: {
        namespace_id: UUID,
        name: z.string().min(1).max(128),
        version: z.number().int().positive(),
      },
    },
    wrap("transition.get", async (args) => {
      const ctx = requireCtx();
      await requireAdmin(ctx.db, args.namespace_id, ctx.agentId);
      return await getTransition(ctx.db, args.namespace_id, args.name, args.version);
    }),
  );

  server.registerTool(
    "transition.deprecate",
    {
      description: "Mark a transition version deprecated. Invocation refused; history kept.",
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

// ---------- policy.* ----------

function registerPolicyTools(server: McpServer): void {
  server.registerTool(
    "policy.upsert",
    {
      description: "Insert or update a policy rule. Provide `id` to update; omit to insert.",
      inputSchema: {
        namespace_id: UUID,
        id: UUID.optional(),
        rule: z.unknown(),
      },
    },
    wrap("policy.upsert", async (args) => {
      const ctx = requireCtx();
      const upsertInput: Parameters<typeof upsertPolicy>[1] = {
        namespaceId: args.namespace_id,
        updatedBy: ctx.agentId,
        requestId: ctx.requestId,
        rule: args.rule,
      };
      if (args.id !== undefined) upsertInput.id = args.id;
      return await upsertPolicy(ctx.db, upsertInput);
    }),
  );

  server.registerTool(
    "policy.list",
    {
      description: "List policy rules for a namespace.",
      inputSchema: { namespace_id: UUID },
    },
    wrap("policy.list", async (args) => {
      const ctx = requireCtx();
      await requireAdmin(ctx.db, args.namespace_id, ctx.agentId);
      return await listPolicies(ctx.db, args.namespace_id);
    }),
  );

  server.registerTool(
    "policy.delete",
    {
      description: "Delete a policy rule by id.",
      inputSchema: { namespace_id: UUID, policy_id: UUID },
    },
    wrap("policy.delete", async (args) => {
      const ctx = requireCtx();
      await deletePolicy(ctx.db, {
        namespaceId: args.namespace_id,
        policyId: args.policy_id,
        actorAgentId: ctx.agentId,
        requestId: ctx.requestId,
      });
      return { deleted: true };
    }),
  );
}

// ---------- admin.* ----------

function registerAdminTools(server: McpServer): void {
  server.registerTool(
    "admin.grant",
    {
      description: "Promote an agent to admin of a namespace. Owner-only.",
      inputSchema: { namespace_id: UUID, agent_id: UUID },
    },
    wrap("admin.grant", async (args) => {
      const ctx = requireCtx();
      await grantAdmin(ctx.db, {
        namespaceId: args.namespace_id,
        agentId: args.agent_id,
        grantedBy: ctx.agentId,
        requestId: ctx.requestId,
      });
      return { granted: true };
    }),
  );

  server.registerTool(
    "admin.revoke",
    {
      description: "Revoke an agent's admin membership on a namespace. Owner-only.",
      inputSchema: { namespace_id: UUID, agent_id: UUID },
    },
    wrap("admin.revoke", async (args) => {
      const ctx = requireCtx();
      await revokeAdmin(ctx.db, {
        namespaceId: args.namespace_id,
        agentId: args.agent_id,
        revokedBy: ctx.agentId,
        requestId: ctx.requestId,
      });
      return { revoked: true };
    }),
  );

  server.registerTool(
    "admin.list",
    {
      description: "List admins of a namespace.",
      inputSchema: { namespace_id: UUID },
    },
    wrap("admin.list", async (args) => {
      const ctx = requireCtx();
      await requireAdmin(ctx.db, args.namespace_id, ctx.agentId);
      return await listAdmins(ctx.db, args.namespace_id);
    }),
  );
}

// ---------- capability.* ----------

function registerCapabilityTools(server: McpServer): void {
  server.registerTool(
    "capability.grant",
    {
      description:
        "Grant a read or invoke capability. For read supply path_glob; for invoke supply transition_name.",
      inputSchema: {
        namespace_id: UUID,
        agent_id: UUID,
        scope_kind: z.enum(["read", "invoke"]),
        path_glob: z.string().min(1).max(512).optional(),
        transition_name: z.string().min(1).max(128).optional(),
        expires_at: z.string().datetime().optional(),
      },
    },
    wrap("capability.grant", async (args) => {
      const ctx = requireCtx();
      const expiresAt = args.expires_at ? new Date(args.expires_at) : undefined;
      if (args.scope_kind === "read") {
        if (!args.path_glob) {
          const { LedgerError } = await import("../core/errors.js");
          throw new LedgerError("invalid_params", "path_glob required for read capability");
        }
        const input: Parameters<typeof grantReadCapability>[1] = {
          namespaceId: args.namespace_id,
          agentId: args.agent_id,
          pathGlob: args.path_glob,
          grantedBy: ctx.agentId,
          requestId: ctx.requestId,
        };
        if (expiresAt !== undefined) input.expiresAt = expiresAt;
        return await grantReadCapability(ctx.db, input);
      } else {
        if (!args.transition_name) {
          const { LedgerError } = await import("../core/errors.js");
          throw new LedgerError("invalid_params", "transition_name required for invoke capability");
        }
        const input: Parameters<typeof grantInvokeCapability>[1] = {
          namespaceId: args.namespace_id,
          agentId: args.agent_id,
          transitionName: args.transition_name,
          grantedBy: ctx.agentId,
          requestId: ctx.requestId,
        };
        if (expiresAt !== undefined) input.expiresAt = expiresAt;
        return await grantInvokeCapability(ctx.db, input);
      }
    }),
  );

  server.registerTool(
    "capability.revoke",
    {
      description: "Revoke a capability by id.",
      inputSchema: { namespace_id: UUID, capability_id: UUID },
    },
    wrap("capability.revoke", async (args) => {
      const ctx = requireCtx();
      await revokeCapability(ctx.db, {
        namespaceId: args.namespace_id,
        capabilityId: args.capability_id,
        revokedBy: ctx.agentId,
        requestId: ctx.requestId,
      });
      return { revoked: true };
    }),
  );

  server.registerTool(
    "capability.list",
    {
      description: "List capabilities granted in a namespace. Optional agent filter.",
      inputSchema: {
        namespace_id: UUID,
        agent_id: UUID.optional(),
      },
    },
    wrap("capability.list", async (args) => {
      const ctx = requireCtx();
      await requireAdmin(ctx.db, args.namespace_id, ctx.agentId);
      const filter: { agentId?: string } = {};
      if (args.agent_id !== undefined) filter.agentId = args.agent_id;
      return await listCapabilities(ctx.db, args.namespace_id, filter);
    }),
  );
}

// ---------- audit.* ----------

function registerAuditTools(server: McpServer): void {
  server.registerTool(
    "audit.read",
    {
      description: "Read audit entries from a namespace starting at from_seq.",
      inputSchema: {
        namespace_id: UUID,
        from_seq: z.string().regex(/^\d+$/),
        limit: z.number().int().positive().max(1000).default(100),
      },
    },
    wrap("audit.read", async (args) => {
      const ctx = requireCtx();
      await requireAdmin(ctx.db, args.namespace_id, ctx.agentId);
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
      description: "Fetch the current audit head (latest seq + chain hash).",
      inputSchema: { namespace_id: UUID },
    },
    wrap("audit.head", async (args) => {
      const ctx = requireCtx();
      await requireAdmin(ctx.db, args.namespace_id, ctx.agentId);
      const h = await getAuditHead(ctx.db, args.namespace_id);
      if (!h) return null;
      return { seq: h.seq.toString(), chain_hash: h.chainHash.toString("hex") };
    }),
  );

  server.registerTool(
    "audit.verify",
    {
      description: "Verify the audit chain over [from_seq, to_seq].",
      inputSchema: {
        namespace_id: UUID,
        from_seq: z.string().regex(/^\d+$/),
        to_seq: z.string().regex(/^\d+$/),
      },
    },
    wrap("audit.verify", async (args) => {
      const ctx = requireCtx();
      await requireAdmin(ctx.db, args.namespace_id, ctx.agentId);
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
      description: "Invoke a registered transition atomically.",
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
      await requireInvoke(ctx.db, args.namespace_id, ctx.agentId, args.transition_name);
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
      description: "Fetch a document by path.",
      inputSchema: {
        namespace_id: UUID,
        path: z.string().min(1).max(512),
      },
    },
    wrap("doc.get", async (args) => {
      const ctx = requireCtx();
      await requireRead(ctx.db, args.namespace_id, ctx.agentId, args.path);
      return await docGet(ctx.db, args.namespace_id, args.path);
    }),
  );

  server.registerTool(
    "log.read",
    {
      description: "Read entries from a log starting at from_offset.",
      inputSchema: {
        namespace_id: UUID,
        log_id: z.string().min(1).max(128),
        from_offset: z.string().regex(/^\d+$/),
        limit: z.number().int().positive().max(1000).default(100),
      },
    },
    wrap("log.read", async (args) => {
      const ctx = requireCtx();
      // Capabilities over logs are authored as path-globs matching the log_id.
      await requireRead(ctx.db, args.namespace_id, ctx.agentId, args.log_id);
      return await logRead(ctx.db, args.namespace_id, args.log_id, BigInt(args.from_offset), args.limit);
    }),
  );

  server.registerTool(
    "log.head",
    {
      description: "Fetch log metadata (schema binding + next offset).",
      inputSchema: {
        namespace_id: UUID,
        log_id: z.string().min(1).max(128),
      },
    },
    wrap("log.head", async (args) => {
      const ctx = requireCtx();
      await requireRead(ctx.db, args.namespace_id, ctx.agentId, args.log_id);
      return await logGet(ctx.db, args.namespace_id, args.log_id);
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
        "Store a blob (base64-encoded). Server computes sha256 and returns it. Admin-only.",
      inputSchema: {
        namespace_id: UUID,
        content_base64: z.string().min(1),
        content_type: z.string().max(128).optional(),
      },
    },
    wrap("blob.put", async (args) => {
      const ctx = requireCtx();
      await requireAdmin(ctx.db, args.namespace_id, ctx.agentId);
      const bytes = Buffer.from(args.content_base64, "base64");
      return await blobPut(ctx.db, bytes, args.content_type ?? null);
    }),
  );

  server.registerTool(
    "blob.get",
    {
      description: "Fetch a blob by sha256 (hex). Returns base64-encoded content. Admin-only.",
      inputSchema: {
        namespace_id: UUID,
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      },
    },
    wrap("blob.get", async (args) => {
      const ctx = requireCtx();
      await requireAdmin(ctx.db, args.namespace_id, ctx.agentId);
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
      description: "Check if a blob exists by sha256 (hex).",
      inputSchema: {
        namespace_id: UUID,
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      },
    },
    wrap("blob.exists", async (args) => {
      const ctx = requireCtx();
      await requireAdmin(ctx.db, args.namespace_id, ctx.agentId);
      const exists = await blobExists(ctx.db, args.sha256);
      return { exists };
    }),
  );
}
