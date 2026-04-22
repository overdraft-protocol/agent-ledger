import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

function newReqId(): string {
  return randomBytes(4).toString("hex");
}

function redactHeaders(headers: IncomingMessage["headers"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "authorization" && typeof v === "string") {
      const m = v.match(/^\s*(\S+)\s+/);
      out[k] = m ? `${m[1]} <redacted>` : "<redacted>";
    } else {
      out[k] = v;
    }
  }
  return out;
}

function emit(event: Record<string, unknown>): void {
  // NDJSON to stderr; one line per event.
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
}

export type WireLogContext = {
  reqId: string;
  startedAt: number;
  logRequest: (rawBody: Buffer) => void;
};

/**
 * Attach wire-level logging to a single request/response pair.
 * Wraps res.write/res.end to capture what actually goes on the wire.
 * Returns a context you use to log the request body once you've read it.
 */
export function attachWireLog(req: IncomingMessage, res: ServerResponse): WireLogContext {
  const reqId = newReqId();
  const startedAt = Date.now();

  // Wrap response to capture body chunks as written.
  const bodyChunks: Buffer[] = [];
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res.write = ((chunk: any, ...args: any[]) => {
    if (chunk) bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return origWrite(chunk, ...args);
  }) as typeof res.write;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res.end = ((chunk?: any, ...args: any[]) => {
    if (chunk) bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(bodyChunks).toString("utf8");
    emit({
      kind: "response",
      reqId,
      durationMs: Date.now() - startedAt,
      status: res.statusCode,
      headers: res.getHeaders(),
      body,
    });
    return origEnd(chunk, ...args);
  }) as typeof res.end;

  return {
    reqId,
    startedAt,
    logRequest(rawBody: Buffer) {
      emit({
        kind: "request",
        reqId,
        method: req.method,
        url: req.url,
        httpVersion: req.httpVersion,
        remoteAddress: req.socket.remoteAddress,
        headers: redactHeaders(req.headers),
        body: rawBody.toString("utf8"),
      });
    },
  };
}

export function wireLogEnabled(): boolean {
  const v = process.env.MCP_LOG_WIRE;
  if (!v) return false;
  return v === "1" || v.toLowerCase() === "true";
}