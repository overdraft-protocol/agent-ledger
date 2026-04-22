import { defaultKvPath, loadKv, nowIso, persistKv, type KvEntry } from "./kv.js";

export const TOOLS = [
  {
    name: "put_kv",
    description: "Store a value in the KV store",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { type: "string" },
        content_type: { type: "string", default: "text/plain" }
      },
      required: ["key", "value"]
    }
  },
  {
    name: "get_kv",
    description: "Retrieve a value from the KV store",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" }
      },
      required: ["key"]
    }
  },
  {
    name: "list_kv",
    description: "List keys in the KV store with an optional prefix",
    inputSchema: {
      type: "object",
      properties: {
        prefix: { type: "string", default: "" }
      }
    }
  },
  {
    name: "delete_kv",
    description: "Delete a key from the KV store",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" }
      },
      required: ["key"]
    }
  }
] as const;

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string; data?: unknown } };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown, field: string): string {
  if (typeof v !== "string") throw new Error(`Expected '${field}' to be a string`);
  return v;
}

export function makeError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

export type McpEnv = {
  kvPath: string;
};

export type McpState = {
  kv: Map<string, KvEntry>;
  persistChain: Promise<void>;
};

export async function createMcpState(env: Partial<McpEnv> = {}): Promise<{ env: McpEnv; state: McpState }> {
  const kvPath = env.kvPath ?? defaultKvPath();
  const kv = await loadKv(kvPath);
  return { env: { kvPath }, state: { kv, persistChain: Promise.resolve() } };
}

async function queuePersist(env: McpEnv, state: McpState): Promise<void> {
  state.persistChain = state.persistChain.then(() => persistKv(env.kvPath, state.kv)).catch(() => undefined);
  await state.persistChain;
}

export async function handleJsonRpc(
  env: McpEnv,
  state: McpState,
  req: JsonRpcRequest
): Promise<JsonRpcResponse> {
  const id: JsonRpcId = req.id ?? null;

  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return makeError(id, -32600, "Invalid Request");
  }

  if (req.method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }

  if (req.method === "tools/call") {
    if (!isRecord(req.params)) return makeError(id, -32602, "Invalid params");
    const name = asString(req.params.name, "name");
    const args = isRecord(req.params.arguments) ? req.params.arguments : {};

    if (name === "put_kv") {
      const key = asString(args.key, "key");
      const value = asString(args.value, "value");
      const content_type =
        typeof args.content_type === "string" && args.content_type.trim() ? args.content_type : "text/plain";

      state.kv.set(key, { value, content_type, updated_at: nowIso() });
      await queuePersist(env, state);

      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ok" }] } };
    }

    if (name === "get_kv") {
      const key = asString(args.key, "key");
      const entry = state.kv.get(key);
      if (!entry) {
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "" }], isError: true } };
      }
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: entry.value }], content_type: entry.content_type }
      };
    }

    if (name === "list_kv") {
      const prefix =
        typeof args.prefix === "string"
          ? args.prefix
          : args.prefix === undefined
            ? ""
            : (() => {
                throw new Error("Expected 'prefix' to be a string");
              })();

      const keys = [...state.kv.keys()].filter((k) => k.startsWith(prefix)).sort();
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(keys) }] } };
    }

    if (name === "delete_kv") {
      const key = asString(args.key, "key");
      state.kv.delete(key);
      await queuePersist(env, state);
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ok" }] } };
    }

    return makeError(id, -32601, `Unknown tool: ${name}`);
  }

  // Minimal baseline for clients that probe initialize.
  if (req.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "agent-ledger-mcp", version: "0.1.0" },
        capabilities: { tools: {} }
      }
    };
  }

  return makeError(id, -32601, "Method not found");
}

