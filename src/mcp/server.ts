import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "./tools.js";

// McpServer.connect() is single-transport per instance. In stateless HTTP
// mode we bind a fresh transport per request, which means we also need a
// fresh McpServer per request. Tool registration is cheap (metadata only),
// and handlers recover request-scoped state from AsyncLocalStorage (see
// ./context.ts), so no state is lost by constructing a new server each call.

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "agent-ledger", version: "0.2.0-dev" },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        "agent-ledger exposes a ledger of typed primitives (docs, logs, counters, locks, blobs) with capability-gated tools. Mutations are atomic and audited.",
    },
  );
  registerAllTools(server);
  return server;
}
