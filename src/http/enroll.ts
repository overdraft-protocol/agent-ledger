import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../storage/postgres/client.js";
import {
  submitEnrollment,
  claimEnrollment,
} from "../control/enrollment.js";

// Unauthenticated enrollment endpoints. The only pre-auth surface in the
// system. Kept intentionally tiny: two POSTs, no GETs, no listing.
//
//   POST /enroll        { oauth_subject, note? }
//                         -> { enrollment_id, claim_secret, expires_at, status: "pending" }
//   POST /enroll/claim  { enrollment_id, claim_secret }
//                         -> { status, agent_id?, reject_reason? }
//
// Errors map to LedgerError via the shared error handler in app.ts.

const SubmitBody = z.object({
  oauth_subject: z.string().min(1).max(255),
  note: z.string().max(512).optional(),
});

const ClaimBody = z.object({
  enrollment_id: z.string().uuid(),
  claim_secret: z.string().min(16).max(256),
});

export function createEnrollmentRoutes(): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = SubmitBody.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: -32602,
            message: "invalid enrollment request body",
            data: { code: "invalid_params", issues: parsed.error.issues },
          },
        },
        400,
      );
    }
    const body = parsed.data;
    const result = await submitEnrollment(getDb(), {
      oauthSubject: body.oauth_subject,
      note: body.note ?? null,
    });
    return c.json(
      {
        enrollment_id: result.enrollment_id,
        claim_secret: result.claim_secret,
        expires_at: result.expires_at.toISOString(),
        status: result.status,
      },
      201,
    );
  });

  app.post("/claim", async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = ClaimBody.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: -32602,
            message: "invalid claim request body",
            data: { code: "invalid_params", issues: parsed.error.issues },
          },
        },
        400,
      );
    }
    const body = parsed.data;
    const result = await claimEnrollment(getDb(), {
      enrollmentId: body.enrollment_id,
      claimSecret: body.claim_secret,
    });
    return c.json(result, 200);
  });

  return app;
}
