import pino from "pino";
import { loadConfig } from "../config.js";

// Invariant: logs never contain bearer tokens, JWTs, or arbitrary payload bodies.
// Allowlist: redact everything sensitive by default; callers pass explicit, bounded fields.

const config = loadConfig();

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: "agent-ledger", env: config.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
      "token",
      "access_token",
      "refresh_token",
      "jwt",
      "password",
      "secret",
      "*.authorization",
      "*.access_token",
      "*.refresh_token",
      "*.password",
      "*.secret",
    ],
    censor: "[redacted]",
  },
});

export type Logger = typeof logger;
