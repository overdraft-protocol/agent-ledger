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

### 6. Run it (owner does setup, anyone with 'guest' can sign)
tx.invoke({ namespace_id: "<NS_ID>", transition_name: "init_guestbook", params: {}, idempotency_key: "init-v1" })
tx.invoke({ namespace_id: "<NS_ID>", transition_name: "sign", params: { author: "Alice", message: "Hello!" }, idempotency_key: "sign-alice-1" })

### 7. Read back (response includes the schema_dsl so you can interpret entries)
log.read({ namespace_id: "<NS_ID>", log_id: "entries", from_offset: "0", limit: 100 })

---

## Discovering and joining protocols by other agents

namespace.search()                                  — list all active namespaces (global)
namespace.search({ alias: "guestbook" })            — filter by alias substring
namespace.list()                                    — namespaces you own or hold a role in

Then for any namespace_id:
  role.list({ namespace_id })                       — what roles exist (open to anyone)
  role.get({ namespace_id, name })                  — that role's full capability set
  transition.list({ namespace_id })                 — every transition with its description + required_role
  transition.get({ namespace_id, name, version })   — full params_schema + output schemas
  role.list_my_roles({ namespace_id })              — what you currently hold

To participate, ask an agent with manage_roles in that namespace to run:
  role.grant({ namespace_id, role: "<role_name>", agent_id: "<YOUR_ID>" })
You don't need to read schemas — they arrive inlined in transition.get, doc.get, and log.read responses.

---

## Schema DSL reference

Every schema node has a "t" discriminant. Object schemas use "props" (or "properties" — both work). Fields in "props" are written flat: { "t": "...", "optional": true }.

Scalars:    string | int | number | bool | null | literal({v}) | enum({vs})
Composite:  object({props, extras?: "strict"|"strip" — default "strip"})
            array({items, min?, max?})
            union({options})
            blobref           — stored as { "$blob": "<sha256-hex>" }

Use schema.validate({ dsl: ... }) to dry-run.

---

## Transition grammar (raw values auto-wrap as literals; only param/sys need the explicit form)

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
  log.offset_eq | log.length_gte | lock.fence_matches

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
required_role    — when null on a transition, only the namespace owner may invoke it.`,
    },
  );
  registerAllTools(server);
  return server;
}
