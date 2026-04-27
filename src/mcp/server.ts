import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "./tools.js";

// McpServer.connect() is single-transport per instance. In stateless HTTP
// mode we bind a fresh transport per request, which means we also need a
// fresh McpServer per request. Tool registration is cheap (metadata only),
// and handlers recover request-scoped state from AsyncLocalStorage (see
// ./context.ts), so no state is lost by constructing a new server each call.

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "agent-ledger", version: "0.2.0-dev" },
    {
      capabilities: {
        tools: {},
      },
      instructions: `\
agent-ledger: typed, atomic, audited state store. Every mutation runs in a SERIALIZABLE transaction.

## Governance in one paragraph
Each namespace has exactly one owner (its creator) with implicit full access — they cannot be locked out. Everyone else gets access by holding one or more roles. A role is a named bundle of capabilities (e.g. "can read entries/**", "can invoke sign", or the meta-capability "manage_roles"). Membership can be granted to a specific agent_id or to the wildcard "*" to mean "every authenticated agent" (use this to model guests / open protocols). The owner — and any role holding "manage_roles" — can create/edit/grant roles, but only with capabilities they themselves already hold (no privilege escalation).

## COMPLETE WORKED EXAMPLE — copy this pattern

A "guestbook" protocol where anyone can sign, but only an admin role can manage state.

### 1. Create a namespace (you become owner)
namespace.create({ alias: "my-guestbook" })
→ { id: "<NS_ID>", alias: "my-guestbook", owner_agent_id: "<YOUR_ID>" }

### 2. Register a schema (the shape of an entry; agents won't see this directly)
schema.register({
  namespace_id: "<NS_ID>",
  name: "entry", version: 1,
  dsl: {
    "t": "object",
    "props": {
      "author":  { "t": "string", "max": 64 },
      "message": { "t": "string", "max": 500 }
    }
  }
})
— schema.validate({ dsl: ... }) lets you test without writing.

### 3. Create the roles you need
role.create({
  namespace_id: "<NS_ID>",
  name: "admin",
  description: "Can manage roles, schemas, and transitions.",
  capabilities: [{ scope_kind: "manage_roles" }]
})

role.create({
  namespace_id: "<NS_ID>",
  name: "guest",
  description: "Anyone may sign the guestbook and read entries.",
  capabilities: [
    { scope_kind: "invoke", transition_name: "sign" },
    { scope_kind: "read",   path_glob: "entries/**" }
  ]
})

### 4. Open the guest role to everyone
role.grant({ namespace_id: "<NS_ID>", role: "guest", agent_id: "*" })

### 5. Register transitions (declare description + required_role so callers know what they need)
transition.register({
  namespace_id: "<NS_ID>",
  name: "init_guestbook", version: 1,
  description: "One-time setup: create the entries log.",
  required_role: "admin",
  params_schema: { "t": "object", "props": {} },
  asserts: [],
  ops: [{ "o": "log.create", "log_id": "entries", "schema_name": "entry" }]
})

transition.register({
  namespace_id: "<NS_ID>",
  name: "sign", version: 1,
  description: "Append a guestbook entry. Anyone holding the 'guest' role may call.",
  required_role: "guest",
  params_schema: {
    "t": "object",
    "props": {
      "author":  { "t": "string", "max": 64 },
      "message": { "t": "string", "max": 500 }
    }
  },
  asserts: [],
  ops: [
    { "o": "log.append",
      "log_id": "entries",
      "value":  { "author": { "k": "param", "name": "author" },
                  "message": { "k": "param", "name": "message" } } }
  ]
})

// Same pattern with doc.put — note that schema_name/schema_version are SIBLING
// fields of value, NOT nested inside it. value is the actual data being stored,
// shaped however the named schema requires; its leaves can be param or sys refs.
transition.register({
  namespace_id: "<NS_ID>",
  name: "set_latest", version: 1,
  description: "Store the caller's latest entry as a doc at the given path.",
  required_role: "guest",
  params_schema: {
    "t": "object",
    "props": {
      "path":    { "t": "string", "max": 200 },
      "author":  { "t": "string", "max": 64 },
      "message": { "t": "string", "max": 500 }
    }
  },
  asserts: [],
  ops: [
    { "o": "doc.put",
      "path": { "k": "param", "name": "path" },
      "schema_name": "entry",
      "value": { "author":  { "k": "param", "name": "author" },
                 "message": { "k": "param", "name": "message" } } }
  ]
})

### 6. Run it (owner does setup, anyone with 'guest' can sign)
tx.invoke({ namespace_id: "<NS_ID>", transition_name: "init_guestbook", params: {}, idempotency_key: "init-v1" })
tx.invoke({ namespace_id: "<NS_ID>", transition_name: "sign",       params: { author: "Alice", message: "Hello!" }, idempotency_key: "sign-alice-1" })
tx.invoke({ namespace_id: "<NS_ID>", transition_name: "set_latest", params: { path: "latest/alice", author: "Alice", message: "Hi again!" }, idempotency_key: "latest-alice-1" })

### 7. Read back (response includes the schema_dsl so you can interpret entries)
log.read({ namespace_id: "<NS_ID>", log_id: "entries", from_offset: "0", limit: 100 })

---

## State mutation contract — protocol designers must know this

Ops compute writes from (params + sys) only; they do NOT read existing state. The server validates and commits; computing new state is the CALLER's job. If a write depends on the current value, the caller reads, computes locally, and re-submits, with an assert protecting against races.

The read → compute → CAS-write pattern:
  1. caller: cur = doc.get({ namespace_id, path })                // reads prior value + version
  2. caller: compute new_value locally
  3. caller: tx.invoke(transition, params: { new_value, expected_version: cur.version })
     where the transition declares:
       asserts: [{ "a": "doc.version_eq", "path": "<P>", "version": { "k": "param", "name": "expected_version" } }]
       ops:     [{ "o": "doc.put", "path": "<P>", "schema_name": "...",
                   "value":            { "k": "param", "name": "new_value" },
                   "expected_version": { "k": "param", "name": "expected_version" } }]
  4. on race, the loser gets precondition_failed and retries from step 1.

### Designing for partial updates
There are NO partial-write ops — no array-element mutation, no merge, no patch. For state with independently-updatable parts, MODEL EACH PART AS ITS OWN DOC. E.g. tic-tac-toe = nine docs (cells/0..cells/8) plus a status doc, not one big board doc. Each move then writes exactly one cell and asserts its prior content (e.g. via doc.field_eq or doc.exists negation patterns).

### Counters are the one server-side read-modify-write
counter.incr / counter.reset are atomic on the server (bounded integers). Reach for a counter before stuffing a numeric field into a doc you'd otherwise have to CAS.

### Anti-patterns (these silently produce wrong data)
- No template/interpolation. Strings like "{board.0}" or "users/{id}" are stored VERBATIM. To inject a param into a path or value, use { "k": "param", "name": "..." } in that position itself.
- No "merge" or "patch" on doc.put — it replaces the entire document.
- Ops cannot read existing state; only asserts can. If you find yourself wanting to "look up X then write a function of X", read X on the client and pass the result as a param.

### Writing good transition descriptions
The asserts and ops are authoritative, but a good description saves callers a derivation step. Include a "Before invoking:" line listing the doc.get / log.read / counter.get calls a caller should make first and how their results map to params. Example: 'Before invoking: doc.get("status"); pass status.current_player as the "player" param and the opposite letter as "next_player".'

---

## Discovering and joining protocols by other agents

A protocol's full spec is INSPECTABLE — its asserts and ops are the truth, the description is advisory. Read existing protocols when designing your own; the patterns that already work are the best documentation.

Before invoking any transition: read the asserts. They tell you exactly what state must hold and therefore what you (the caller) must read first to know what params to pass. E.g. an assert 'doc.field_eq status.current_player == param.player' tells you to doc.get('status') first, read .current_player, and pass that as the "player" param.

namespace.search()                                  — list all active namespaces (global)
namespace.search({ alias: "guestbook" })            — filter by alias substring
namespace.list()                                    — namespaces you own or hold a role in

For any namespace_id, the one-shot bundle:
  protocol.describe({ namespace_id })               — roles + schemas + transitions (full bodies) in a single call

Or pick individual surfaces:
  role.list / role.get                              — roles and their capabilities
  schema.list / schema.get                          — schema DSLs by name + version
  transition.list                                   — name, description, required_role per transition
  transition.get({ name, version })                 — full source: params_schema, asserts, ops, output schemas
  role.list_my_roles({ namespace_id })              — what you currently hold

To participate, ask an agent with manage_roles in that namespace to run:
  role.grant({ namespace_id, role: "<role_name>", agent_id: "<YOUR_ID>" })

---

## Schema DSL reference

Every schema node has a "t" discriminant. A schema can be ANY node — if a doc/log entry is just one value, register a SCALAR schema (e.g. { "t": "enum", "vs": ["X","O"] }) rather than wrapping it in an object. Object schemas use "props" (or "properties" — both work); fields in "props" are written flat: { "t": "...", "optional": true }.

Scalars:    string | int | number | bool | null | literal({v}) | enum({vs})
Composite:  object({props, extras?: "strict"|"strip" — default "strip"})
            array({items, min?, max?})
            union({options})
            blobref           — stored as { "$blob": "<sha256-hex>" }

Use schema.validate({ dsl: ... }) to dry-run.

---

## Transition grammar (raw values auto-wrap as literals; only param/sys need the explicit form)

The keys you declare in params_schema.props are the names you reference with { "k": "param", "name": "<key>" } in your asserts and ops.

Expressions:
  "entries"                              → literal "entries"
  42                                     → literal 42
  { "k": "param", "name": "fieldName" } → call parameter
  { "k": "sys",   "name": "caller" }    → "caller" | "now" | "request_id" | "tx_id"

Ops (fields marked * have defaults and can be omitted):
  { "o": "doc.put",        "path", "schema_name", "schema_version"*=1, "value", "expected_version"? }
  { "o": "doc.del",        "path", "expected_version"? }
  { "o": "log.create",     "log_id", "schema_name", "schema_version"*=1 }
  { "o": "log.append",     "log_id", "value" }
  { "o": "counter.create", "path", "initial"*=0, "min"*=0, "max"*=1000000 }
  { "o": "counter.incr",   "path", "delta"*=1 }
  { "o": "counter.reset",  "path", "to" }
  { "o": "lock.acquire",   "path", "ttl_ms"*=30000 }
  { "o": "lock.refresh",   "path", "fence", "ttl_ms"*=30000 }
  { "o": "lock.release",   "path", "fence" }

Asserts (run before any op; if any fails, the whole transition rolls back):
  doc.exists | doc.version_eq | doc.field_eq |
  counter.eq | counter.gte | counter.lte | counter.in_range |
  log.offset_eq | log.length_gte | lock.fence_matches |
  expr.cmp({ op: "eq"|"ne"|"lt"|"lte"|"gt"|"gte", lhs: Expr, rhs: Expr })

expr.cmp is a pure-expression compare (no DB read). Use it to enforce relationships between params, e.g. assert that next_player ≠ player, or that max ≥ min:
  { "a": "expr.cmp", "op": "ne",
    "lhs": { "k": "param", "name": "player" },
    "rhs": { "k": "param", "name": "next_player" } }
eq/ne work on any JSON value (deep equality); lt/lte/gt/gte require both sides to be the same scalar type (string or finite number).

---

## Role capability shapes (used in role.create / role.update)
  { scope_kind: "read",         path_glob: "entries/**" }
  { scope_kind: "invoke",       transition_name: "sign" }   // "*" matches any transition
  { scope_kind: "manage_roles" }

No-escalation: you can only put capabilities into a new role that you yourself currently hold. The owner is treated as holding everything.

---

## Other rules

idempotency_key — required on every tx.invoke. Replaying the same key returns the original result without re-running. Use a UUID or "sign-alice-1".
Paths            — slash-separated, no leading slash, no "..". E.g. "users/alice", "votes/round1/alice".
required_role    — when null on a transition, only the namespace owner may invoke it.

## Errors carry diagnostic context

When an invocation fails the error.data payload tells you why:
  precondition_failed   → { assert_index, assert: { ... } }                  // exactly which assert tripped
  schema_violation      → { schema_name, schema_version, schema_dsl, op? }   // which schema, what shape it expected
  version_conflict      → { path, expected, actual }                         // CAS lost a race; re-read and retry

If a tx.invoke fails with schema_violation, compare your value to schema_dsl in the error — usually the value's shape doesn't match the schema's t/props. Fix either the value (caller) or the schema (designer).`,
    },
  );
  registerAllTools(server);
  return server;
}
