import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "../../src/storage/postgres/schema.js";
import { ensureSchema, seedAgent, shutdown } from "../helpers/db.js";

// Boot the Hono app in-memory (app.fetch()) and drive it through the MCP
// Streamable HTTP transport. Covers: /healthz, auth middleware, tools/list,
// and a round-trip through namespace.create -> schema.register ->
// transition.register -> tx.invoke -> doc.get.
//
// Requires ALLOW_DEV_AGENT_HEADER=true so the X-Dev-Agent-Id shim is active
// (set in tests/setup.ts before config is cached).

import { createApp } from "../../src/http/app.js";

type JsonRpcResult = {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

async function rpc(
  app: ReturnType<typeof createApp>,
  agentId: string,
  method: string,
  params: unknown,
  id: number,
): Promise<JsonRpcResult> {
  const res = await app.fetch(
    new Request("http://local/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-dev-agent-id": agentId,
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
  );
  expect(res.status, `rpc ${method} status`).toBe(200);
  return (await res.json()) as JsonRpcResult;
}

async function initialize(
  app: ReturnType<typeof createApp>,
  agentId: string,
): Promise<void> {
  const init = await rpc(app, agentId, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0.0.0" },
  }, 0);
  expect(init.error, JSON.stringify(init.error)).toBeUndefined();
}

function toolResult(r: JsonRpcResult): { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } } {
  expect(r.error, JSON.stringify(r.error)).toBeUndefined();
  const result = r.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
  const text = result.content[0]?.text ?? "{}";
  const parsed = JSON.parse(text);
  return parsed;
}

describe("smoke: http", () => {
  let db: Kysely<Database>;
  let app: ReturnType<typeof createApp>;
  let agentId: string;

  beforeAll(async () => {
    db = await ensureSchema();
    const agent = await seedAgent(db);
    agentId = agent.id;
    app = createApp();
  });

  afterAll(async () => {
    await shutdown();
  });

  it("GET /healthz returns ok without auth", async () => {
    const res = await app.fetch(new Request("http://local/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects missing X-Dev-Agent-Id on /mcp", async () => {
    const res = await app.fetch(
      new Request("http://local/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("tools/list returns the registered tool catalog", async () => {
    await initialize(app, agentId);
    const r = await rpc(app, agentId, "tools/list", {}, 1);
    expect(r.error, JSON.stringify(r.error)).toBeUndefined();
    const result = r.result as { tools: Array<{ name: string }> };
    const names = new Set(result.tools.map((t) => t.name));
    expect(names.has("namespace.create")).toBe(true);
    expect(names.has("tx.invoke")).toBe(true);
    expect(names.has("doc.get")).toBe(true);
  });

  it("round-trips namespace.create -> schema.register -> transition.register -> tx.invoke -> doc.get", async () => {
    await initialize(app, agentId);

    // namespace.create
    const nsCall = await rpc(app, agentId, "tools/call", {
      name: "namespace.create",
      arguments: { alias: `http-smoke-${Date.now()}` },
    }, 10);
    const nsRes = toolResult(nsCall);
    if (!("ok" in nsRes) || nsRes.ok !== true) throw new Error("namespace.create failed");
    const namespaceId = (nsRes.result as { id: string }).id;

    // schema.register
    const schemaCall = await rpc(app, agentId, "tools/call", {
      name: "schema.register",
      arguments: {
        namespace_id: namespaceId,
        name: "note",
        version: 1,
        dsl: {
          t: "object",
          extras: "strict",
          props: {
            title: { s: { t: "string", min: 1, max: 64 } },
            body: { s: { t: "string", max: 2048 } },
          },
        },
      },
    }, 11);
    const schemaRes = toolResult(schemaCall);
    expect(schemaRes.ok).toBe(true);

    // transition.register
    const transitionCall = await rpc(app, agentId, "tools/call", {
      name: "transition.register",
      arguments: {
        namespace_id: namespaceId,
        name: "create_note",
        version: 1,
        params_schema: {
          t: "object",
          extras: "strict",
          props: {
            path: { s: { t: "string", min: 1, max: 128 } },
            note: {
              s: {
                t: "object",
                extras: "strict",
                props: {
                  title: { s: { t: "string", min: 1, max: 64 } },
                  body: { s: { t: "string", max: 2048 } },
                },
              },
            },
          },
        },
        asserts: [],
        ops: [
          {
            o: "doc.put",
            path: { k: "param", name: "path" },
            schema_name: "note",
            schema_version: 1,
            value: { k: "param", name: "note" },
          },
        ],
      },
    }, 12);
    const transitionRes = toolResult(transitionCall);
    expect(transitionRes.ok).toBe(true);

    // tx.invoke
    const invokeCall = await rpc(app, agentId, "tools/call", {
      name: "tx.invoke",
      arguments: {
        namespace_id: namespaceId,
        transition_name: "create_note",
        params: { path: "notes/first", note: { title: "hello", body: "world" } },
        idempotency_key: "idem-http-smoke-1",
      },
    }, 13);
    const invokeRes = toolResult(invokeCall);
    expect(invokeRes.ok, JSON.stringify(invokeRes)).toBe(true);

    // doc.get
    const docCall = await rpc(app, agentId, "tools/call", {
      name: "doc.get",
      arguments: { namespace_id: namespaceId, path: "notes/first" },
    }, 14);
    const docRes = toolResult(docCall);
    expect(docRes.ok).toBe(true);
    if ("result" in docRes) {
      expect(docRes.result).toMatchObject({
        value: { title: "hello", body: "world" },
        version: "1",
      });
    }
  });
});
