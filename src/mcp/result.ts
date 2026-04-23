import { LedgerError } from "../core/errors.js";
import { logger } from "../telemetry/logger.js";

// Helpers for shaping tool-handler return values + funnelling our LedgerError
// taxonomy into a predictable, JSON-serializable envelope that clients can
// parse regardless of MCP SDK version.

export interface ToolResult {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// BigInt isn't JSON-serializable; stringify it. Everything else passes through.
function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === "bigint") return v.toString();
    if (Buffer.isBuffer(v)) return v.toString("hex");
    return v;
  }, 2);
}

export function ok<T>(value: T): ToolResult {
  return {
    content: [{ type: "text", text: safeStringify({ ok: true, result: value }) }],
  };
}

export function errorResult(err: LedgerError): ToolResult {
  return {
    isError: true,
    content: [
      { type: "text", text: safeStringify({ ok: false, error: err.toJsonRpcError() }) },
    ],
  };
}

// Wraps an async tool handler so LedgerError is emitted as a structured
// error envelope and any other error is logged and returned as `internal`.
export function wrap<Args, R>(
  name: string,
  fn: (args: Args) => Promise<R>,
): (args: Args) => Promise<ToolResult> {
  return async (args: Args) => {
    try {
      const r = await fn(args);
      return ok(r);
    } catch (e) {
      if (e instanceof LedgerError) {
        return errorResult(e);
      }
      logger.error({ err: e, tool: name }, "unhandled tool error");
      const wrapped = new LedgerError("internal", (e as Error).message ?? "unknown error");
      return errorResult(wrapped);
    }
  };
}
