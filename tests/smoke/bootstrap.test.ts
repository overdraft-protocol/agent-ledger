import crypto from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "../../src/storage/postgres/schema.js";
import { ensureSchema, seedNamespace, seedSchema, shutdown } from "../helpers/db.js";
import { registerTransition } from "../../src/core/transition/registry.js";
import { invoke } from "../../src/core/transition/invoke.js";
import { counterGet } from "../../src/core/counter.js";
import { docGet } from "../../src/core/doc.js";
import { readAudit, verifyAudit } from "../../src/core/audit.js";

// End-to-end sanity pass: register -> invoke -> observe.
// Exercises doc.put + counter.create + counter.incr in a single transition and
// verifies idempotency replay + audit chain integrity.

describe("smoke: bootstrap", () => {
  let db: Kysely<Database>;

  beforeAll(async () => {
    db = await ensureSchema();
  });

  afterAll(async () => {
    await shutdown();
  });

  it("creates a counter and a doc through a single transition", async () => {
    const ns = await seedNamespace(db);

    await seedSchema(db, {
      namespaceId: ns.id,
      registeredBy: ns.owner.id,
      name: "user",
      version: 1,
      dsl: {
        t: "object",
        extras: "strict",
        props: {
          name: { s: { t: "string", min: 1, max: 64 } },
          email: { s: { t: "string", format: "email" } },
        },
      },
    });

    await registerTransition(db, {
      namespaceId: ns.id,
      registeredBy: ns.owner.id,
      name: "create_user",
      version: 1,
      params_schema: {
        t: "object",
        extras: "strict",
        props: {
          path: { s: { t: "string", min: 1, max: 128 } },
          user: {
            s: {
              t: "object",
              extras: "strict",
              props: {
                name: { s: { t: "string", min: 1, max: 64 } },
                email: { s: { t: "string", format: "email" } },
              },
            },
          },
        },
      },
      asserts: [],
      ops: [
        {
          o: "doc.put",
          path: { k: "param", name: "path" },
          schema_name: "user",
          schema_version: 1,
          value: { k: "param", name: "user" },
        },
        {
          o: "counter.create",
          path: { k: "lit", v: "users/count" },
          initial: { k: "lit", v: 0 },
          min: { k: "lit", v: 0 },
          max: { k: "lit", v: 1_000_000 },
        },
        {
          o: "counter.incr",
          path: { k: "lit", v: "users/count" },
          delta: { k: "lit", v: 1 },
        },
      ],
    });

    const result = await invoke(db, {
      namespaceId: ns.id,
      agentId: ns.owner.id,
      requestId: crypto.randomUUID(),
      transitionName: "create_user",
      params: {
        path: "users/alice",
        user: { name: "Alice", email: "alice@example.com" },
      },
      idempotencyKey: "idem-bootstrap-1",
    });

    expect(result.idempotent).toBe(false);
    expect(result.ops).toHaveLength(3);
    expect(result.ops[0]).toMatchObject({ op: "doc.put", result: { path: "users/alice", version: "1" } });
    expect(result.ops[2]).toMatchObject({ op: "counter.incr", result: { path: "users/count", n: "1" } });

    // Observable side-effects.
    const doc = await docGet(db, ns.id, "users/alice");
    expect(doc).not.toBeNull();
    expect(doc!.value).toEqual({ name: "Alice", email: "alice@example.com" });
    expect(doc!.version).toBe("1");

    const counter = await counterGet(db, ns.id, "users/count");
    expect(counter?.n).toBe("1");

    // Replay with the same idempotency key should short-circuit.
    const replay = await invoke(db, {
      namespaceId: ns.id,
      agentId: ns.owner.id,
      requestId: crypto.randomUUID(),
      transitionName: "create_user",
      params: {
        path: "users/alice",
        user: { name: "Alice", email: "alice@example.com" },
      },
      idempotencyKey: "idem-bootstrap-1",
    });
    expect(replay.idempotent).toBe(true);
    expect(replay.txId).toBe(result.txId);

    // Counter should NOT have incremented on replay.
    const counter2 = await counterGet(db, ns.id, "users/count");
    expect(counter2?.n).toBe("1");

    // Audit chain walks cleanly from genesis.
    const entries = await readAudit(db, ns.id, 0n, 100);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const verified = await verifyAudit(db, ns.id, 0n, BigInt(entries.length));
    expect(verified.firstDivergentSeq).toBeNull();
  });
});
