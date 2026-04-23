import crypto from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "../../src/storage/postgres/schema.js";
import { ensureSchema, shutdown } from "../helpers/db.js";

import { createApp } from "../../src/http/app.js";
import {
  approveEnrollment,
  rejectEnrollment,
  submitEnrollment,
  claimEnrollment,
  sweepExpired,
} from "../../src/control/enrollment.js";

// End-to-end onboarding flow:
//   1. Agent submits via POST /enroll  (or via MCP enrollment.submit on /mcp/enroll)
//   2. Operator approves via control-plane helper (CLI calls the same path)
//   3. Agent claims via POST /enroll/claim and receives the agent_id
//   4. Resulting agent_id is accepted by /mcp auth middleware
//
// Also exercises: rejection, replay-after-claim, secret mismatch, and TTL
// expiry (sweep flips pending -> expired and burns the secret).

type JsonRpcResult = {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

async function rpc(
  app: ReturnType<typeof createApp>,
  url: string,
  method: string,
  params: unknown,
  id: number,
  headers: Record<string, string> = {},
): Promise<JsonRpcResult> {
  const res = await app.fetch(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
  );
  expect(res.status, `rpc ${method} status`).toBe(200);
  return (await res.json()) as JsonRpcResult;
}

async function initialize(
  app: ReturnType<typeof createApp>,
  url: string,
  headers: Record<string, string> = {},
): Promise<void> {
  const init = await rpc(app, url, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0.0.0" },
  }, 0, headers);
  expect(init.error, JSON.stringify(init.error)).toBeUndefined();
}

function toolResult(r: JsonRpcResult): { ok: boolean; result?: unknown; error?: unknown } {
  expect(r.error, JSON.stringify(r.error)).toBeUndefined();
  const result = r.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
  const text = result.content[0]?.text ?? "{}";
  return JSON.parse(text);
}

describe("smoke: enrollment", () => {
  let db: Kysely<Database>;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    db = await ensureSchema();
    app = createApp();
  });

  afterAll(async () => {
    await shutdown();
  });

  it("HTTP: submit -> approve -> claim -> use as MCP agent", async () => {
    const subject = `http-${crypto.randomUUID()}`;

    const submitRes = await app.fetch(
      new Request("http://local/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oauth_subject: subject, note: "smoke test" }),
      }),
    );
    expect(submitRes.status).toBe(201);
    const submit = (await submitRes.json()) as {
      enrollment_id: string;
      claim_secret: string;
      status: string;
    };
    expect(submit.status).toBe("pending");
    expect(submit.enrollment_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(submit.claim_secret.length).toBeGreaterThan(20);

    // Pre-approval claim returns pending (still 200).
    const pendingRes = await app.fetch(
      new Request("http://local/enroll/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enrollment_id: submit.enrollment_id,
          claim_secret: submit.claim_secret,
        }),
      }),
    );
    expect(pendingRes.status).toBe(200);
    expect((await pendingRes.json()) as { status: string }).toEqual({ status: "pending" });

    // Operator approves out-of-band.
    const approval = await approveEnrollment(db, {
      enrollmentId: submit.enrollment_id,
      reviewedBySubject: "operator@test",
    });
    expect(approval.agent_id).toMatch(/^[0-9a-f-]{36}$/);

    // Agent claims and gets back the agent_id.
    const claimRes = await app.fetch(
      new Request("http://local/enroll/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enrollment_id: submit.enrollment_id,
          claim_secret: submit.claim_secret,
        }),
      }),
    );
    expect(claimRes.status).toBe(200);
    const claimed = (await claimRes.json()) as { status: string; agent_id: string };
    expect(claimed.status).toBe("claimed");
    expect(claimed.agent_id).toBe(approval.agent_id);

    // Replay must not return the agent_id again — secret has been burned.
    const replayRes = await app.fetch(
      new Request("http://local/enroll/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enrollment_id: submit.enrollment_id,
          claim_secret: submit.claim_secret,
        }),
      }),
    );
    expect(replayRes.status).toBe(404);

    // The new agent_id is accepted by the authenticated /mcp endpoint.
    await initialize(app, "http://local/mcp", { "x-dev-agent-id": claimed.agent_id });
    const list = await rpc(app, "http://local/mcp", "tools/list", {}, 1, {
      "x-dev-agent-id": claimed.agent_id,
    });
    const tools = (list.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.some((t) => t.name === "namespace.create")).toBe(true);
  });

  it("HTTP: rejected request cannot be claimed", async () => {
    const subject = `rejected-${crypto.randomUUID()}`;
    const submit = await submitEnrollment(db, { oauthSubject: subject });

    await rejectEnrollment(db, {
      enrollmentId: submit.enrollment_id,
      reviewedBySubject: "operator@test",
      reason: "not who they claim to be",
    });

    const res = await app.fetch(
      new Request("http://local/enroll/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enrollment_id: submit.enrollment_id,
          claim_secret: submit.claim_secret,
        }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("HTTP: wrong claim_secret is indistinguishable from unknown enrollment_id", async () => {
    const subject = `wrong-secret-${crypto.randomUUID()}`;
    const submit = await submitEnrollment(db, { oauthSubject: subject });

    const badSecretRes = await app.fetch(
      new Request("http://local/enroll/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enrollment_id: submit.enrollment_id,
          claim_secret: "X".repeat(43),
        }),
      }),
    );
    expect(badSecretRes.status).toBe(404);

    const unknownRes = await app.fetch(
      new Request("http://local/enroll/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enrollment_id: crypto.randomUUID(),
          claim_secret: submit.claim_secret,
        }),
      }),
    );
    expect(unknownRes.status).toBe(404);
  });

  it("MCP: enrollment.submit -> approve -> enrollment.claim via /mcp/enroll", async () => {
    const subject = `mcp-${crypto.randomUUID()}`;
    await initialize(app, "http://local/mcp/enroll");

    const submitCall = await rpc(app, "http://local/mcp/enroll", "tools/call", {
      name: "enrollment.submit",
      arguments: { oauth_subject: subject, note: "via mcp" },
    }, 1);
    const submitOuter = toolResult(submitCall);
    expect(submitOuter.ok).toBe(true);
    const submit = submitOuter.result as { enrollment_id: string; claim_secret: string };

    // /mcp/enroll must NOT expose the authenticated tool catalog.
    const list = await rpc(app, "http://local/mcp/enroll", "tools/list", {}, 2);
    const tools = (list.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["enrollment.claim", "enrollment.submit"]);

    // Approve out-of-band.
    const approval = await approveEnrollment(db, {
      enrollmentId: submit.enrollment_id,
      reviewedBySubject: "operator@test",
    });

    const claimCall = await rpc(app, "http://local/mcp/enroll", "tools/call", {
      name: "enrollment.claim",
      arguments: {
        enrollment_id: submit.enrollment_id,
        claim_secret: submit.claim_secret,
      },
    }, 3);
    const claim = toolResult(claimCall);
    expect(claim.ok).toBe(true);
    expect(claim.result).toEqual({ status: "claimed", agent_id: approval.agent_id });
  });

  it("MCP: /mcp/enroll requires no auth header (sanity)", async () => {
    // No x-dev-agent-id header at all — must still succeed.
    await initialize(app, "http://local/mcp/enroll");
  });

  it("control: TTL expiry burns the secret on sweep", async () => {
    const subject = `ttl-${crypto.randomUUID()}`;
    // 1ms TTL so the row is past-due immediately.
    const submit = await submitEnrollment(db, { oauthSubject: subject, ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 10));

    await sweepExpired(db);

    // Claim now returns 404 (pending row swept to expired, secret nulled).
    await expect(
      claimEnrollment(db, {
        enrollmentId: submit.enrollment_id,
        claimSecret: submit.claim_secret,
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    // The same subject can be re-submitted because the prior row is no longer active.
    const second = await submitEnrollment(db, { oauthSubject: subject });
    expect(second.enrollment_id).not.toBe(submit.enrollment_id);
  });

  it("control: cannot submit twice for the same active oauth_subject", async () => {
    const subject = `dup-${crypto.randomUUID()}`;
    await submitEnrollment(db, { oauthSubject: subject });
    await expect(submitEnrollment(db, { oauthSubject: subject })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("control: cannot enrol an oauth_subject that is already a live agent", async () => {
    const subject = `existing-${crypto.randomUUID()}`;
    await db.insertInto("agents").values({ oauth_subject: subject }).execute();
    await expect(submitEnrollment(db, { oauthSubject: subject })).rejects.toMatchObject({
      code: "conflict",
    });
  });
});
