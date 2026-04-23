import crypto from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { loadConfig } from "../config.js";
import { getDb } from "../storage/postgres/client.js";
import type { CallContext } from "../core/context.js";
import { LedgerError } from "../core/errors.js";
import { logger } from "../telemetry/logger.js";

// Auth middleware.
//
// Phase 5 — dev shim: when ALLOW_DEV_AGENT_HEADER=true, the request header
// `X-Dev-Agent-Id: <uuid>` is trusted as the caller identity. The agent row
// must exist; we do not auto-create it (so a stale UUID fails loudly).
//
// TODO (full Phase 5): validate RFC 9068 access token via jose + JWKS,
//  resolve `sub` -> agent id, check Hydra blocklist, enforce token ttl.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Variables = { ctx: CallContext };

export const authMiddleware = (): MiddlewareHandler<{ Variables: Variables }> => {
  const cfg = loadConfig();
  if (!cfg.ALLOW_DEV_AGENT_HEADER) {
    // Until the JWT implementation lands, refuse at server boot rather than
    // silently admit unauthenticated requests.
    logger.error("auth middleware: JWT path not yet implemented and ALLOW_DEV_AGENT_HEADER=false");
    return async () => {
      throw new LedgerError("unauthenticated", "server has no authentication configured");
    };
  }

  return async (c, next) => {
    const devAgentId = c.req.header("x-dev-agent-id");
    if (!devAgentId) {
      throw new LedgerError("unauthenticated", "X-Dev-Agent-Id header required");
    }
    if (!UUID_RE.test(devAgentId)) {
      throw new LedgerError("unauthenticated", "X-Dev-Agent-Id must be a UUID");
    }

    const db = getDb();
    const agent = await db
      .selectFrom("agents")
      .select(["id", "disabled_at"])
      .where("id", "=", devAgentId)
      .executeTakeFirst();
    if (!agent) {
      throw new LedgerError("unauthenticated", "unknown agent id");
    }
    if (agent.disabled_at !== null) {
      throw new LedgerError("unauthenticated", "agent is disabled");
    }

    const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
    const ctx: CallContext = {
      requestId,
      agentId: agent.id,
      tokenJti: null, // no JWT in dev mode
      db,
    };
    c.set("ctx", ctx);
    c.header("x-request-id", requestId);
    await next();
  };
};

export function getCtx(c: Context<{ Variables: Variables }>): CallContext {
  const ctx = c.get("ctx");
  if (!ctx) {
    throw new LedgerError("internal", "auth middleware did not populate ctx");
  }
  return ctx;
}
