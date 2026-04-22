import process from "node:process";
import "dotenv/config";
import { startHttpServer } from "./http.js";

const mode = (process.env.MCP_TRANSPORT ?? "http").toLowerCase();

if (mode !== "http") {
  // This package previously shipped only a stdio transport (already compiled in older dist output).
  // For now, keep the distribution focused on Streamable HTTP.
  console.error(`Unsupported MCP_TRANSPORT='${mode}'. Use MCP_TRANSPORT=http.`);
  process.exit(1);
}

const host = process.env.HOST?.trim() ? process.env.HOST : "0.0.0.0";
const port = process.env.PORT?.trim() ? Number(process.env.PORT) : 3210;
const server = await startHttpServer({ host, port });
const addr = server.address();
const where =
  typeof addr === "string" ? addr : addr ? `http://${addr.address}:${addr.port}` : "http://127.0.0.1:3210";

console.log(`agent-ledger-mcp listening on ${where}`);

