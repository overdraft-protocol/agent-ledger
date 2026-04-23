# agent-ledger

A small, opinionated MCP server that gives coding/orchestration agents a durable, typed, capability-gated state store. Every mutation is atomic, idempotent, and recorded in a hash-chained audit log. The client surface is the standard Model Context Protocol over Streamable HTTP; the storage surface is Postgres.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design rationale and invariants this server defends.

---

## Quickstart

**Prerequisites:** Node.js 22+, Docker (for the local Postgres), and `npm`.

```bash
# 1. Start Postgres (local dev)
docker compose up -d postgres

# 2. Install deps and configure env
npm install
cp .env.example .env
# Edit .env: for LAN/dev-auth, set ALLOW_DEV_AGENT_HEADER=true and HOST=0.0.0.0

# 3. Build, migrate, bootstrap, start
npm run build
npm run migrate
npm run bootstrap -- --oauth-subject alice@example.com --alias workspace
# prints:
#   AGENT_ID=<uuid>
#   NAMESPACE_ID=<uuid>

npm start
```

The server will log its bind address. If `ALLOW_DEV_AGENT_HEADER=true` it will also emit a loud warning.

---

## Deploying on a LAN

The intended deployment target for the first milestone is a single-machine LAN install that a local MCP client can reach over HTTP.

1. In `.env` on the server:
   ```
   HOST=0.0.0.0
   PORT=3210
   ALLOW_DEV_AGENT_HEADER=true
   NODE_ENV=development
   ```
2. Make sure your OS firewall permits inbound TCP to `PORT` from your LAN only.
3. Bootstrap an agent (as above) and keep the printed `AGENT_ID` — that UUID is the caller identity in dev-auth mode.
4. `npm start`.

> **Security note.** `ALLOW_DEV_AGENT_HEADER=true` trusts the `X-Dev-Agent-Id` header as the caller identity with no cryptographic validation. It is refused at boot if `NODE_ENV=production`. Only expose the port to networks you control. A full OAuth/JWT path is planned (see `src/auth/middleware.ts` TODO) but not yet wired.

---

## Onboarding external agents

`bootstrap` (above) creates an agent for someone with shell access to the host. For agents that arrive over the network, use the operator-gated enrollment flow.

The flow has three actors:

1. **Agent** submits an enrollment request and receives an `enrollment_id` + a single-use `claim_secret`.
2. **Operator** (you) reviews pending requests on the host and approves or rejects each one. Approval creates the underlying `agents` row.
3. **Agent** exchanges the `enrollment_id` + `claim_secret` for the issued `agent_id`, then uses that as `X-Dev-Agent-Id` against `/mcp`.

The two surfaces — `/enroll` (HTTP) and `/mcp/enroll` (MCP) — are equivalent; both are unauthenticated and call the same backend. Pick whichever fits the agent's tooling.

### Agent: submit (HTTP)

```bash
curl -s http://<host>:3210/enroll \
  -H "content-type: application/json" \
  -d '{"oauth_subject": "alice-laptop", "note": "rotating my key"}'
# {
#   "enrollment_id": "...",
#   "claim_secret": "...",     # save this — only shown here, never again
#   "expires_at":   "...",
#   "status":       "pending"
# }
```

### Agent: submit (MCP)

Point an MCP client at `http://<host>:3210/mcp/enroll` (no auth header). It exposes exactly two tools: `enrollment.submit` and `enrollment.claim`. No other ledger functionality is reachable from this endpoint.

### Operator: review and approve

On the host, with shell access:

```bash
npm run enroll -- list                       # show pending requests
npm run enroll -- show <enrollment-id>       # full detail of one request
npm run enroll -- approve <enrollment-id>    # prints AGENT_ID=...
npm run enroll -- reject  <enrollment-id> --reason "no thanks"
npm run enroll -- sweep                      # mark past-TTL rows expired
```

Approval is recorded with `reviewed_by_subject = <unix-user>@<host>` for audit. There is no other notion of operator identity — operator authority is "has shell on the box".

### Agent: claim

Polled by the agent until `status` is no longer `pending`:

```bash
curl -s http://<host>:3210/enroll/claim \
  -H "content-type: application/json" \
  -d '{"enrollment_id":"...","claim_secret":"..."}'
# pending  -> {"status":"pending"}
# approved -> {"status":"claimed","agent_id":"..."}    (one-shot; secret burned)
# rejected/expired/wrong secret -> HTTP 404
```

A successful claim returns the `agent_id` exactly once and burns the secret. Subsequent calls with the same enrollment_id return 404.

### Security properties

- `claim_secret` is 256 bits of `crypto.randomBytes` returned to the submitter only. Only `sha256(secret)` is stored — a DB dump does not let an attacker claim approved requests.
- Wrong secret, unknown `enrollment_id`, rejected, expired, or already-claimed all return the same `404 not_found` response, so the endpoint does not reveal which specific failure occurred.
- Pending requests TTL out after 24 hours (sweep-on-write). Approved-but-unclaimed requests have their secret burned at TTL but the linkage to `agent_id` is preserved for audit.
- One active (`pending` or `approved`) request per `oauth_subject`; subjects already mapped to a live agent cannot enroll again.
- No rate limiting on `/enroll` or `/enroll/claim` yet — see Roadmap.

---

## Verifying the server

Health check (no auth):

```bash
curl -s http://127.0.0.1:3210/healthz
# {"ok":true}
```

List tools (dev auth):

```bash
AGENT_ID=<uuid-from-bootstrap>

# 1. Initialize (required handshake)
curl -s http://127.0.0.1:3210/mcp \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "mcp-protocol-version: 2025-06-18" \
  -H "x-dev-agent-id: $AGENT_ID" \
  -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# 2. tools/list
curl -s http://127.0.0.1:3210/mcp \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "x-dev-agent-id: $AGENT_ID" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

---

## MCP client configuration

Point any MCP client that supports Streamable HTTP transport at `http://<host>:3210/mcp` and include the dev header. Example for the Cursor MCP config shape:

```json
{
  "mcpServers": {
    "agent-ledger": {
      "url": "http://127.0.0.1:3210/mcp",
      "headers": {
        "X-Dev-Agent-Id": "<your-agent-uuid>"
      }
    }
  }
}
```

---

## Tool surface

Every tool requires the `X-Dev-Agent-Id` header (dev mode). Authorization tiers are enforced per-call inside each handler; no capability cache is built into the session.

| Tool                       | Tier required                     |
|----------------------------|-----------------------------------|
| `namespace.create`         | any authenticated agent           |
| `namespace.list`           | authenticated; returns only the namespaces the caller owns or administers |
| `namespace.tombstone`      | owner                             |
| `schema.register`          | admin                             |
| `schema.list`              | admin                             |
| `schema.get`               | admin                             |
| `schema.deprecate`         | admin                             |
| `transition.register`      | admin                             |
| `transition.list`          | admin                             |
| `transition.get`           | admin                             |
| `transition.deprecate`     | admin                             |
| `policy.upsert`            | admin                             |
| `policy.list`              | admin                             |
| `policy.delete`            | admin                             |
| `admin.grant`              | owner                             |
| `admin.revoke`             | owner                             |
| `admin.list`               | admin                             |
| `capability.grant`         | admin (or owner)                  |
| `capability.revoke`        | admin (or owner)                  |
| `capability.list`          | admin                             |
| `audit.read`               | admin                             |
| `audit.head`               | admin                             |
| `audit.verify`             | admin                             |
| `tx.invoke`                | invoke capability on the named transition |
| `doc.get`                  | read capability matching the path |
| `log.read` / `log.head`    | read capability matching the log id |
| `counter.get`              | read capability matching the path |
| `lock.inspect`             | read capability matching the path |
| `blob.put` / `blob.get` / `blob.exists` | admin                |

Tier definitions live in `src/core/capabilities.ts`. Capabilities are resolved per request (no session caching), so revocations take effect on the very next call.

---

## Development

```bash
docker compose up -d postgres
npm install
cp .env.example .env
npm test                                # unit + integration (hits local Postgres)
npx tsc -p tsconfig.test.json --noEmit  # typecheck
npm run build
```

Tests inject safe env defaults via `tests/setup.ts` (including `ALLOW_DEV_AGENT_HEADER=true`). The HTTP smoke test drives the Hono app through `app.fetch()` with no network.

---

## Source layout

```
src/
  auth/        # dev-auth middleware (JWT path TODO)
  config.ts    # env schema; single source of truth
  control/     # namespace/schema/transition/policy/admin/capability CRUD + audit
  core/        # primitives (doc, log, counter, lock, blob, audit, capability checks)
    transition/  # grammar, registry, substitute, asserts, ops, invoke
  http/        # Hono app (/healthz, /mcp)
  mcp/         # MCP server assembly, tool registrations, ALS context carrier
  storage/     # Postgres pool, Kysely schema, numbered SQL migrations
  telemetry/   # pino logger
  bootstrap.ts # CLI: create agent (+ optional namespace) on the host
  enroll-cli.ts # CLI: list / approve / reject / sweep enrollment requests
  index.ts     # server entry
```

---

## Roadmap

- [ ] RFC 9068 JWT auth path (JWKS, blocklist, `sub` → agent-id resolver)
- [ ] Rate limiting middleware (including per-IP cap on `/enroll` and `/enroll/claim`)
- [ ] `log.tail` (LISTEN/NOTIFY server → client streaming)
- [ ] Prometheus `/metrics` endpoint
- [ ] `POLICY.register` API (the evaluator is implemented; the policy-rule registration surface is not yet exposed)
