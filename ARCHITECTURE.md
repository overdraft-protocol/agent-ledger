# agent-ledger — Architecture

## One-line model

> **agent-ledger is a programmable, capability-secured, append-only datastore where protocols are declared as tuples of (schemas, transitions, policies) in hermetic namespaces. Data-plane state changes happen only through transitions. This makes a protocol's public interface exactly its transition set, and makes the server the sole enforcer of every behavioral invariant the protocol declares.**

Everything that follows is the precise unfolding of that sentence.

---

## Table of contents

1. [Design principles](#design-principles)
2. [Theoretical foundations](#theoretical-foundations)
3. [Vocabulary](#vocabulary)
4. [The two planes](#the-two-planes)
5. [Primitives](#primitives)
6. [Protocols](#protocols)
7. [Transitions](#transitions)
8. [Ownership and capabilities](#ownership-and-capabilities)
9. [Authentication](#authentication)
10. [Server-enforced invariants](#server-enforced-invariants)
11. [Storage schema](#storage-schema)
12. [Audit chain](#audit-chain)
13. [Threat model](#threat-model)
14. [Non-goals](#non-goals)
15. [Operational runbooks](#operational-runbooks)
16. [Project layout](#project-layout)
17. [Implementation stack](#implementation-stack)

---

## Design principles

1. **Unopinionated about protocols, opinionated about safety.** The server takes no position on what a protocol means. It takes strong positions on how data is validated, who may access it, and how transitions are composed.
2. **One mutation path.** All data-plane state changes happen through transitions. No tier bypasses, no escape hatches, no two-channel state change.
3. **Secure by default.** Where a default must be chosen, the choice is the one that fails closed. Raw primitive writes are refused universally; capabilities are grants, not defaults; audit is always on.
4. **Declarative over procedural.** Schemas, transitions, and policies are declarative rules stored in the namespace. No stored procedures, no server-side computation beyond parameter substitution.
5. **Hermetic namespaces.** A namespace is a trust boundary. No cross-namespace reads, no cross-namespace schema references, no ambient authority.
6. **Capabilities, not ACLs.** Authority is the possession of an unforgeable token naming a specific scope. Checks are local; there is no global identity oracle.
7. **Append-only history.** Every mutation is recorded in a hash-chained audit log within the same transaction as the mutation. The past is a write-once artifact.
8. **Minimum viable surface.** Each primitive, command, and invariant earns its existence by solving a problem that cannot be solved cheaply by composition of existing primitives.

---

## Theoretical foundations

Three traditions inform this architecture.

### Capability-based security
(Dennis & Van Horn 1966 → E language → Agoric → seL4 → Fuchsia Zircon.)
Authority is possession of an unforgeable token naming a specific object and operation. No ambient authority. Capabilities flow only by explicit grant. This is not ACLs: being "logged in" grants nothing.

### Declarative data with programmable invariants
(Codd 1970 → Datomic → differential dataflow.)
State is defined by rules. Schemas declare what valid data looks like; policies declare who can do what; transitions declare preconditions and atomic state changes. The server is a pure enforcer of declarative rules — no application code paths that can bypass invariants.

### Append-only event history
(Pat Helland's *Immutability Changes Everything* → Kreps on event sourcing.)
The log is the source of truth. The audit chain plus per-protocol logs give a causal, immutable history. State can be reconstructed by replay. Tamper-evidence emerges naturally from content-addressed and hash-chained storage without consensus.

### What this is not
- **Not a blockchain.** There is no consensus layer. Trust roots in the server operator.
- **Not a smart-contract platform.** Transitions are not Turing-complete. They express preconditions and atomic state changes, not computation.
- **Not a general-purpose OLTP database.** Primitives are higher-level; schemas, transitions, and policies are first-class artifacts; audit is intrinsic.

### The useful analogy
Transitions correspond to the ~85% of deployed smart contracts that actually do "check preconditions, update state, emit events." Solidity method bodies with `require()` statements map directly. The ~15% missing — arbitrary computation — is removed intentionally. Removing it eliminates reentrancy, gas, halting, and most classes of contract exploit.

| Solidity artifact | agent-ledger equivalent |
|---|---|
| `struct` / storage layout | Schemas |
| Access modifiers (`onlyOwner`, role checks) | Policies |
| Method bodies with `require(...)` | Transitions |
| `event` emission | Audit log entries |

---

## Vocabulary

Used consistently throughout the system, code, and documentation.

| Term | Meaning |
|---|---|
| **Primitive** | One of the substrate operations: `doc`, `log`, `counter`, `blob`, `lock`. The building blocks transitions are composed from. |
| **Transition** | A namespace-registered, parameterized, atomic, declaratively-specified state change. The public mutation interface of a protocol. |
| **Invocation** | A concrete call of a transition with concrete parameters by a specific agent. The unit of data-plane audit log entry. |
| **Command** | Any request an agent issues to the server. Covers reads, invocations, and control-plane operations. |
| **Schema** | A namespace-registered Zod definition with structural and cross-field constraints, exported to JSON Schema for the wire. |
| **Policy** | A namespace-registered rule governing read capability, invoke capability, and rate limits per path or per transition. |
| **Protocol** | The tuple `(Namespace, Schemas, Transitions, Policies)`. A fully declarative, inspectable, verifiable specification. |
| **Namespace** | The unit of isolation, ownership, and trust. Hermetic. |
| **Capability** | An unforgeable grant recording `(agent_id, namespace, scope)`. The basis of all authorization. |
| **Agent** | An identity holding capabilities. Maps 1:1 with an OAuth subject. |
| **Owner** | The unique, immutable tier-0 agent of a namespace. |
| **Admin** | A tier-1 agent; elevated by owner, revocable by owner. |
| **Control plane** | Operations that mutate the namespace's rule set: schemas, transitions, policies, capabilities, agents, namespaces themselves. |
| **Data plane** | Operations that mutate protocol state: docs, logs, counters, blobs, locks. Mutations exclusively via transitions. |

---

## The two planes

The system is split into two architecturally distinct planes. This split resolves the bootstrap paradox ("how is the first transition registered?") and makes the "only transitions mutate data" rule clean.

### Control plane

Operations that mutate a namespace's rule set and governance. Direct, capability-gated API. Finite, fixed set — not extensible by users.

- `schema.register`, `schema.deprecate`, `schema.get`, `schema.list`
- `transition.register`, `transition.deprecate`, `transition.get`, `transition.list`
- `policy.set`, `policy.get`, `policy.test`
- `cap.grant`, `cap.revoke`, `cap.list`
- `admin.grant`, `admin.revoke` (owner only)
- `namespace.create`, `namespace.describe`, `namespace.list`, `namespace.tombstone`, `namespace.purge` (purge: owner only; 24 h cooldown after tombstone)
- `agent.get_self`, `agent.describe`

All control-plane operations are audited identically to data-plane operations: they produce hash-chained audit entries. Control-plane operations are how the protocol itself evolves; that evolution must be visible.

### Data plane

Operations that mutate protocol state.

- **Mutations:** `tx.invoke(transition, params, idempotency_key)` only. There is no other mutation path.
- **Reads:** direct primitive calls — `doc.get`, `doc.query`, `log.read`, `log.tail`, `counter.get`, `blob.get`, `lock.inspect`. Capability-gated.

No raw primitive writes exist for any tier. Owners, admins, and tier-2 agents all mutate data-plane state through `tx.invoke`. If an admin needs to perform an ad-hoc correction, they register a transition for it (control plane), invoke it (data plane), and deprecate it when no longer needed.

---

## Primitives

Each primitive is justified by an access pattern or atomicity guarantee that cannot be cheaply emulated by other primitives. Five data-plane primitives; three control-plane artifacts; one internal.

### `doc` — typed JSON documents
- **Access patterns:** point get by `(namespace, path)`, CAS put, JSON Patch, indexed query, cursor scan.
- **Schema:** every doc references a registered schema and version. Writes validate against that version; reads return the version-stamped payload.
- **Indexing:** declared via `x-index` on schema fields. GIN + btree composites. Arbitrary jsonb path queries are refused.
- **Size cap:** 256 KiB inline. Larger values must be stored as blobs and referenced via `blobRef`.

### `log` — dense append-only event streams
- **Justification:** a log is a doc sequence with an append-only, offset-ordered, tailable access pattern. Emulating it with docs + counters is 3× the operations per write and an index lookup per read.
- **One schema per log.** Registered at `log.create`. Enforced on every append.
- **Dense offsets.** Assigned via a row-locked per-log counter, not a Postgres `SEQUENCE`. No gaps, even on rolled-back transactions. This property is load-bearing for audit and replay.
- **Tail.** `log.tail` uses a single shared `LISTEN` connection fanned out in-process to subscribers. Per-token concurrency cap; 60 s idle timeout.

### `counter` — atomic bounded integers
- **Justification:** `UPDATE counters SET n = n + $1 WHERE n + $1 BETWEEN min AND max RETURNING n` is a single round trip with row locking. Emulation via `doc.cas` degrades to O(writers²) under contention.
- **Bounds declared at creation.** Violations error explicitly; no silent clamping.
- **64-bit signed.** Overflow documented.

### `blob` — content-addressed binary storage
- **Justification:** >64 KiB payloads in `jsonb` kill index and scan performance. Content-addressing gives dedup, immutability, and audit references for free.
- **Hashing server-side.** Client-supplied hashes are never trusted.
- **Filesystem-backed**, two-level sharded (`aa/bb/aabbcc...`). No S3 initially.
- **Reference counting is transactional and typed.** Blobs are referenced only via `z.blobRef()` schema-typed fields. Writes incrementing a ref and deletes decrementing one happen in the same transaction as the containing mutation. Zero-ref blobs are swept by a background task.
- **Size cap on put:** 4 MiB per call (JSON-RPC base64 overhead makes anything larger impractical). Larger is out of scope for v1.

### `lock` — fenced exclusion leases
- **Justification:** distributed locking is error-prone in three specific, well-known ways (race on acquire, stale holder, wrong-owner release). A dedicated primitive bakes the correct pattern in as the only available API.
- **Commands:** `lock.acquire(path, ttl_ms)`, `lock.refresh(path, fence, ttl_ms)`, `lock.release(path, fence)`, `lock.inspect(path)`.
- **Fencing tokens mandatory.** Every successful `acquire` yields a globally monotonic `fence` from a `bigint` sequence. Transitions that write under a lock must carry the fence as an `assert` precondition.
- **Server-side time only.** All TTL arithmetic uses Postgres `now()`. Clients never compare wall clocks to server timestamps.
- **TTL bounds:** `[1 s, 1 h]`. Longer work re-acquires.
- **Single-statement acquire.** `INSERT ... ON CONFLICT DO UPDATE WHERE expires_at < now()` — Postgres row locks serialize concurrent acquires; a fresh fence is issued on takeover so stale-holder writes are structurally rejected.

### Control-plane artifacts

#### `schema`
Zod definition + JSON Schema export. Immutable from the instant of registration — there is no "unreferenced edit" loophole. New version = new registration.

#### `transition`
See [Transitions](#transitions). Immutable on registration; new version = new registration. Deprecation marks as "no new invocations" but does not retroactively invalidate existing audit entries.

#### `policy`
Per-path / per-transition rules governing read capability, invoke capability, and rate limits. Stored as JSON, evaluated by a single function used by both `policy.test` and the runtime enforcement middleware.

### Internal: `audit`
Always-on, hash-chained, per-namespace. One row per control-plane or data-plane mutation, written in the same transaction as the mutation. Read via `audit.read(from, limit)` and `audit.verify(range)`. Exposes `audit.head(namespace)` for external anchoring. Partitioned by month.

---

## Protocols

A protocol is declared as:

```
Protocol := (Namespace, Schemas, Transitions, Policies)
```

All four parts live in the namespace, are registered via control-plane operations, and are discoverable by any agent with `read` capability on the namespace.

### Interaction model

- Agents read via direct primitive calls (capability-gated).
- Agents mutate state via `tx.invoke(transition, params)`. There is no other way.
- Agents discover a protocol's interface via `schema.list`, `transition.list`, `policy.get`.
- Agents verify a protocol's history via `audit.read` and `audit.verify`.

### Composition across protocols (hermetic boundary)

Namespaces are hermetic. A protocol in namespace A cannot read, reference, or trust anything in namespace B directly. Protocols that interoperate do so via a **bridge agent** holding capabilities in both namespaces. The bridge is the only trust edge; both namespaces log its activity.

This is the only approved cross-namespace pattern.

---

## Transitions

### Shape

A transition declaration has four parts:

```
transition <namespace>/<name>:
  params:     Zod schema for caller-supplied parameters
  asserts:    Declarative preconditions (evaluated before any op)
  ops:        Ordered list of primitive operations with parameter slots
  # + metadata: version, description, deprecated_at
```

### Parameters

Two sources only:

- **Caller-supplied:** named slots like `{amount}`, `{from}`. Validated against the params schema.
- **System-injected:** `{caller}` (invoking agent id), `{now}` (server timestamp), `{request_id}`, `{tx_id}`. The server supplies these; the caller cannot override them.

No arithmetic in parameter slots. If a transition needs computed values, the caller computes them client-side and passes the result as a parameter (subject to the params schema's validation).

### Asserts

A fixed grammar of precondition types:

- `doc.exists`, `doc.version_eq`, `doc.field_eq`
- `counter.eq`, `counter.gte`, `counter.lte`, `counter.in_range`
- `log.offset_eq`, `log.length_gte`
- `lock.fence_matches`, `lock.held_by`
- `capability.holds` (caller holds this capability on this path)
- `blob.exists`

Asserts are evaluated inside the transaction, after acquiring row locks on the referenced rows, before any op executes. Any failed assert → `ROLLBACK`, response `precondition_failed`.

### Ops

Each op is a primitive call with parameter slots. The set of permitted ops inside a transition is exactly the set of primitive mutation operations:

- `doc.put`, `doc.patch`, `doc.del`
- `log.append`
- `counter.incr`, `counter.reset`
- `blob.put` (rare in transitions; usually blobs are put separately and referenced)
- `lock.acquire`, `lock.refresh`, `lock.release`

Each op's arguments are either literal values or parameter substitutions.

### Execution model (`tx.invoke`)

1. Load the named transition. If deprecated or missing → `transition_unavailable`.
2. Validate `params` against the transition's param schema.
3. Check `idempotency_key`. If present in the idempotency table for this agent → return stored result.
4. BEGIN transaction at `SERIALIZABLE`.
5. Acquire row locks for every row any assert or op will touch.
6. Evaluate asserts in declaration order. Any failure → ROLLBACK, return `precondition_failed`.
7. Execute ops in declaration order. Each op runs its primitive's validation (schema, path grammar, policy). Any failure → ROLLBACK.
8. Write the audit entry (same transaction). Audit entry records transition name, params, caller, tx_id, prev_hash, new chain hash.
9. Store idempotency result keyed by `(agent_id, idempotency_key)`.
10. COMMIT.

### Flat composition only

Transitions cannot call other transitions. If you need to compose, write one larger transition. This keeps the audit log's "one invocation = one named event" property and removes a class of reasoning problems.

### Registration and immutability

- `transition.register` requires admin.
- Transitions are immutable on registration. Re-registering a name is an error.
- New behavior → new name or explicit version suffix.
- `transition.deprecate` marks a transition as unavailable for new invocations but preserves its definition for audit log interpretability.

---

## Ownership and capabilities

### Three tiers

```
                    ┌──────────┐
                    │  Owner   │    Tier 0 — immutable, unique per ns
                    └────┬─────┘
                         │  admin.grant / admin.revoke
                         ▼
                    ┌──────────┐
                    │  Admin   │    Tier 1 — owner-granted, owner-revocable
                    └────┬─────┘
                         │  cap.grant (path-scoped, non-wildcard)
                         ▼
                    ┌──────────┐
                    │  Agent   │    Tier 2 — holders of operational capabilities
                    └──────────┘
```

### Tier 0 — Owner

Immutable, unique, unrevokable. Holds the full Tier 1 capability set plus three meta-capabilities that exist nowhere else:

- `admin.grant`
- `admin.revoke`
- `namespace.purge`

Owner's agent record cannot be deleted while any namespace back-references it (enforced by FK).

### Tier 1 — Admin

Grantable by owner, revocable by owner. Cannot grant admin (no transitive elevation). Admins hold:

- All control-plane operations except `admin.grant`/`admin.revoke`/`namespace.purge`
- Implicit read/write access to the entire namespace *for invoking transitions* — but admins still invoke via transitions like everyone else
- `cap.grant` / `cap.revoke` restricted to non-admin capabilities with path globs that are not namespace-wide wildcards

Admin is a role flag on `(agent_id, namespace_id)`, not a capability bundle. Admin cannot be assembled by accumulating fine-grained capabilities.

### Tier 2 — Operational agents

Hold zero or more capabilities per namespace. Each capability is a record:

```
{
  agent_id, namespace_id,
  scope: {
    kind: "read" | "invoke",
    path_glob? (for read),
    transition_name? (for invoke)
  },
  granted_by, granted_at,
  expires_at?
}
```

Reads are path-scoped. Invocations are transition-scoped. An agent invokes a transition only if they hold an `invoke` capability for that transition; the transition's own asserts may then further restrict via `capability.holds` checks on specific paths.

### Grant invariants

- Only admin and owner may grant.
- Admin cannot grant admin (single-source elevation; no transitivity).
- Grants of namespace-wide wildcard path globs (`**`) are refused for non-admin capabilities.
- Every grant records `granted_by` and `granted_at` for audit and cascade-revocation.
- Revocation of an admin does not auto-cascade that admin's prior grants. Owners use `cap.list(granted_by: <agent>)` + `cap.revoke_bulk` as a deliberate recovery action.

---

## Authentication

### Identity via OAuth 2.1

Ory Hydra is the authorization server. Agent identity = OAuth subject. The agent-ledger server is a pure resource server: it verifies tokens, maps scopes to capabilities, and enforces.

### Token verification

- Access tokens are JWTs signed by Hydra.
- JWKS keys cached locally with a 5-minute TTL.
- Access token TTL: **5 minutes**. Short window bounds revocation lag.
- Resource indicators (RFC 8707) bind tokens to this server; replay elsewhere is impossible.
- Refresh tokens via Hydra per the standard flow.

### Scope-to-capability mapping

Hydra issues coarse scopes of the form `agent:<agent_id>`. The agent-ledger server maintains its own capability store (Postgres). Per request:

1. Verify JWT → obtain `agent_id`.
2. Look up agent's active capabilities.
3. Enforce per-tool capability requirement.

Capability changes never require redeployment of Hydra.

### Emergency revocation

JWTs cannot be retracted before expiry. For emergencies:

- In-process blocklist of revoked JTIs.
- Populated from Hydra's revocation endpoint, polled every 10 s.
- Accepted revocation lag: ≤ 10 s + network RTT.

### Bootstrap

Chicken-and-egg: full OAuth means no namespace exists without an authenticated agent, but no agent has capabilities until an owner exists.

**Resolution:** a one-shot bootstrap CLI (`npm run bootstrap`). It:

1. Refuses to run if any agents exist in the DB.
2. Creates a root `agent_id`.
3. Prints Hydra client credentials the operator must install in Hydra (out-of-band).
4. Marks the database as bootstrapped (a row in `system_state`).

After first run, the CLI checks the bootstrap row and refuses. Single documented door, closed forever once used.

### Hydra outage behaviour

- Existing sessions with unexpired tokens continue to work for up to the token TTL (5 minutes).
- New tokens cannot be minted.
- JWKS key rotation during outage is survivable for the cache TTL (5 min).
- Accepted degradation, not a bug to engineer around.

---

## Server-enforced invariants

The complete set. Every invariant has an enforcement point in code and a threat it closes. Property-tested where feasible.

### Isolation and serializability

| # | Invariant | Threat closed |
|---|---|---|
| I1 | `tx.invoke` executes at `SERIALIZABLE` isolation. | Concurrent transitions cannot violate each other's asserts. |
| I2 | Row locks for all asserted and mutated rows acquired before assert evaluation. | TOCTOU between assert and op. |

### Idempotency

| # | Invariant | Threat closed |
|---|---|---|
| I3 | Every `tx.invoke` requires an `idempotency_key`. Stored `(agent_id, key) → result` for 24 h. | Double-apply on network-dropped acks and retries. |

### Transitions

| # | Invariant | Threat closed |
|---|---|---|
| I4 | All data-plane mutations go through `tx.invoke`. No raw primitive writes exist for any tier. | Two-channel state change; privilege bypass. |
| I5 | Transitions are immutable once registered. | Silent protocol rule changes. |
| I6 | Transition ops are a fixed grammar; no Turing-completeness. | Reentrancy, gas, halting, side-effectful computation. |
| I7 | Parameters are substituted only into pre-approved slots. | Injection into op arguments. |
| I8 | Transitions cannot call other transitions. | Reasoning explosion; audit-log ambiguity. |

### Schema

| # | Invariant | Threat closed |
|---|---|---|
| I9 | Schemas are immutable on registration. | Retroactive rule changes affecting existing data. |
| I10 | Every typed primitive instance references a registered schema and version. | Unvalidated data entering storage. |
| I11 | Schema validation time budget: 50 ms soft / 200 ms hard per operation. | Validator-based DoS via pathological schemas. |
| I12 | Schema size ≤ 64 KiB; max depth 32. | Oversized registrations; recursive schemas. |

### Policy

| # | Invariant | Threat closed |
|---|---|---|
| I13 | Path language is prefix + single-segment `*` + suffix `**`. No regex. | ReDoS via crafted policy rules. |
| I14 | `policy.test` and runtime enforcement call the same evaluator function. | Dev-time tests diverging from production enforcement. |

### Locks and fencing

| # | Invariant | Threat closed |
|---|---|---|
| I15 | Every `lock.acquire` issues a fresh fence from a monotonic sequence. | Stale-holder writes after TTL expiry. |
| I16 | `tx.invoke` asserts may require `lock.fence_matches`; checked inside the transaction. | Lock-gated transitions executing without the lock. |
| I17 | Lock TTL bounded `[1 s, 1 h]`. | Sub-millisecond meaningless acquires; year-long stuck locks. |
| I18 | All TTL arithmetic server-side via `now()`. | Clock-skew–induced false expiries. |

### Logs

| # | Invariant | Threat closed |
|---|---|---|
| I19 | Log offsets are dense (no gaps). Assigned via a row-locked per-log counter. | Replay ambiguity; phantom gaps mistaken for tampering. |
| I20 | `log.tail` has per-token concurrency limits and 60 s idle timeout. | Resource exhaustion via abandoned tails. |

### Blobs

| # | Invariant | Threat closed |
|---|---|---|
| I21 | Blob hash is computed server-side; client-supplied hashes are ignored. | Hash forgery; false integrity claims. |
| I22 | Blob refs are typed schema fields (`blobRef`); ref-counting is transactional with the containing mutation. | Blob GC racing with new references. |
| I23 | Blob put size ≤ 4 MiB per call. | In-memory buffering DoS. |

### Paths

| # | Invariant | Threat closed |
|---|---|---|
| I24 | Paths are NFC-normalized UTF-8, `[a-zA-Z0-9._\-/]`, no leading/trailing `/`, no `..`, no empty segments, no control chars. ≤ 512 bytes, ≤ 32 segments. Case-sensitive. | Unicode look-alike attacks; path traversal confusion. |

### Query safety

| # | Invariant | Threat closed |
|---|---|---|
| I25 | `doc.query` predicates restricted to equality and range on `x-index`–declared fields. | Arbitrary-predicate DoS. |
| I26 | Pagination cursors are HMAC-signed opaque strings. | Cursor forgery to skip policy or scan expensive ranges. |

### Rate limiting

| # | Invariant | Threat closed |
|---|---|---|
| I27 | Per-tool cost weights; token bucket debits by weight. | Denial-of-wallet via expensive ops with valid credentials. |
| I28 | Rate limit buckets stored in Postgres (upsert on `(token, window_second)`). | Diverging buckets across server processes. |

### Audit

| # | Invariant | Threat closed |
|---|---|---|
| I29 | Audit row inserted in the same transaction as the mutation. Hash computed via `pgcrypto`. | Post-commit audit gap on crash. |
| I30 | Audit log partitioned monthly from day one. | Single-table vacuum pathologies at scale. |
| I31 | `audit.head(namespace)` is exposed for external anchoring. | Path to tamper-proofness without building it now. |

### Capabilities

| # | Invariant | Threat closed |
|---|---|---|
| I32 | Admin cannot grant admin. | Transitive privilege escalation. |
| I33 | Namespace-wide wildcard (`**`) grants refused for non-admin capabilities. | De-facto admin creation via over-broad grants. |
| I34 | Owner is immutable; owner agent record deletion blocked by FK. | Namespace orphaning. |

### Namespace lifecycle

| # | Invariant | Threat closed |
|---|---|---|
| I35 | Namespace deletion is two-phase: `tombstone` (reversible) then `purge` (owner-only, 24 h cooldown). | Single-keystroke destruction of a ledger. |

### Request correlation

| # | Invariant | Threat closed |
|---|---|---|
| I36 | Every request has a server-generated `request_id` propagated into audit rows, logs, and traces. | Unreconstructable cross-agent interactions. |

---

## Storage schema

PostgreSQL 17. Extensions: `pgcrypto`, `pg_stat_statements`, `btree_gin`. Durability: `wal_level=replica`, `synchronous_commit=on`, `fsync=on`, `full_page_writes=on`.

Schema is illustrative; exact DDL is generated from TypeScript types.

```sql
-- ====== Identity and governance ======

CREATE TABLE agents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oauth_subject     text UNIQUE NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  disabled_at       timestamptz
);

CREATE TABLE namespaces (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_agent_id    uuid NOT NULL REFERENCES agents(id),
  alias             text,                             -- scoped to owner, not globally unique
  created_at        timestamptz NOT NULL DEFAULT now(),
  tombstoned_at     timestamptz,
  UNIQUE (owner_agent_id, alias)
);

CREATE TABLE admins (
  namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  agent_id          uuid NOT NULL REFERENCES agents(id),
  granted_by        uuid NOT NULL REFERENCES agents(id),
  granted_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace_id, agent_id)
);

CREATE TABLE capabilities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  agent_id          uuid NOT NULL REFERENCES agents(id),
  scope_kind        text NOT NULL CHECK (scope_kind IN ('read','invoke')),
  path_glob         text,                             -- for read
  transition_name   text,                             -- for invoke
  granted_by        uuid NOT NULL REFERENCES agents(id),
  granted_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz
);

CREATE INDEX capabilities_agent_ns ON capabilities(agent_id, namespace_id);
CREATE INDEX capabilities_granted_by ON capabilities(granted_by);

-- ====== Control plane ======

CREATE TABLE schemas (
  namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  name              text NOT NULL,
  version           int  NOT NULL,
  json_schema       jsonb NOT NULL,
  zod_source        text  NOT NULL,                   -- the source-of-truth Zod definition
  registered_at     timestamptz NOT NULL DEFAULT now(),
  registered_by     uuid NOT NULL REFERENCES agents(id),
  deprecated_at     timestamptz,
  PRIMARY KEY (namespace_id, name, version)
);

CREATE TABLE transitions (
  namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  name              text NOT NULL,
  version           int  NOT NULL,
  params_schema     jsonb NOT NULL,
  asserts           jsonb NOT NULL,
  ops               jsonb NOT NULL,
  registered_at     timestamptz NOT NULL DEFAULT now(),
  registered_by     uuid NOT NULL REFERENCES agents(id),
  deprecated_at     timestamptz,
  PRIMARY KEY (namespace_id, name, version)
);

CREATE TABLE policies (
  namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  rule              jsonb NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid NOT NULL REFERENCES agents(id),
  PRIMARY KEY (namespace_id, id)
);

-- ====== Data plane ======

CREATE TABLE docs (
  namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  path              text NOT NULL,
  schema_name       text NOT NULL,
  schema_version    int  NOT NULL,
  value             jsonb NOT NULL,
  version           bigint NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace_id, path),
  FOREIGN KEY (namespace_id, schema_name, schema_version)
      REFERENCES schemas(namespace_id, name, version)
);

CREATE INDEX docs_value_gin ON docs USING GIN (value jsonb_path_ops);

CREATE TABLE logs (
  namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  log_id            text NOT NULL,
  schema_name       text NOT NULL,
  schema_version    int  NOT NULL,
  next_offset       bigint NOT NULL DEFAULT 0,         -- row-locked counter
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace_id, log_id)
);

CREATE TABLE log_entries (
  namespace_id      uuid NOT NULL,
  log_id            text NOT NULL,
  offset_id         bigint NOT NULL,
  value             jsonb NOT NULL,
  appended_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace_id, log_id, offset_id),
  FOREIGN KEY (namespace_id, log_id) REFERENCES logs(namespace_id, log_id) ON DELETE CASCADE
);

CREATE TABLE counters (
  namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  path              text NOT NULL,
  n                 bigint NOT NULL,
  min_value         bigint NOT NULL,
  max_value         bigint NOT NULL,
  PRIMARY KEY (namespace_id, path)
);

CREATE TABLE blobs (
  sha256            bytea PRIMARY KEY,
  size_bytes        bigint NOT NULL,
  content_type      text,
  stored_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE blob_refs (
  namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  sha256            bytea NOT NULL REFERENCES blobs(sha256),
  ref_count         bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (namespace_id, sha256)
);

CREATE TABLE locks (
  namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  path              text NOT NULL,
  owner_agent_id    uuid NOT NULL REFERENCES agents(id),
  fence             bigint NOT NULL,
  expires_at        timestamptz NOT NULL,
  acquired_at       timestamptz NOT NULL,
  PRIMARY KEY (namespace_id, path)
);

CREATE SEQUENCE lock_fence_seq;

-- ====== Audit (partitioned monthly) ======

CREATE TABLE audit_log (
  namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  seq               bigint NOT NULL,                 -- dense per-namespace offset
  created_at        timestamptz NOT NULL DEFAULT now(),
  actor_agent_id    uuid NOT NULL REFERENCES agents(id),
  request_id        uuid NOT NULL,
  plane             text NOT NULL CHECK (plane IN ('control','data')),
  kind              text NOT NULL,                   -- e.g. "transition.invoke", "schema.register"
  payload           jsonb NOT NULL,
  prev_hash         bytea NOT NULL,
  chain_hash        bytea NOT NULL,
  PRIMARY KEY (namespace_id, seq, created_at)
) PARTITION BY RANGE (created_at);

-- Example partition; creation automated by migration runner
CREATE TABLE audit_log_2026_04 PARTITION OF audit_log
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

-- ====== Infrastructure ======

CREATE TABLE idempotency (
  agent_id          uuid NOT NULL REFERENCES agents(id),
  key               text NOT NULL,
  result            jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  PRIMARY KEY (agent_id, key)
);

CREATE INDEX idempotency_expires ON idempotency(expires_at);

CREATE TABLE rate_buckets (
  agent_id          uuid NOT NULL REFERENCES agents(id),
  window_second     bigint NOT NULL,
  cost_consumed     bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, window_second)
);

CREATE TABLE system_state (
  key               text PRIMARY KEY,
  value             jsonb NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- Used for: bootstrap flag, JWKS cache, revocation blocklist snapshots.
```

---

## Audit chain

### Structure

Each namespace has its own chain. Entry shape:

```
entry = {
  namespace_id, seq, created_at,
  actor_agent_id, request_id,
  plane ("control" | "data"),
  kind (e.g. "transition.invoke", "schema.register"),
  payload (JSON; transition name + params, or control-op details),
  prev_hash,
  chain_hash = sha256(prev_hash || canonical_json(entry_without_chain_hash))
}
```

Genesis entry: `prev_hash = sha256(namespace_id || created_at)`.

### Guarantees

- **Atomic with mutation.** Audit row is INSERTed in the same transaction as the mutation. Crashes mid-tx → Postgres rolls back both.
- **Tamper-evident.** Any modification to a prior entry breaks the chain at that point. `audit.verify` detects and returns the first diverging `seq`.
- **Not tamper-proof.** An adversary with DB write access can rewrite end-to-end. For tamper-proofness, the operator anchors `audit.head(namespace)` externally (published to another system, signed, etc.). This is not built in v1.

### Access

- `audit.read(from_seq, limit)` — read entries.
- `audit.verify(from_seq, to_seq)` — recompute chain, return first divergence.
- `audit.head(namespace)` — current chain head, for external anchoring.

Read requires `read` capability on the namespace.

---

## Threat model

### In scope

- **Compromised Tier 2 agent token.** Attacker holds a valid agent token. Mitigated by: capability scoping, path-restricted grants, rate limits, template-only mutation, short token TTL.
- **Compromised admin token.** Attacker can register malicious schemas/transitions/policies. Mitigated by: owner can revoke admin and cascade-revoke grants; audit trail identifies attacker actions; short token TTL bounds damage window.
- **Agent race conditions.** Concurrent invocations. Mitigated by: serializable isolation, row locks, lock fencing, dense log offsets, CAS on docs.
- **Lost network acks causing retries.** Mitigated by: mandatory idempotency keys on `tx.invoke`, stored results for 24 h.
- **Denial of service via expensive operations.** Mitigated by: per-tool cost weighting, rate limits, query predicate restrictions, pagination cursor signing, validation time budgets.
- **Path traversal / Unicode attacks.** Mitigated by: strict path grammar, NFC normalization, allow-list character set.
- **Cursor forgery.** Mitigated by: HMAC-signed opaque cursors.
- **Accidental data loss.** Mitigated by: two-phase namespace delete (tombstone → 24 h cooldown → purge).
- **Post-hoc audit tampering by a non-DB-admin attacker.** Mitigated by: hash-chained audit.

### Out of scope

- **Compromised DB administrator.** A party with direct Postgres write access can rewrite any data including the audit chain. Mitigation: operate Postgres with least-privilege DB users, segregate backups, and (if required) anchor `audit.head` externally. Not built in v1.
- **Compromised server operator.** The operator is the trust root. Full compromise = full compromise. This is the defining limit of the centralized model.
- **Side-channel attacks on the server host.** Out of scope; standard host hardening assumed.
- **Byzantine tolerance.** Not a goal of this system. If required, rearchitect as a replicated state machine.
- **Defense against owner key loss.** Owners are immutable and unrecoverable. If an owner loses their Hydra credentials, their namespace is orphaned. Operational mitigation: owners hold multiple Hydra clients tied to the same subject, or the operator cooperates on recovery out-of-band.

### Non-goals of the auth layer

- **Ambient authority.** Every request must present a token with capabilities.
- **Federated identity across namespaces.** The same agent in two namespaces holds two independent capability sets.
- **Delegation beyond admin.** No sub-delegation; admins cannot grant admin; capabilities cannot be re-granted by their holders.

---

## Non-goals

Explicit list so contributors don't re-derive these decisions.

- **No Turing-complete transitions.** Computation happens on clients; the server validates and commits.
- **No cross-namespace reads or writes.** Interoperation uses bridge agents holding capabilities in both namespaces.
- **No capability sub-delegation.** Grants are single-hop from admin to agent.
- **No multi-owner namespaces (M-of-N).** Single immutable owner per namespace. This may be revisited as a separate architectural pass, not a v1 add-on.
- **No automatic cascade-revocation on admin demotion.** Deliberate recovery action via `cap.revoke_bulk`.
- **No Redis or other external cache.** Rate limits, idempotency, and auth state all live in Postgres.
- **No S3 or cloud blob backend in v1.** Filesystem only.
- **No multipart/streaming blob upload endpoint in v1.** 4 MiB cap via JSON-RPC.
- **No external audit anchoring in v1.** `audit.head` is exposed for operators who want to build this on top.
- **No BFT replication.** Single-server, single-Postgres. Horizontal scaling is N stateless Node processes sharing one Postgres.
- **No general-purpose stored procedures.** Transitions are declarative; no user-supplied code runs on the server.
- **No ORM.** Kysely or plain SQL via `pg`. Zod is the type source; DB types are generated.

---

## Operational runbooks

### Bootstrap a fresh installation

1. Provision PostgreSQL 17 with `pgcrypto`, `pg_stat_statements`, `btree_gin`.
2. Run migrations to create schema.
3. Start Ory Hydra (docker-compose) and configure issuer URL.
4. Run `npm run bootstrap`. The CLI:
   - Creates the root `agent_id`.
   - Prints Hydra client credentials.
   - Writes `system_state.bootstrapped = true`.
5. Register the Hydra client using the printed credentials (out-of-band, via Hydra admin API).
6. Obtain a token as the root agent; verify by calling `namespace.list`.
7. Bootstrap CLI refuses to run again.

### Create a new protocol

1. Authenticate as the intended owner.
2. `namespace.create({alias: "<name>"})` → returns `namespace_id`.
3. `schema.register` each schema the protocol needs.
4. `transition.register` each transition.
5. `policy.set` for reads and invoke permissions.
6. `cap.grant` to the agents that will participate.
7. Publish the protocol's namespace ID; other agents can `schema.list`, `transition.list`, `policy.get` to discover the interface.

### Backup and restore

Blob store and Postgres must be backed up with a specific ordering. Content-addressing makes this lossless when done correctly.

1. `pg_dump` first. This captures the blob ref table as of time T.
2. `rsync` blob store to backup location.
3. On restore:
   - Restore Postgres.
   - Restore blob store.
   - Any blobs referenced by Postgres *must* exist.
   - Any blobs on disk not referenced are orphans; sweep via the GC task.

Content-addressing guarantees that if a blob exists with the expected hash, it is correct. There is no possibility of a "wrong" blob being restored.

### Database migrations

Plain-SQL migrations via `postgrator`-class runner. Migrations are numbered and append-only. Rollbacks are forward-only — a "rollback" is a new migration that undoes the previous. Applied atomically within transactions where possible.

Applied on process start, before the HTTP server begins accepting connections.

### Hydra outage

- Existing sessions continue until their token TTL expires (≤ 5 min).
- JWKS cache survives for 5 min after Hydra becomes unreachable.
- New token issuance is unavailable during the outage.
- Post-restoration: no manual action required; cache repopulates on next request.

### Emergency revocation

To revoke a specific token immediately:

1. Call Hydra's revocation endpoint for the JTI.
2. The in-process blocklist picks up the revocation within 10 s.

To revoke a compromised admin and their grants:

1. `admin.revoke(agent_id)` (owner only).
2. `cap.list({granted_by: agent_id})` → review.
3. `cap.revoke_bulk({granted_by: agent_id})` if cascade is required.

### Graceful shutdown

On SIGTERM:

1. Stop accepting new HTTP connections.
2. Drain active `log.tail` subscribers (close with reason).
3. Wait for in-flight transactions, bounded by a timeout (30 s). Abort remainder.
4. Close Postgres pool.
5. Exit.

---

## Project layout

```
src/
  server/                 transport, middleware, auth
    http.ts               Hono app (or Fastify)
    auth/
      verify.ts           JWT + JWKS cache
      capabilities.ts     token → capability resolution
      blocklist.ts        revocation polling
    rate-limit.ts
    request-context.ts    request_id, tracing, origin tagging
  mcp/                    MCP binding
    server.ts             @modelcontextprotocol/sdk server
    tools/
      namespace.ts
      schema.ts
      transition.ts
      policy.ts
      cap.ts
      doc.ts              reads only
      log.ts              reads + tail
      counter.ts          reads only
      blob.ts             reads + put
      lock.ts              reads only (inspect)
      tx.ts               tx.invoke
      audit.ts
  core/                   primitives (pure logic, storage-agnostic)
    doc.ts
    log.ts
    counter.ts
    blob.ts
    lock.ts
    schema.ts             registry, Zod ↔ JSON Schema
    transition.ts         registration, execution model
    policy.ts             evaluator (single fn used by test + enforce)
    capabilities.ts       grant / revoke / check
    audit.ts              hash chain, verify
    path.ts               grammar and validator
    cursor.ts             HMAC-signed opaque cursors
  storage/
    index.ts              Storage interface
    postgres/             the only backend in v1
      schemas.ts          Kysely types
      migrations/         numbered SQL files
      docs.ts log.ts counter.ts blob.ts lock.ts audit.ts ...
    blob-fs.ts            filesystem-backed blob store
  telemetry/
    logger.ts             pino, redaction rules
    metrics.ts            prometheus
    tracing.ts            otel
  config.ts               zod-validated env
  bootstrap.ts            one-shot CLI
  index.ts                process entry
test/
  unit/
  integration/
  property/               fast-check for policy, path, cursors
  fuzz/                   tx.invoke precondition interleavings
ARCHITECTURE.md           (this file)
```

---

## Implementation stack

- **Language:** TypeScript, strict mode, `"moduleResolution": "NodeNext"`.
- **Runtime:** Node.js LTS.
- **HTTP framework:** Hono (lightweight, native streaming, typed). Fastify is an acceptable alternative.
- **MCP:** `@modelcontextprotocol/sdk`.
- **Validation:** Zod. Source of truth for all schemas. `zod-to-json-schema` for wire export.
- **Postgres client:** `pg` + Kysely for query building (no ORM). Types generated from migrations.
- **Auth:** Ory Hydra (docker-compose for local). JWT verification via `jose`.
- **Migrations:** `postgrator` or equivalent plain-SQL runner.
- **Logging:** `pino` with redaction.
- **Metrics:** `prom-client`.
- **Tracing:** OpenTelemetry.
- **Testing:** `vitest` + `fast-check` for property tests.
- **Lint/format:** `biome` or `eslint` + `prettier`.
