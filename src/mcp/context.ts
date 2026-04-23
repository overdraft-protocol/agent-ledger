import { AsyncLocalStorage } from "node:async_hooks";
import type { CallContext } from "../core/context.js";
import { LedgerError } from "../core/errors.js";

// Per-request CallContext carrier. The HTTP layer calls `runWithCtx()` around
// the MCP transport's handleRequest so every tool handler can recover the
// authenticated context via `requireCtx()` without threading it through the
// SDK's tool signature (which is generic and doesn't carry request-scoped
// data by design).

const als = new AsyncLocalStorage<CallContext>();

export function runWithCtx<T>(ctx: CallContext, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}

export function requireCtx(): CallContext {
  const ctx = als.getStore();
  if (!ctx) {
    throw new LedgerError("internal", "call context missing; not running inside runWithCtx");
  }
  return ctx;
}
