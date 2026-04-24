import { z } from "zod";
import type { Kysely } from "kysely";
import type { Database } from "../storage/postgres/schema.js";
import { LedgerError } from "./errors.js";

// Schemas are Zod-first. The authoritative validator is a Zod parser reconstructed
// from a constrained, sandboxed subset of Zod's builders. JSON Schema is derived for
// wire interchange and discoverability.
//
// Invariants:
//   - I9  immutable on registration
//   - I10 every typed primitive instance cites (name, version)
//   - I11 per-validation time budget enforced
//   - I12 schema size <= 64 KiB, depth <= 32

export const MAX_SCHEMA_BYTES = 64 * 1024;
export const MAX_SCHEMA_DEPTH = 32;
export const VALIDATION_SOFT_MS = 50;
export const VALIDATION_HARD_MS = 200;

// Sandboxed schema DSL. A subset of Zod expressed in JSON for safe storage and transport.
// Authors write Zod; it is serialized to this DSL, validated, stored, and reconstructed.
//
// Intentionally NOT supported: refinements with arbitrary functions, transforms,
// effects, or cross-schema references. Recursive types permitted via `$ref` with
// depth capped at MAX_SCHEMA_DEPTH.

type Dsl =
  | { t: "string"; min?: number; max?: number; regex?: string; format?: "uuid" | "email" | "url" | "datetime" }
  | { t: "int";    min?: number; max?: number }
  | { t: "number"; min?: number; max?: number }
  | { t: "bool" }
  | { t: "null" }
  | { t: "literal"; v: string | number | boolean }
  | { t: "enum";    vs: (string | number)[] }
  | { t: "array";   items: Dsl; min?: number; max?: number }
  | { t: "object";  props: Record<string, { s: Dsl; optional?: boolean }>; extras: "strict" | "strip" }
  | { t: "union";   options: Dsl[] }
  | { t: "blobref" }     // -> { $blob: <sha256-hex> }
  | { t: "index";   hint: string; of: Dsl }; // x-index marker wrapping an inner schema

// exactOptionalPropertyTypes makes Zod's `.optional()` (which yields `T | undefined`)
// incompatible with our Dsl's `min?: number` shape. The runtime validator is
// correct; we erase the incompatibility through a narrow cast on the builder.
const DslSchema: z.ZodType<Dsl> = z.lazy(() =>
  z.union([
    z.object({ t: z.literal("string"),  min: z.number().int().nonnegative().optional(), max: z.number().int().positive().optional(),
               regex: z.string().optional(), format: z.enum(["uuid","email","url","datetime"]).optional() }),
    z.object({ t: z.literal("int"),     min: z.number().int().optional(), max: z.number().int().optional() }),
    z.object({ t: z.literal("number"),  min: z.number().optional(), max: z.number().optional() }),
    z.object({ t: z.literal("bool")  }),
    z.object({ t: z.literal("null")  }),
    z.object({ t: z.literal("literal"), v: z.union([z.string(), z.number(), z.boolean()]) }),
    z.object({ t: z.literal("enum"),    vs: z.array(z.union([z.string(), z.number()])).min(1) }),
    z.object({ t: z.literal("array"),   items: DslSchema, min: z.number().int().nonnegative().optional(), max: z.number().int().positive().optional() }),
    z.object({ t: z.literal("object"),  props: z.record(z.object({ s: DslSchema, optional: z.boolean().optional() })),
               extras: z.enum(["strict","strip"]) }),
    z.object({ t: z.literal("union"),   options: z.array(DslSchema).min(1) }),
    z.object({ t: z.literal("blobref") }),
    z.object({ t: z.literal("index"),   hint: z.string(), of: DslSchema }),
  ]),
) as unknown as z.ZodType<Dsl>;

export type SchemaDsl = Dsl;

function dslDepth(s: Dsl, acc = 0): number {
  if (acc > MAX_SCHEMA_DEPTH) return acc;
  switch (s.t) {
    case "array": return dslDepth(s.items, acc + 1);
    case "object": {
      let m = acc;
      for (const k of Object.keys(s.props)) {
        const p = s.props[k]!;
        m = Math.max(m, dslDepth(p.s, acc + 1));
      }
      return m;
    }
    case "union": return Math.max(acc + 1, ...s.options.map((o) => dslDepth(o, acc + 1)));
    case "index": return dslDepth(s.of, acc + 1);
    default: return acc;
  }
}

// ---------------------------------------------------------------------------
// Input normalisation — runs BEFORE DslSchema.safeParse so agents can use
// the more natural syntax they already know from JSON Schema / Zod:
//
//   "properties" accepted as an alias for "props"
//   "extras" defaults to "strip" when omitted on object nodes
//   flat prop values  { t: "string", optional?: true }
//     accepted alongside legacy wrapped  { s: { t: "string" }, optional?: true }
//
// The canonical stored form is always the legacy wrapped format; normalisation
// is input-only and backward-compatible with existing stored schemas.
// ---------------------------------------------------------------------------

function preprocessDsl(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;

  const obj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };

  // "properties" → "props" alias
  if ("properties" in out && !("props" in out)) {
    out["props"] = out["properties"];
    delete out["properties"];
  }

  // Default "extras" on object nodes
  if (out["t"] === "object" && !("extras" in out)) {
    out["extras"] = "strip";
  }

  // Normalise object props: flat { t, optional? } → wrapped { s, optional? }
  if (
    out["t"] === "object" &&
    typeof out["props"] === "object" &&
    out["props"] !== null &&
    !Array.isArray(out["props"])
  ) {
    const rawProps = out["props"] as Record<string, unknown>;
    const newProps: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawProps)) {
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        const pv = v as Record<string, unknown>;
        if (!("s" in pv) && "t" in pv) {
          // Flat format — extract optional, recursively preprocess the rest
          const optional = pv["optional"];
          const schemaFields: Record<string, unknown> = {};
          for (const [fk, fv] of Object.entries(pv)) {
            if (fk !== "optional") schemaFields[fk] = fv;
          }
          const inner = preprocessDsl(schemaFields);
          if (optional !== undefined) {
            newProps[k] = { s: inner, optional };
          } else {
            newProps[k] = { s: inner };
          }
        } else if ("s" in pv) {
          // Wrapped format — recurse into inner schema only
          newProps[k] = { ...pv, s: preprocessDsl(pv["s"]) };
        } else {
          newProps[k] = preprocessDsl(v);
        }
      } else {
        newProps[k] = v;
      }
    }
    out["props"] = newProps;
  }

  // Recurse into composite type fields
  if ("items" in out) out["items"] = preprocessDsl(out["items"]);
  if (Array.isArray(out["options"])) {
    out["options"] = (out["options"] as unknown[]).map(preprocessDsl);
  }
  if ("of" in out) out["of"] = preprocessDsl(out["of"]);

  return out;
}

// ---------------------------------------------------------------------------
// Targeted error hints — called with the *original* raw input (pre-normalise)
// so we can diagnose what the agent actually wrote.
// ---------------------------------------------------------------------------

const VALID_DSL_TYPES = new Set([
  "string", "int", "number", "bool", "null", "literal",
  "enum", "array", "object", "union", "blobref", "index",
]);

function dslErrorHint(raw: unknown, error: z.ZodError): string {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const t = obj["t"];

    if (t === undefined) {
      return (
        `missing required field "t". Every schema node needs a "t" ` +
        `discriminant, e.g. { "t": "string" } or { "t": "object", "props": { ... } }`
      );
    }
    if (typeof t === "string" && !VALID_DSL_TYPES.has(t)) {
      return (
        `unknown type "${t}". Valid values for "t": ` +
        [...VALID_DSL_TYPES].join(", ")
      );
    }
    if (t === "object") {
      const hasProps = "props" in obj || "properties" in obj;
      if (!hasProps) {
        return (
          `t="object" requires a "props" field — an object mapping field names ` +
          `to their schemas, e.g. { "t": "object", "props": { "name": { "t": "string" } } }`
        );
      }
    }
    if (t === "enum") {
      const vs = obj["vs"];
      if (!Array.isArray(vs) || vs.length === 0) {
        return `t="enum" requires a non-empty "vs" array, e.g. { "t": "enum", "vs": ["a", "b"] }`;
      }
    }
    if (t === "literal" && !("v" in obj)) {
      return `t="literal" requires a "v" field, e.g. { "t": "literal", "v": "active" }`;
    }
    if (t === "array" && !("items" in obj)) {
      return `t="array" requires an "items" schema, e.g. { "t": "array", "items": { "t": "string" } }`;
    }
    if (t === "union" && !("options" in obj)) {
      return `t="union" requires an "options" array, e.g. { "t": "union", "options": [{ "t": "string" }, { "t": "null" }] }`;
    }
  }
  // Generic fallback: first few Zod issue messages with paths
  const items = error.issues.slice(0, 3).map((i) => {
    const p = i.path.length ? i.path.join(".") : "root";
    return `[${p}] ${i.message}`;
  });
  return items.join("; ");
}

export function parseSchemaDsl(raw: unknown): Dsl {
  const bytes = Buffer.byteLength(JSON.stringify(raw), "utf8");
  if (bytes > MAX_SCHEMA_BYTES) {
    throw new LedgerError("too_large", `schema exceeds ${MAX_SCHEMA_BYTES} bytes`);
  }
  const normalized = preprocessDsl(raw);
  const parsed = DslSchema.safeParse(normalized);
  if (!parsed.success) {
    const hint = dslErrorHint(raw, parsed.error);
    throw new LedgerError("schema_violation", `invalid schema DSL: ${hint}`, {
      issues: parsed.error.issues,
    });
  }
  const depth = dslDepth(parsed.data);
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new LedgerError("too_large", `schema depth exceeds ${MAX_SCHEMA_DEPTH}`);
  }
  return parsed.data;
}

// Reconstruct a Zod validator from the stored DSL for runtime validation.
export function compileToZod(s: Dsl): z.ZodTypeAny {
  switch (s.t) {
    case "string": {
      let v = z.string();
      if (s.min !== undefined) v = v.min(s.min);
      if (s.max !== undefined) v = v.max(s.max);
      if (s.regex) v = v.regex(new RegExp(s.regex));
      if (s.format === "uuid") v = v.uuid();
      else if (s.format === "email") v = v.email();
      else if (s.format === "url") v = v.url();
      else if (s.format === "datetime") v = v.datetime();
      return v;
    }
    case "int": {
      let v = z.number().int();
      if (s.min !== undefined) v = v.min(s.min);
      if (s.max !== undefined) v = v.max(s.max);
      return v;
    }
    case "number": {
      let v = z.number();
      if (s.min !== undefined) v = v.min(s.min);
      if (s.max !== undefined) v = v.max(s.max);
      return v;
    }
    case "bool":    return z.boolean();
    case "null":    return z.null();
    case "literal": return z.literal(s.v);
    case "enum":    return z.enum(s.vs.map(String) as [string, ...string[]]);
    case "array": {
      let v = z.array(compileToZod(s.items));
      if (s.min !== undefined) v = v.min(s.min);
      if (s.max !== undefined) v = v.max(s.max);
      return v;
    }
    case "object": {
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const k of Object.keys(s.props)) {
        const p = s.props[k]!;
        const inner = compileToZod(p.s);
        shape[k] = p.optional ? inner.optional() : inner;
      }
      return s.extras === "strict" ? z.object(shape).strict() : z.object(shape);
    }
    case "union":   return z.union(s.options.map(compileToZod) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
    case "blobref": return z.object({ $blob: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
    case "index":   return compileToZod(s.of);
  }
}

// Export DSL -> JSON Schema for wire / discovery. Kept intentionally minimal.
export function toJsonSchema(s: Dsl): Record<string, unknown> {
  switch (s.t) {
    case "string": {
      const j: Record<string, unknown> = { type: "string" };
      if (s.min !== undefined) j["minLength"] = s.min;
      if (s.max !== undefined) j["maxLength"] = s.max;
      if (s.regex) j["pattern"] = s.regex;
      if (s.format) j["format"] = s.format;
      return j;
    }
    case "int":    return { type: "integer", ...(s.min !== undefined && { minimum: s.min }), ...(s.max !== undefined && { maximum: s.max }) };
    case "number": return { type: "number",  ...(s.min !== undefined && { minimum: s.min }), ...(s.max !== undefined && { maximum: s.max }) };
    case "bool":   return { type: "boolean" };
    case "null":   return { type: "null" };
    case "literal":return { const: s.v };
    case "enum":   return { enum: s.vs };
    case "array":  return { type: "array", items: toJsonSchema(s.items),
                           ...(s.min !== undefined && { minItems: s.min }),
                           ...(s.max !== undefined && { maxItems: s.max }) };
    case "object": {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const k of Object.keys(s.props)) {
        const p = s.props[k]!;
        properties[k] = toJsonSchema(p.s);
        if (!p.optional) required.push(k);
      }
      const j: Record<string, unknown> = { type: "object", properties };
      if (required.length) j["required"] = required;
      if (s.extras === "strict") j["additionalProperties"] = false;
      return j;
    }
    case "union":   return { anyOf: s.options.map(toJsonSchema) };
    case "blobref": return { type: "object", properties: { $blob: { type: "string", pattern: "^[0-9a-f]{64}$" } }, required: ["$blob"], additionalProperties: false };
    case "index":   { const inner = toJsonSchema(s.of); return { ...inner, "x-index": s.hint }; }
  }
}

// Validation with wall-clock budget (I11). On timeout we throw; Zod does not
// natively support cancellation, but cheap schemas finish in microseconds —
// exceeding the budget indicates pathological input or schema.
export function validateWithBudget(validator: z.ZodTypeAny, value: unknown): void {
  const start = performance.now();
  const result = validator.safeParse(value);
  const elapsed = performance.now() - start;
  if (elapsed > VALIDATION_HARD_MS) {
    throw new LedgerError("validation_timeout", `validation exceeded ${VALIDATION_HARD_MS}ms`);
  }
  if (!result.success) {
    throw new LedgerError("schema_violation", "value does not match schema", {
      issues: result.error.issues,
    });
  }
}

// Walk a DSL to collect blob-ref paths — used by transitions to maintain ref counts.
export function collectBlobRefs(s: Dsl, value: unknown): string[] {
  const out: string[] = [];
  const walk = (node: Dsl, v: unknown): void => {
    if (v === null || v === undefined) return;
    switch (node.t) {
      case "blobref":
        if (typeof v === "object" && v !== null && "$blob" in v && typeof (v as { $blob: unknown }).$blob === "string") {
          out.push((v as { $blob: string }).$blob);
        }
        return;
      case "array":
        if (Array.isArray(v)) for (const item of v) walk(node.items, item);
        return;
      case "object":
        if (typeof v === "object" && !Array.isArray(v)) {
          for (const k of Object.keys(node.props)) {
            const p = node.props[k]!;
            walk(p.s, (v as Record<string, unknown>)[k]);
          }
        }
        return;
      case "union":
        // Walk every branch; duplicates filtered by caller.
        for (const o of node.options) walk(o, v);
        return;
      case "index":
        walk(node.of, v);
        return;
      default:
        return;
    }
  };
  walk(s, value);
  return [...new Set(out)];
}

// Fetch a registered schema (raises not_found or deprecated-on-write enforced elsewhere).
export async function loadSchema(
  db: Kysely<Database>,
  namespaceId: string,
  name: string,
  version: number,
): Promise<{ dsl: Dsl; deprecated: boolean }> {
  const row = await db
    .selectFrom("schemas")
    .select(["json_schema", "deprecated_at"])
    .where("namespace_id", "=", namespaceId)
    .where("name", "=", name)
    .where("version", "=", version)
    .executeTakeFirst();
  if (!row) {
    throw new LedgerError("not_found", `schema ${name}@v${version} not found`, {
      namespace_id: namespaceId,
      schema_name: name,
      schema_version: version,
    });
  }
  // We store the DSL alongside the exported JSON Schema — see register.
  const dsl = parseSchemaDsl(row.json_schema);
  return { dsl, deprecated: row.deprecated_at !== null };
}
