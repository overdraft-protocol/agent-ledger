import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createApp } from "./http/app.js";
import { closeDb } from "./storage/postgres/client.js";
import { runMigrations } from "./storage/postgres/migrate.js";
import { logger } from "./telemetry/logger.js";

// Process entry point. Order matters:
//   1. loadConfig (throws on bad env)
//   2. optional: runMigrations if RUN_MIGRATIONS_ON_BOOT=true
//   3. start HTTP server
//   4. install SIGTERM/SIGINT handlers for graceful shutdown

async function main(): Promise<void> {
  const cfg = loadConfig();

  if (process.env["RUN_MIGRATIONS_ON_BOOT"] === "true") {
    logger.info("running migrations on boot");
    await runMigrations();
  }

  if (cfg.ALLOW_DEV_AGENT_HEADER) {
    logger.warn(
      { host: cfg.HOST, port: cfg.PORT },
      "ALLOW_DEV_AGENT_HEADER=true — caller identity is trusted from the X-Dev-Agent-Id header. DO NOT expose this server to untrusted networks.",
    );
  }

  const app = createApp();
  const server = serve(
    { fetch: app.fetch, hostname: cfg.HOST, port: cfg.PORT },
    (info) => {
      logger.info({ address: info.address, port: info.port }, "agent-ledger listening");
    },
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDb().catch((err) => logger.error({ err }, "error closing db"));
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch(async (err) => {
  logger.error({ err }, "fatal error during startup");
  await closeDb().catch(() => undefined);
  process.exit(1);
});
