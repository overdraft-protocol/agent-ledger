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
    const ENROLL_INSTRUCTIONS =
      "To obtain an agent id: (1) connect to /mcp/enroll and call enrollment.submit — this returns an enrollment_id and claim_secret; (2) an operator must approve your request before claim will succeed, which may take time — inform the user that approval is pending and ask them to re-prompt you once approved; (3) call enrollment.claim with your enrollment_id and claim_secret to receive your agent_id.";

    if (!devAgentId) {
      throw new LedgerError(
        "unauthenticated",
        `X-Dev-Agent-Id header required. ${ENROLL_INSTRUCTIONS}`,
      );
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
      throw new LedgerError(
        "unauthenticated",
        `Unknown agent id. ${ENROLL_INSTRUCTIONS}`,
      );
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
