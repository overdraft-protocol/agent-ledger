import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { getDb, closeDb } from "./storage/postgres/client.js";
import { createNamespace } from "./control/namespace.js";
import { logger } from "./telemetry/logger.js";

// CLI: create (or reuse) an agent identified by an OAuth subject, then
// optionally create a namespace owned by that agent. Prints AGENT_ID= and
// NAMESPACE_ID= lines to stdout so callers can `eval $(npm run bootstrap ...)`.
//
// Usage:
//   npm run bootstrap -- --oauth-subject alice@example.com
//   npm run bootstrap -- --oauth-subject alice@example.com --alias workspace

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "oauth-subject": { type: "string" },
      alias: { type: "string" },
    },
    strict: true,
  });

  const oauthSubject = values["oauth-subject"];
  if (!oauthSubject) {
    process.stderr.write("error: --oauth-subject is required\n");
    process.exit(2);
  }
  const alias = values.alias ?? null;

  loadConfig();
  const db = getDb();

  // Idempotent on oauth_subject; re-runs return the existing agent id.
  const existing = await db
    .selectFrom("agents")
    .select(["id", "disabled_at"])
    .where("oauth_subject", "=", oauthSubject)
    .executeTakeFirst();

  let agentId: string;
  if (existing) {
    if (existing.disabled_at !== null) {
      process.stderr.write(
        `error: agent with oauth_subject=${oauthSubject} exists but is disabled\n`,
      );
      process.exit(1);
    }
    agentId = existing.id;
  } else {
    const row = await db
      .insertInto("agents")
      .values({ oauth_subject: oauthSubject })
      .returning("id")
      .executeTakeFirstOrThrow();
    agentId = row.id;
  }

  process.stdout.write(`AGENT_ID=${agentId}\n`);

  if (alias !== null) {
    const requestId = crypto.randomUUID();
    const ns = await createNamespace(db, {
      ownerAgentId: agentId,
      alias,
      requestId,
    });
    process.stdout.write(`NAMESPACE_ID=${ns.id}\n`);
  }
}

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error({ err }, "bootstrap failed");
    process.stderr.write(`bootstrap failed: ${(err as Error).message}\n`);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
