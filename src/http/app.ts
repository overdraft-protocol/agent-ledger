import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { loadConfig } from "../config.js";
import { authMiddleware, getCtx } from "../auth/middleware.js";
import type { CallContext } from "../core/context.js";
import { LedgerError } from "../core/errors.js";
import { logger } from "../telemetry/logger.js";
import { buildMcpServer } from "../mcp/server.js";
import { buildEnrollmentMcpServer } from "../mcp/enroll.js";
import { runWithCtx } from "../mcp/context.js";
import { createEnrollmentRoutes } from "./enroll.js";

// HTTP surface for the agent-ledger MCP server.
//
// /healthz       — unauthenticated liveness probe.
// /enroll, /enroll/claim — unauthenticated onboarding (HTTP).
// /mcp/enroll    — unauthenticated MCP server exposing only enrollment tools.
// /mcp           — authenticated MCP Streamable HTTP endpoint (GET/POST/DELETE).
//
// The MCP transport is stateless: a fresh WebStandardStreamableHTTPServerTransport
// is built per request and connected to a fresh McpServer. Tool handlers on the
// authenticated path recover the CallContext via AsyncLocalStorage (see
// src/mcp/context.ts). The enrollment server has no per-request state.

type Variables = { ctx: CallContext };

export function createApp(): Hono<{ Variables: Variables }> {
  const cfg = loadConfig();
  const app = new Hono<{ Variables: Variables }>();

  app.get("/healthz", (c) => c.json({ ok: true }));

  // Unauthenticated enrollment surface — both the flat HTTP endpoints and the
  // tiny MCP server. Body limit applies; no auth middleware. The two surfaces
  // share the same control-plane backend (src/control/enrollment.ts), so the
  // MCP variant cannot expose anything the HTTP variant doesn't.
  const enroll = createEnrollmentRoutes();
  const enrollOuter = new Hono();
  enrollOuter.use("*", bodyLimit({ maxSize: cfg.MAX_REQUEST_BYTES }));
  enrollOuter.route("/", enroll);
  app.route("/enroll", enrollOuter);

  const mcpEnroll = new Hono();
  mcpEnroll.use("*", bodyLimit({ maxSize: cfg.MAX_REQUEST_BYTES }));
  mcpEnroll.all("*", async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    const server = buildEnrollmentMcpServer();
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close().catch(() => undefined);
    }
  });
  app.route("/mcp/enroll", mcpEnroll);

  const mcp = new Hono<{ Variables: Variables }>();
  mcp.use("*", bodyLimit({ maxSize: cfg.MAX_REQUEST_BYTES }));
  mcp.use("*", authMiddleware());
  mcp.all("*", async (c) => {
    const ctx = getCtx(c);
    const transport = new WebStandardStreamableHTTPServerTransport({
      // Stateless: no server-managed sessions. Each request stands alone.
      enableJsonResponse: true,
    });
    // McpServer.connect binds to exactly one transport, so we build a fresh
    // server per request. Tools are registered cheaply (metadata only).
    const server = buildMcpServer();
    await server.connect(transport);
    try {
      return await runWithCtx(ctx, () => transport.handleRequest(c.req.raw));
    } finally {
      await server.close().catch(() => undefined);
    }
  });
  app.route("/mcp", mcp);

  app.onError((err, c) => {
    if (err instanceof LedgerError) {
      const rpc = err.toJsonRpcError();
      const status = httpStatusFor(err.code);
      return c.json({ error: rpc }, status);
    }
    logger.error({ err }, "unhandled http error");
    return c.json(
      { error: { code: -32099, message: "internal error", data: { code: "internal" } } },
      500,
    );
  });

  return app;
}

function httpStatusFor(code: LedgerError["code"]): 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 {
  switch (code) {
    case "unauthenticated":
      return 401;
    case "forbidden":
    case "capability_missing":
    case "write_mode_denied":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
    case "version_conflict":
    case "transition_name_taken":
    case "schema_immutable":
    case "lock_held":
    case "lock_fence_mismatch":
      return 409;
    case "too_large":
      return 413;
    case "rate_limited":
      return 429;
    case "internal":
      return 500;
    default:
      return 400;
  }
}
