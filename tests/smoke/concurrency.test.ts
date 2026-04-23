import crypto from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "../../src/storage/postgres/schema.js";
import { ensureSchema, seedNamespace, shutdown } from "../helpers/db.js";
import { registerTransition } from "../../src/core/transition/registry.js";
import { invoke } from "../../src/core/transition/invoke.js";
import { counterGet } from "../../src/core/counter.js";

describe("smoke: concurrency", () => {
  let db: Kysely<Database>;

  beforeAll(async () => {
    db = await ensureSchema();
  });

  afterAll(async () => {
    await shutdown();
  });

  it("concurrent increments converge to the expected total under SERIALIZABLE", async () => {
    const ns = await seedNamespace(db);

    await registerTransition(db, {
      namespaceId: ns.id,
      registeredBy: ns.owner.id,
      name: "init_counter",
      version: 1,
      params_schema: { t: "object", extras: "strict", props: {} },
      asserts: [],
      ops: [
        {
          o: "counter.create",
          path: { k: "lit", v: "counters/total" },
          initial: { k: "lit", v: 0 },
          min: { k: "lit", v: 0 },
          max: { k: "lit", v: 10_000 },
        },
      ],
    });

    await registerTransition(db, {
      namespaceId: ns.id,
      registeredBy: ns.owner.id,
      name: "inc_by_one",
      version: 1,
      params_schema: { t: "object", extras: "strict", props: {} },
      asserts: [],
      ops: [
        {
          o: "counter.incr",
          path: { k: "lit", v: "counters/total" },
          delta: { k: "lit", v: 1 },
        },
      ],
    });

    await invoke(db, {
      namespaceId: ns.id,
      agentId: ns.owner.id,
      requestId: crypto.randomUUID(),
      transitionName: "init_counter",
      params: {},
      idempotencyKey: "idem-init-counter",
    });

    const N = 20;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        invoke(db, {
          namespaceId: ns.id,
          agentId: ns.owner.id,
          requestId: crypto.randomUUID(),
          transitionName: "inc_by_one",
          params: {},
          // Unique idempotency keys — we want every call to actually commit.
          idempotencyKey: `idem-inc-${i}`,
        }),
      ),
    );

    // Every call must succeed thanks to the retry-on-40001 loop. If any fails
    // we want the concrete reason in the report.
    const rejections = results.filter((r) => r.status === "rejected");
    expect(rejections, JSON.stringify(rejections)).toHaveLength(0);

    const c = await counterGet(db, ns.id, "counters/total");
    expect(c?.n).toBe(String(N));
  });
});
