import { z } from "zod";
import type { Kysely } from "kysely";
import type { Database } from "../storage/postgres/schema.js";
import { LedgerError } from "./errors.js";
import { globMatches, validateGlob, validatePath } from "./path.js";

// Policy evaluator — the SINGLE function called by `policy.test` (dry-run) and
// the runtime enforcement middleware (I14). Pure over a set of rules; no I/O
// inside `evaluate*`. `loadRules` fetches from Postgres.
//
// A policy rule is a small declarative JSON object:
//
//   { match: { kind: "path", glob: "orders/*/items" }, effect: "deny" }
//   { match: { kind: "transition", name: "transfer" },  effect: "allow", rate_cost: 10 }
//
// Semantics (both read and invoke):
//   - Default effect is "allow". Explicit "allow" is permitted but redundant.
//   - Any matching rule with effect="deny" wins (deny overrides allow).
//   - rate_cost, when present, contributes to the per-request cost. The
//     evaluator returns the MAX cost across matching rules (I27 composability).
//
// Combined with capabilities: a request is permitted iff
//   capability-grant(path/transition) AND policy-not-deny(path/transition).

const PathMatchSchema = z.object({
  kind: z.literal("path"),
  glob: z.string().min(1).max(512),
});
const TransitionMatchSchema = z.object({
  kind: z.literal("transition"),
  name: z.string().min(1).max(128),
});

const PolicyRuleSchema = z.object({
  match: z.discriminatedUnion("kind", [PathMatchSchema, TransitionMatchSchema]),
  effect: z.enum(["allow", "deny"]).optional(),
  rate_cost: z.number().int().nonnegative().max(1_000_000).optional(),
});

export type PolicyRule = z.infer<typeof PolicyRuleSchema>;
export type PolicyEffect = "allow" | "deny";

// Validate a caller-supplied rule on registration. Enforces glob grammar and
// rejects unknown fields by relying on Zod's strict default on discriminated unions.
export function parsePolicyRule(raw: unknown): PolicyRule {
  const parsed = PolicyRuleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new LedgerError("policy_invalid", "invalid policy rule", { issues: parsed.error.issues });
  }
  if (parsed.data.match.kind === "path") {
    // validateGlob enforces I13 (no regex, bounded grammar).
    validateGlob(parsed.data.match.glob);
  }
  return parsed.data;
}

export interface StoredPolicy {
  id: string;
  rule: PolicyRule;
}

export interface ReadDecision {
  effect: PolicyEffect;
  rateCost: number;
  matchedRuleIds: string[];
}

export interface InvokeDecision {
  effect: PolicyEffect;
  rateCost: number;
  matchedRuleIds: string[];
}

// Pure evaluators. `policies` is the full set loaded for the namespace.
// These ignore non-matching rule kinds.
export function evaluateRead(policies: StoredPolicy[], path: string): ReadDecision {
  validatePath(path);
  let denied = false;
  let cost = 0;
  const matched: string[] = [];
  for (const p of policies) {
    if (p.rule.match.kind !== "path") continue;
    if (!globMatches(p.rule.match.glob, path)) continue;
    matched.push(p.id);
    if (p.rule.effect === "deny") denied = true;
    if (p.rule.rate_cost !== undefined && p.rule.rate_cost > cost) cost = p.rule.rate_cost;
  }
  return { effect: denied ? "deny" : "allow", rateCost: cost, matchedRuleIds: matched };
}

export function evaluateInvoke(policies: StoredPolicy[], transitionName: string): InvokeDecision {
  if (typeof transitionName !== "string" || transitionName.length === 0) {
    throw new LedgerError("invalid_params", "transitionName required");
  }
  let denied = false;
  let cost = 0;
  const matched: string[] = [];
  for (const p of policies) {
    if (p.rule.match.kind !== "transition") continue;
    if (p.rule.match.name !== transitionName) continue;
    matched.push(p.id);
    if (p.rule.effect === "deny") denied = true;
    if (p.rule.rate_cost !== undefined && p.rule.rate_cost > cost) cost = p.rule.rate_cost;
  }
  return { effect: denied ? "deny" : "allow", rateCost: cost, matchedRuleIds: matched };
}

// Fetch every policy row for a namespace. Parses and drops rows with rule
// bodies that no longer satisfy the current schema (future-proofing against
// migrations). Such drops are returned separately so callers can surface them.
export async function loadPolicies(
  db: Kysely<Database>,
  namespaceId: string,
): Promise<{ policies: StoredPolicy[]; invalid: Array<{ id: string; issues: unknown }> }> {
  const rows = await db
    .selectFrom("policies")
    .select(["id", "rule"])
    .where("namespace_id", "=", namespaceId)
    .execute();

  const policies: StoredPolicy[] = [];
  const invalid: Array<{ id: string; issues: unknown }> = [];
  for (const r of rows) {
    const parsed = PolicyRuleSchema.safeParse(r.rule);
    if (parsed.success) policies.push({ id: r.id, rule: parsed.data });
    else invalid.push({ id: r.id, issues: parsed.error.issues });
  }
  return { policies, invalid };
}

// Enforcement helpers — the thin wrappers called by primitive handlers.
// They throw `forbidden` on deny; on allow they return the rate cost
// (0 if no matching rule declared one) for the rate-limiter to consume.
export async function enforceRead(
  db: Kysely<Database>,
  namespaceId: string,
  path: string,
): Promise<number> {
  const { policies } = await loadPolicies(db, namespaceId);
  const decision = evaluateRead(policies, path);
  if (decision.effect === "deny") {
    throw new LedgerError("forbidden", "read denied by policy", {
      namespace_id: namespaceId,
      path,
      rule_ids: decision.matchedRuleIds,
    });
  }
  return decision.rateCost;
}

export async function enforceInvoke(
  db: Kysely<Database>,
  namespaceId: string,
  transitionName: string,
): Promise<number> {
  const { policies } = await loadPolicies(db, namespaceId);
  const decision = evaluateInvoke(policies, transitionName);
  if (decision.effect === "deny") {
    throw new LedgerError("forbidden", "invoke denied by policy", {
      namespace_id: namespaceId,
      transition_name: transitionName,
      rule_ids: decision.matchedRuleIds,
    });
  }
  return decision.rateCost;
}
