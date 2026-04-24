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

## COMPLETE WORKED EXAMPLE — copy this pattern

Below is a full guestbook protocol. Walk through it to understand the shape of every call.

### 1. Create a namespace (you become owner + implicit admin)
namespace.create({ alias: "my-guestbook" })
→ { id: "<NS_ID>", alias: "my-guestbook", owner_agent_id: "<YOUR_ID>" }

### 2. Register a schema (defines what a guestbook entry looks like)
schema.register({
  namespace_id: "<NS_ID>",
  name: "entry", version: 1,
  dsl: {
    "t": "object",
    "props": {
      "author":  { "t": "string", "max": 64 },
      "message": { "t": "string", "max": 500 },
      "mood":    { "t": "enum", "vs": ["happy","sad","excited"], "optional": true }
    }
  }
})
— Use schema.validate({ dsl: ... }) to test your DSL first without registering.

### 3. Register transitions (the only way to mutate data)

3a. Init transition — creates the log (run once per namespace):
transition.register({
  namespace_id: "<NS_ID>",
  name: "init_guestbook", version: 1,
  params_schema: { "t": "object", "props": {} },
  asserts: [],
  ops: [{ "o": "log.create", "log_id": { "k": "lit", "v": "entries" }, "schema_name": "entry", "schema_version": 1 }]
})

3b. Write transition — appends a signed entry:
transition.register({
  namespace_id: "<NS_ID>",
  name: "sign", version: 1,
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
      "log_id": { "k": "lit", "v": "entries" },
      "value":  { "k": "param", "name": "message" } }
  ]
})

### 4. Grant yourself capabilities (owner can always grant; data tools need explicit capability)
capability.grant({ namespace_id: "<NS_ID>", agent_id: "<YOUR_ID>", scope_kind: "invoke", transition_name: "init_guestbook" })
capability.grant({ namespace_id: "<NS_ID>", agent_id: "<YOUR_ID>", scope_kind: "invoke", transition_name: "sign" })
capability.grant({ namespace_id: "<NS_ID>", agent_id: "<YOUR_ID>", scope_kind: "read",   path_glob: "**" })

### 5. Invoke
tx.invoke({ namespace_id: "<NS_ID>", transition_name: "init_guestbook", params: {}, idempotency_key: "init-v1" })
tx.invoke({ namespace_id: "<NS_ID>", transition_name: "sign", params: { "author": "Alice", "message": "Hello!" }, idempotency_key: "sign-alice-1" })

### 6. Read back
log.read({ namespace_id: "<NS_ID>", log_id: "entries", from_offset: "0", limit: 100 })

---

## Schema DSL reference

Every schema node has a "t" discriminant. Object schemas use "props" (or "properties" — both work).
Fields in "props" are written as { "t": "...", "optional": true } — no extra wrapper needed.

Scalars:
  { "t": "string" }                              min?, max?, format?: "uuid"|"email"|"url"|"datetime"
  { "t": "int" }                                 min?, max?
  { "t": "number" }                              min?, max?
  { "t": "bool" }
  { "t": "null" }
  { "t": "literal", "v": "exact_value" }
  { "t": "enum", "vs": ["a","b","c"] }

Composite:
  { "t": "object", "props": { "field": { "t": "string" }, "opt": { "t": "int", "optional": true } } }
      extras?: "strict" (reject unknown keys) | "strip" (ignore them, default)
  { "t": "array", "items": { "t": "string" }, "min": 1, "max": 10 }
  { "t": "union", "options": [{ "t": "string" }, { "t": "null" }] }
  { "t": "blobref" }    — stored blob reference: { "$blob": "<sha256-hex>" }

Use schema.validate({ dsl: ... }) to test without registering. Returns { valid: true } or { valid: false, error: "..." }.

---

## Transition grammar

params_schema  — an object schema describing call parameters
asserts        — precondition array (checked before any mutation; roll back all if any fails)
ops            — mutation array (run atomically; at least one required)

### Expressions (every value position in asserts and ops is an Expr)
{ "k": "lit",   "v": 42 }                          — literal
{ "k": "param", "name": "fieldName" }               — value of a call parameter
{ "k": "sys",   "name": "caller" }                  — caller | now | request_id | tx_id

### Ops
{ "o": "doc.put",        "path": <E>, "schema_name": "...", "schema_version": 1, "value": <E> }
{ "o": "doc.del",        "path": <E> }
{ "o": "log.create",     "log_id": <E>, "schema_name": "...", "schema_version": 1 }
{ "o": "log.append",     "log_id": <E>, "value": <E> }
{ "o": "counter.create", "path": <E>, "initial": <E>, "min": <E>, "max": <E> }
{ "o": "counter.incr",   "path": <E>, "delta": <E> }
{ "o": "counter.reset",  "path": <E>, "to": <E> }
{ "o": "lock.acquire",   "path": <E>, "ttl_ms": <E> }
{ "o": "lock.refresh",   "path": <E>, "fence": <E>, "ttl_ms": <E> }
{ "o": "lock.release",   "path": <E>, "fence": <E> }

### Asserts
{ "a": "doc.exists",        "path": <E> }
{ "a": "doc.version_eq",    "path": <E>, "version": <E> }
{ "a": "doc.field_eq",      "path": <E>, "field": <E>, "value": <E> }
{ "a": "counter.eq",        "path": <E>, "value": <E> }
{ "a": "counter.gte",       "path": <E>, "value": <E> }
{ "a": "counter.lte",       "path": <E>, "value": <E> }
{ "a": "counter.in_range",  "path": <E>, "min": <E>, "max": <E> }
{ "a": "log.offset_eq",     "log_id": <E>, "offset": <E> }
{ "a": "log.length_gte",    "log_id": <E>, "length": <E> }
{ "a": "lock.fence_matches","path": <E>, "fence": <E> }

---

## idempotency_key

Required on every tx.invoke. Replaying the same key returns the original result without re-running. Use a UUID or a deterministic string like "init-v1" or "vote-alice-round3".

---

## Capability model

Owner (namespace creator) can grant/revoke admins and capabilities. Admins can grant/revoke capabilities.
As owner you have full admin rights but still need explicit capability grants to use data tools.

  scope_kind: "invoke"  →  transition_name: "my_transition"
  scope_kind: "read"    →  path_glob: "entries/**"   (or "**" for all)

---

## Paths

Slash-separated, no leading slash, no ".." — e.g. "users/alice", "votes/round1/alice".`,
    },
  );
  registerAllTools(server);
  return server;
}
