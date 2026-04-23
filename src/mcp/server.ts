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
agent-ledger is a durable, audited state store. All mutations are atomic and run inside a serializable database transaction. Every call is capability-gated.

## Quick mental model

  Namespace  →  Schema definitions  →  Transition definitions  →  tx.invoke
     |                                                                 |
     └── Capability grants (read / invoke) control who can do what    └── Writes docs, logs, counters, locks

A namespace is the top-level isolation boundary. Everything lives inside one.
Schemas define the shape of data. Transitions define the mutations that can happen.
Once you invoke a transition, docs/logs/counters are written atomically.

## First-time setup (you own the namespace)

1. namespace.create          — creates a namespace owned by you; you are implicitly admin
2. schema.register           — register data shapes (see Schema DSL below)
3. transition.register       — register named state-machine operations (see Transition Grammar below)
4. tx.invoke                 — execute a transition atomically; you need an invoke capability first
                               (as owner you can grant yourself one via capability.grant)

## Capability tiers

  Owner   — the agent that created the namespace; can grant/revoke admins and capabilities
  Admin   — can register schemas, transitions, policies; can grant/revoke read+invoke capabilities
  Read    — can call doc.get, log.read/head, counter.get, lock.inspect on matching path globs
  Invoke  — can call tx.invoke for a specific named transition

As namespace owner you start with full control. Grant yourself or others capabilities with capability.grant.

## Schema DSL (used in schema.register and transition params_schema)

Schemas are JSON objects with a "t" discriminant. Every field value in an object schema is wrapped in { s: <schema>, optional?: true }.

Scalar types:
  { "t": "string" }                          — any string
  { "t": "string", "min": 1, "max": 64 }    — bounded string
  { "t": "string", "format": "email" }       — format: "uuid" | "email" | "url" | "datetime"
  { "t": "int", "min": 0 }                   — integer
  { "t": "number" }                          — float
  { "t": "bool" }
  { "t": "null" }
  { "t": "literal", "v": "active" }          — exact value
  { "t": "enum", "vs": ["red","green","blue"] }

Composite types:
  { "t": "object", "extras": "strict", "props": {
      "name":   { "s": { "t": "string", "min": 1, "max": 64 } },
      "age":    { "s": { "t": "int", "min": 0 }, "optional": true }
  }}
  — "extras": "strict" rejects unknown keys; "strip" silently drops them

  { "t": "array", "items": { "t": "string" }, "min": 1, "max": 10 }

  { "t": "union", "options": [ { "t": "string" }, { "t": "null" } ] }

Example — register a colour vote schema:
  schema.register({
    namespace_id: "<id>",
    name: "colour_vote",
    version: 1,
    dsl: {
      "t": "object",
      "extras": "strict",
      "props": {
        "voter_id": { "s": { "t": "string", "format": "uuid" } },
        "colour":   { "s": { "t": "enum", "vs": ["red","green","blue","yellow"] } }
      }
    }
  })

## Transition Grammar (used in transition.register)

A transition has:
  params_schema   — an object schema (same DSL as above) describing the call parameters
  asserts         — zero or more precondition checks run before any mutation
  ops             — one or more mutations run atomically

### Expressions (used inside asserts and ops)

Every value position accepts an Expr:
  { "k": "lit",   "v": 42 }              — literal value
  { "k": "param", "name": "colour" }     — value of a call parameter
  { "k": "sys",   "name": "caller" }     — sys vars: "caller" | "now" | "request_id" | "tx_id"

### Assert kinds (all optional, checked before any mutation)
  { "a": "doc.exists",       "path": <Expr> }
  { "a": "doc.version_eq",   "path": <Expr>, "version": <Expr> }
  { "a": "doc.field_eq",     "path": <Expr>, "field": <Expr>, "value": <Expr> }
  { "a": "counter.eq",       "path": <Expr>, "value": <Expr> }
  { "a": "counter.gte",      "path": <Expr>, "value": <Expr> }
  { "a": "counter.lte",      "path": <Expr>, "value": <Expr> }
  { "a": "counter.in_range", "path": <Expr>, "min": <Expr>, "max": <Expr> }
  { "a": "log.offset_eq",    "log_id": <Expr>, "offset": <Expr> }
  { "a": "log.length_gte",   "log_id": <Expr>, "length": <Expr> }
  { "a": "lock.fence_matches","path": <Expr>, "fence": <Expr> }

### Op kinds (the mutations)
  { "o": "doc.put",       "path": <Expr>, "schema_name": "colour_vote", "schema_version": 1, "value": <Expr> }
  { "o": "doc.del",       "path": <Expr> }
  { "o": "log.create",    "log_id": <Expr>, "schema_name": "...", "schema_version": 1 }
  { "o": "log.append",    "log_id": <Expr>, "value": <Expr> }
  { "o": "counter.create","path": <Expr>, "initial": <Expr>, "min": <Expr>, "max": <Expr> }
  { "o": "counter.incr",  "path": <Expr>, "delta": <Expr> }
  { "o": "counter.reset", "path": <Expr>, "to": <Expr> }
  { "o": "lock.acquire",  "path": <Expr>, "ttl_ms": <Expr> }
  { "o": "lock.refresh",  "path": <Expr>, "fence": <Expr>, "ttl_ms": <Expr> }
  { "o": "lock.release",  "path": <Expr>, "fence": <Expr> }

Example — register a cast_vote transition that appends to a log:
  transition.register({
    namespace_id: "<id>",
    name: "cast_vote",
    version: 1,
    params_schema: {
      "t": "object", "extras": "strict",
      "props": {
        "colour": { "s": { "t": "enum", "vs": ["red","green","blue","yellow"] } }
      }
    },
    asserts: [],
    ops: [
      { "o": "log.append", "log_id": { "k": "lit", "v": "votes" }, "value": { "k": "param", "name": "colour" } }
    ]
  })

  (You would first need a log.create op in an init transition, or a separate init_votes transition.)

## Paths

Paths identify data within a namespace. Format: one or more slash-separated segments, no leading slash, no ".." traversal (e.g. "users/alice", "votes/2026"). Use consistent path conventions within your namespace.

## tx.invoke

  tx.invoke({
    namespace_id: "<id>",
    transition_name: "cast_vote",
    params: { "colour": "red" },
    idempotency_key: "<unique-per-call-string>"
  })

idempotency_key must be unique per logical operation. Replaying the same key returns the original result without re-running the transition. Use a UUID or a deterministic key (e.g. "vote-<user>-<round>").

## Reading data

  doc.get({ namespace_id, path })            — fetch a document
  log.read({ namespace_id, log_id, from_offset: "0", limit: 100 })
  log.head({ namespace_id, log_id })         — next offset + schema info
  counter.get({ namespace_id, path })
  lock.inspect({ namespace_id, path })

All read tools require a read capability on a path glob matching the target path.`,
    },
  );
  registerAllTools(server);
  return server;
}
