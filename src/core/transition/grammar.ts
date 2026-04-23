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
    const p = AssertSchema.safeParse(a);
    if (!p.success) {
      throw new LedgerError("invalid_params", `assert[${i}] invalid`, { issues: p.error.issues });
    }
    return p.data;
  });
  const ops: Op[] = input.ops.map((o, i) => {
    const p = OpSchema.safeParse(o);
    if (!p.success) {
      throw new LedgerError("invalid_params", `ops[${i}] invalid`, { issues: p.error.issues });
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
