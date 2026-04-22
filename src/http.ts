import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createMcpState, handleJsonRpc, type JsonRpcRequest, type JsonRpcResponse } from "./mcp.js";
import { attachWireLog, wireLogEnabled } from "./wire-log.js";

function getBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  const value: string | undefined = typeof auth === "string" ? auth : Array.isArray(auth) ? auth[0] : undefined;
  if (value === undefined) return null;
  const m = value.match(/^\s*Bearer\s+(.+?)\s*$/i);
  return m ? m[1] ?? null : null;
}

function readBody(req: IncomingMessage, limitBytes = 2 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error("Request too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const data = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(data);
}

function sendSseOne(res: ServerResponse, obj: unknown): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("connection", "keep-alive");
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
  res.end();
}

function wantsSse(req: IncomingMessage): boolean {
  const accept = req.headers["accept"];
  if (typeof accept === "string" && accept.includes("text/event-stream")) return true;
  if (Array.isArray(accept) && accept.some((v) => v.includes("text/event-stream"))) return true;
  return false;
}

function isJsonRpcRequest(v: unknown): v is JsonRpcRequest {
  return typeof v === "object" && v !== null && (v as { jsonrpc?: unknown }).jsonrpc === "2.0";
}

export type HttpServerOpts = {
  port?: number;
  host?: string;
};

export async function startHttpServer(opts: HttpServerOpts = {}): Promise<http.Server> {
  const { env, state } = await createMcpState();
  const port = opts.port ?? (process.env.PORT ? Number(process.env.PORT) : 3210);
  const host = opts.host ?? (process.env.HOST?.trim() ? process.env.HOST : "127.0.0.1");
  const sharedToken = process.env.SHARED_SERVER_TOKEN?.trim() ? process.env.SHARED_SERVER_TOKEN.trim() : null;

  const server = http.createServer(async (req, res) => {
    const wire = wireLogEnabled() ? attachWireLog(req, res) : null;
    try {
      if (!req.url) {
        wire?.logRequest(Buffer.alloc(0));
        return sendJson(res, 400, { error: "missing url" });
      }

      if (req.method === "GET" && req.url === "/healthz") {
        wire?.logRequest(Buffer.alloc(0));
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("ok");
        return;
      }

      if (req.method === "GET" && req.url === "/") {
        wire?.logRequest(Buffer.alloc(0));
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("agent-ledger-mcp: POST JSON-RPC to /mcp");
        return;
      }

      if (req.method !== "POST" || req.url !== "/mcp") {
        wire?.logRequest(Buffer.alloc(0));
        return sendJson(res, 404, { error: "not found" });
      }

      if (sharedToken) {
        const bearer = getBearerToken(req);
        if (!bearer || bearer !== sharedToken) {
          wire?.logRequest(Buffer.alloc(0));
          res.statusCode = 401;
          res.setHeader("www-authenticate", 'Bearer realm="agent-ledger-mcp"');
          return sendJson(res, 401, { error: "unauthorized" });
        }
      }

      const raw = await readBody(req);
      wire?.logRequest(raw);
      const text = raw.toString("utf8").trim();
      if (!text) {
        wire?.logRequest(Buffer.alloc(0));
        return sendJson(res, 400, { error: "empty body" });
      }

      const parsed: unknown = JSON.parse(text);

      const respond = (payload: unknown) => {
        if (wantsSse(req)) return sendSseOne(res, payload);
        return sendJson(res, 200, payload);
      };

      if (Array.isArray(parsed)) {
        const out: JsonRpcResponse[] = [];
        for (const item of parsed) {
          if (!isJsonRpcRequest(item)) {
            out.push({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
            continue;
          }
          out.push(await handleJsonRpc(env, state, item));
        }
        return respond(out);
      }

      if (!isJsonRpcRequest(parsed)) {
        return respond({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      }

      const result = await handleJsonRpc(env, state, parsed);
      return respond(result);
    } catch (err) {
      return sendJson(res, 500, { error: (err as Error).message || "internal error" });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => resolve());
  });

  return server;
}

