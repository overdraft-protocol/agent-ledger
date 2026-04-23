import "dotenv/config";
import { z } from "zod";

// Invariant: server refuses to start on invalid config. No silent defaults for security-sensitive values.

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().max(65535).default(3210),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  DATABASE_URL: z.string().url(),
  PG_POOL_MAX: z.coerce.number().int().positive().max(500).default(10),

  OAUTH_ISSUER: z.string().url(),
  OAUTH_JWKS_URL: z.string().url(),
  OAUTH_AUDIENCE: z.string().min(1),
  OAUTH_REVOCATION_ENDPOINT: z.string().url().optional(),
  OAUTH_BLOCKLIST_POLL_MS: z.coerce.number().int().min(1000).max(60000).default(10000),

  CURSOR_HMAC_KEY: z
    .string()
    .min(32, "CURSOR_HMAC_KEY must be at least 32 bytes of entropy (use a 64-char hex string)"),

  BLOB_DIR: z.string().default("./.blobs"),
  BLOB_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(16 * 1024 * 1024)
    .default(4 * 1024 * 1024),

  MAX_REQUEST_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 1024 * 1024),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(1),
  RATE_LIMIT_DEFAULT_COST_PER_SECOND: z.coerce.number().int().positive().default(200),

  // Dev-only auth shim. When "true" (and NODE_ENV != production) a request
  // header `X-Dev-Agent-Id: <agent-uuid>` replaces JWT auth. Hard-fails at
  // startup if combined with NODE_ENV=production.
  ALLOW_DEV_AGENT_HEADER: z
    .union([z.literal("true"), z.literal("false")])
    .default("false")
    .transform((s) => s === "true"),
});

export type Config = z.infer<typeof EnvSchema>;

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.ALLOW_DEV_AGENT_HEADER && cfg.NODE_ENV === "production") {
    throw new Error("ALLOW_DEV_AGENT_HEADER=true is forbidden in NODE_ENV=production");
  }
  cached = cfg;
  return cached;
}
