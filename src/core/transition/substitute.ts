import { LedgerError } from "../errors.js";
import type { Expr } from "./grammar.js";

// Per-invocation environment assembled once, frozen, and used to resolve
// every Expr in the transition body. System params (caller/now/request_id/tx_id)
// are server-provided; caller params come from the validated `params` object.

export interface SubstitutionEnv {
  readonly caller: string;     // agent id
  readonly now: string;        // ISO-8601
  readonly requestId: string;
  readonly txId: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export function resolveExpr(e: Expr, env: SubstitutionEnv): unknown {
  switch (e.k) {
    case "lit": return e.v;
    case "param": {
      if (!(e.name in env.params)) {
        throw new LedgerError("invalid_params", `param "${e.name}" not supplied`);
      }
      return env.params[e.name];
    }
    case "sys": {
      switch (e.name) {
        case "caller": return env.caller;
        case "now": return env.now;
        case "request_id": return env.requestId;
        case "tx_id": return env.txId;
      }
    }
  }
}

// Coerce resolved values with tight type checks — transitions declare the
// expected primitive shape, and we surface mismatches as invalid_params.

export function asString(v: unknown, label: string): string {
  if (typeof v !== "string") {
    throw new LedgerError("invalid_params", `${label} must be a string`);
  }
  return v;
}

export function asNumber(v: unknown, label: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new LedgerError("invalid_params", `${label} must be a finite number`);
  }
  return v;
}

export function asBigint(v: unknown, label: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  throw new LedgerError("invalid_params", `${label} must be an integer`);
}

export function asInteger(v: unknown, label: string): number {
  const n = asNumber(v, label);
  if (!Number.isInteger(n)) {
    throw new LedgerError("invalid_params", `${label} must be an integer`);
  }
  return n;
}
