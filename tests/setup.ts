// Populate defaults for required env vars before any module that calls
// loadConfig() is imported. dotenv-in-config.ts doesn't override pre-set vars,
// so explicit process.env assignments win. Values here are safe defaults for a
// local docker-compose Postgres; OAuth-related vars are never touched by tests
// (auth is bypassed by seedAgent).

process.env["NODE_ENV"] ??= "test";
process.env["DATABASE_URL"] ??=
  "postgres://agent_ledger:agent_ledger@127.0.0.1:5432/agent_ledger";
process.env["OAUTH_ISSUER"] ??= "http://127.0.0.1:4444";
process.env["OAUTH_JWKS_URL"] ??= "http://127.0.0.1:4444/.well-known/jwks.json";
process.env["OAUTH_AUDIENCE"] ??= "agent-ledger";
process.env["CURSOR_HMAC_KEY"] ??=
  "0000000000000000000000000000000000000000000000000000000000000000";
process.env["BLOB_DIR"] ??= "./.blobs-test";
process.env["LOG_LEVEL"] ??= "warn";
process.env["ALLOW_DEV_AGENT_HEADER"] ??= "true";
