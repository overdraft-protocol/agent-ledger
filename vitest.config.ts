import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration tests share a Postgres instance — don't run files in parallel.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    // Populate env defaults before `src/config.ts` is imported anywhere.
    setupFiles: ["tests/setup.ts"],
    reporters: ["default"],
  },
});
