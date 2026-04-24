import { z } from "zod";
import { LedgerError } from "../errors.js";
import { parseSchemaDsl, type SchemaDsl } from "../schema.js";

// Transition grammar — JSON-serializable, fully declarative.
// All substitutable positions use `Expr`. Substitution is done at invoke time
// against validated params (I7). No arithmetic, no concatenation, no conditionals.

export type ExprPrimitive = string | number | boolean | null;

const ExprSchema: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    z.object({ k: z.literal("lit"), v: z.any() }),
    z.object({ k: z.literal("param"), name: z.string().min(1).max(64) }),
    z.object({
      k: z.literal("sys"),
      name: z.enum(["caller", "now", "request_id", "tx_id"]),
    }),
  ]),
) as unknown as z.ZodType<Expr>;

export type Expr =
  | { k: "lit"; v: unknown }
  | { k: "param"; name: string }
  | { k: "sys"; name: "caller" | "now" | "request_id" | "tx_id" };

// ---------- Asserts ----------

export type Assert =
  | { a: "doc.exists"; path: Expr }
  | { a: "doc.version_eq"; path: Expr; version: Expr }
  | { a: "doc.field_eq"; path: Expr; field: Expr; value: Expr }
  | { a: "counter.eq"; path: Expr; value: Expr }
  | { a: "counter.gte"; path: Expr; value: Expr }
  | { a: "counter.lte"; path: Expr; value: Expr }
  | { a: "counter.in_range"; path: Expr; min: Expr; max: Expr }
  | { a: "log.offset_eq"; log_id: Expr; offset: Expr }
  | { a: "log.length_gte"; log_id: Expr; length: Expr }
  | { a: "lock.fence_matches"; path: Expr; fence: Expr };

const AssertSchema: z.ZodType<Assert> = z.union([
  z.object({ a: z.literal("doc.exists"), path: ExprSchema }),
  z.object({ a: z.literal("doc.version_eq"), path: ExprSchema, version: ExprSchema }),
  z.object({ a: z.literal("doc.field_eq"), path: ExprSchema, field: ExprSchema, value: ExprSchema }),
  z.object({ a: z.literal("counter.eq"), path: ExprSchema, value: ExprSchema }),
  z.object({ a: z.literal("counter.gte"), path: ExprSchema, value: ExprSchema }),
  z.object({ a: z.literal("counter.lte"), path: ExprSchema, value: ExprSchema }),
  z.object({ a: z.literal("counter.in_range"), path: ExprSchema, min: ExprSchema, max: ExprSchema }),
  z.object({ a: z.literal("log.offset_eq"), log_id: ExprSchema, offset: ExprSchema }),
  z.object({ a: z.literal("log.length_gte"), log_id: ExprSchema, length: ExprSchema }),
  z.object({ a: z.literal("lock.fence_matches"), path: ExprSchema, fence: ExprSchema }),
]) as unknown as z.ZodType<Assert>;

// ---------- Ops ----------

export type Op =
  | { o: "doc.put";       path: Expr; schema_name: string; schema_version: number; value: Expr; expected_version?: Expr }
  | { o: "doc.del";       path: Expr; expected_version?: Expr }
  | { o: "log.create";    log_id: Expr; schema_name: string; schema_version: number }
  | { o: "log.append";    log_id: Expr; value: Expr }
  | { o: "counter.create";path: Expr; initial: Expr; min: Expr; max: Expr }
  | { o: "counter.incr";  path: Expr; delta: Expr }
  | { o: "counter.reset"; path: Expr; to: Expr }
  | { o: "lock.acquire";  path: Expr; ttl_ms: Expr }
  | { o: "lock.refresh";  path: Expr; fence: Expr; ttl_ms: Expr }
  | { o: "lock.release";  path: Expr; fence: Expr };

const OpSchema: z.ZodType<Op> = z.union([
  z.object({ o: z.literal("doc.put"), path: ExprSchema,
             schema_name: z.string().min(1).max(128),
             schema_version: z.number().int().positive(),
             value: ExprSchema, expected_version: ExprSchema.optional() }),
  z.object({ o: z.literal("doc.del"), path: ExprSchema, expected_version: ExprSchema.optional() }),
  z.object({ o: z.literal("log.create"), log_id: ExprSchema,
             schema_name: z.string().min(1).max(128),
             schema_version: z.number().int().positive() }),
  z.object({ o: z.literal("log.append"), log_id: ExprSchema, value: ExprSchema }),
  z.object({ o: z.literal("counter.create"), path: ExprSchema,
             initial: ExprSchema, min: ExprSchema, max: ExprSchema }),
  z.object({ o: z.literal("counter.incr"), path: ExprSchema, delta: ExprSchema }),
  z.object({ o: z.literal("counter.reset"), path: ExprSchema, to: ExprSchema }),
  z.object({ o: z.literal("lock.acquire"), path: ExprSchema, ttl_ms: ExprSchema }),
  z.object({ o: z.literal("lock.refresh"), path: ExprSchema, fence: ExprSchema, ttl_ms: ExprSchema }),
  z.object({ o: z.literal("lock.release"), path: ExprSchema, fence: ExprSchema }),
]) as unknown as z.ZodType<Op>;

// ---------- Preprocessing helpers ----------

/** Returns true if `v` is already a valid Expr shape and does not need wrapping. */
function isExprLike(v: unknown): boolean {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const k = (v as Record<string, unknown>)["k"];
  return k === "lit" || k === "param" || k === "sys";
}

/**
 * Ensure `v` is an Expr. Raw primitives and plain objects are wrapped as
 * { k: "lit", v } so agents don't have to write the wrapper for literals.
 */
function asExpr(v: unknown): unknown {
  return isExprLike(v) ? v : { k: "lit", v };
}

const VALID_OP_TYPES = new Set([
  "doc.put", "doc.del", "log.create", "log.append",
  "counter.create", "counter.incr", "counter.reset",
  "lock.acquire", "lock.refresh", "lock.release",
]);

const VALID_ASSERT_TYPES = new Set([
  "doc.exists", "doc.version_eq", "doc.field_eq",
  "counter.eq", "counter.gte", "counter.lte", "counter.in_range",
  "log.offset_eq", "log.length_gte", "lock.fence_matches",
]);

// Fields an agent must supply (after defaults have been applied)
const OP_REQUIRED_FIELDS: Record<string, string[]> = {
  "doc.put":        ["path", "schema_name", "value"],
  "doc.del":        ["path"],
  "log.create":     ["log_id", "schema_name"],
  "log.append":     ["log_id", "value"],
  "counter.create": ["path"],
  "counter.incr":   ["path"],
  "counter.reset":  ["path", "to"],
  "lock.acquire":   ["path"],
  "lock.refresh":   ["path", "fence"],
  "lock.release":   ["path", "fence"],
};

/**
 * Normalise an op node before Zod validation:
 * • Wrap raw values in Expr positions as { k: "lit", v }
 * • Apply sensible defaults so agents can omit boilerplate fields
 */
function preprocessOp(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const op = { ...(raw as Record<string, unknown>) };
  const o = op["o"];

  // Expr auto-wrap helper — only touches fields that exist
  const wrap = (field: string) => { if (field in op) op[field] = asExpr(op[field]); };
  const wrapOrDefault = (field: string, def: unknown) => {
    op[field] = field in op ? asExpr(op[field]) : def;
  };

  switch (o) {
    case "doc.put":
      wrap("path"); wrap("value"); wrap("expected_version");
      if (!("schema_version" in op)) op["schema_version"] = 1;
      break;
    case "doc.del":
      wrap("path"); wrap("expected_version");
      break;
    case "log.create":
      wrap("log_id");
      if (!("schema_version" in op)) op["schema_version"] = 1;
      break;
    case "log.append":
      wrap("log_id"); wrap("value");
      break;
    case "counter.create":
      wrap("path");
      wrapOrDefault("initial", { k: "lit", v: 0 });
      wrapOrDefault("min",     { k: "lit", v: 0 });
      wrapOrDefault("max",     { k: "lit", v: 1_000_000 });
      break;
    case "counter.incr":
      wrap("path");
      wrapOrDefault("delta", { k: "lit", v: 1 });
      break;
    case "counter.reset":
      wrap("path"); wrap("to");
      break;
    case "lock.acquire":
      wrap("path");
      wrapOrDefault("ttl_ms", { k: "lit", v: 30_000 });
      break;
    case "lock.refresh":
      wrap("path"); wrap("fence");
      wrapOrDefault("ttl_ms", { k: "lit", v: 30_000 });
      break;
    case "lock.release":
      wrap("path"); wrap("fence");
      break;
  }
  return op;
}

/** Normalise an assert node: wrap raw values in Expr positions as { k: "lit", v }. */
function preprocessAssert(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const assert = { ...(raw as Record<string, unknown>) };
  const wrap = (field: string) => { if (field in assert) assert[field] = asExpr(assert[field]); };

  switch (assert["a"]) {
    case "doc.exists":
      wrap("path"); break;
    case "doc.version_eq":
      wrap("path"); wrap("version"); break;
    case "doc.field_eq":
      wrap("path"); wrap("field"); wrap("value"); break;
    case "counter.eq": case "counter.gte": case "counter.lte":
      wrap("path"); wrap("value"); break;
    case "counter.in_range":
      wrap("path"); wrap("min"); wrap("max"); break;
    case "log.offset_eq":
      wrap("log_id"); wrap("offset"); break;
    case "log.length_gte":
      wrap("log_id"); wrap("length"); break;
    case "lock.fence_matches":
      wrap("path"); wrap("fence"); break;
  }
  return assert;
}

function opErrorHint(raw: unknown): string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "op must be an object with an \"o\" field";
  }
  const obj = raw as Record<string, unknown>;
  const o = obj["o"];
  if (o === undefined) {
    return `missing required field "o". Every op needs a discriminant, e.g. "doc.put", "log.append". Valid values: ${[...VALID_OP_TYPES].join(", ")}`;
  }
  if (typeof o !== "string" || !VALID_OP_TYPES.has(o)) {
    return `unknown op "${String(o)}". Valid values for "o": ${[...VALID_OP_TYPES].join(", ")}`;
  }
  const missing = (OP_REQUIRED_FIELDS[o] ?? []).filter((f) => !(f in obj));
  if (missing.length > 0) {
    return `op "${o}" is missing required fields: ${missing.join(", ")}`;
  }
  return `op "${o}" has invalid field values — check that Expr fields are raw values, { "k": "lit", "v": ... }, { "k": "param", "name": "..." }, or { "k": "sys", "name": "caller|now|request_id|tx_id" }`;
}

function assertErrorHint(raw: unknown): string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "assert must be an object with an \"a\" field";
  }
  const obj = raw as Record<string, unknown>;
  const a = obj["a"];
  if (a === undefined) {
    return `missing required field "a". Every assert needs a discriminant, e.g. "doc.exists". Valid values: ${[...VALID_ASSERT_TYPES].join(", ")}`;
  }
  if (typeof a !== "string" || !VALID_ASSERT_TYPES.has(a)) {
    return `unknown assert "${String(a)}". Valid values for "a": ${[...VALID_ASSERT_TYPES].join(", ")}`;
  }
  return `assert "${a}" has invalid field values`;
}

// ---------- Transition definition ----------

export interface TransitionDefinition {
  params_schema: SchemaDsl; // object with property definitions
  asserts: Assert[];
  ops: Op[];
}

const MAX_ASSERTS = 64;
const MAX_OPS = 64;

export function parseTransitionDefinition(input: {
  params_schema: unknown;
  asserts: unknown;
  ops: unknown;
}): TransitionDefinition {
  // params schema is our own DSL (same as schema.register) — but must be an object at top.
  const paramsSchema = parseSchemaDsl(input.params_schema);
  if (paramsSchema.t !== "object") {
    throw new LedgerError("invalid_params", "transition params_schema must be an object schema");
  }
  if (!Array.isArray(input.asserts)) {
    throw new LedgerError("invalid_params", "asserts must be an array");
  }
  if (!Array.isArray(input.ops)) {
    throw new LedgerError("invalid_params", "ops must be an array");
  }
  if (input.asserts.length > MAX_ASSERTS) {
    throw new LedgerError("too_large", `asserts exceed ${MAX_ASSERTS} entries`);
  }
  if (input.ops.length > MAX_OPS) {
    throw new LedgerError("too_large", `ops exceed ${MAX_OPS} entries`);
  }
  if (input.ops.length === 0) {
    throw new LedgerError("invalid_params", "transition must declare at least one op");
  }

  const asserts: Assert[] = input.asserts.map((a, i) => {
    const preprocessed = preprocessAssert(a);
    const p = AssertSchema.safeParse(preprocessed);
    if (!p.success) {
      const hint = assertErrorHint(a);
      throw new LedgerError("invalid_params", `assert[${i}] invalid: ${hint}`, { issues: p.error.issues });
    }
    return p.data;
  });
  const ops: Op[] = input.ops.map((o, i) => {
    const preprocessed = preprocessOp(o);
    const p = OpSchema.safeParse(preprocessed);
    if (!p.success) {
      const hint = opErrorHint(o);
      throw new LedgerError("invalid_params", `ops[${i}] invalid: ${hint}`, { issues: p.error.issues });
    }
    return p.data;
  });

  // Reject references to undeclared caller params.
  const declaredParams = new Set(Object.keys(paramsSchema.props));
  const checkExpr = (e: Expr, location: string): void => {
    if (e.k === "param" && !declaredParams.has(e.name)) {
      throw new LedgerError("invalid_params",
        `${location} references undeclared param "${e.name}"`);
    }
  };
  const walk = (val: unknown, loc: string): void => {
    if (val === null || typeof val !== "object") return;
    if (Array.isArray(val)) { val.forEach((v, i) => walk(v, `${loc}[${i}]`)); return; }
    const obj = val as Record<string, unknown>;
    if (typeof obj["k"] === "string" && (obj["k"] === "lit" || obj["k"] === "param" || obj["k"] === "sys")) {
      checkExpr(obj as Expr, loc);
      return;
    }
    for (const k of Object.keys(obj)) walk(obj[k], `${loc}.${k}`);
  };
  asserts.forEach((a, i) => walk(a, `asserts[${i}]`));
  ops.forEach((o, i) => walk(o, `ops[${i}]`));

  return { params_schema: paramsSchema, asserts, ops };
}
