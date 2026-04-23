import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../storage/postgres/client.js";
import {
  submitEnrollment,
  claimEnrollment,
} from "../control/enrollment.js";
import { wrap } from "./result.js";

// Minimal, unauthenticated MCP server intended to be mounted on a separate
// path (`/mcp/enroll`). Registers ONLY the two enrollment tools; nothing
// else from the main tool catalog is reachable through this server.
//
// Threat model: the only thing exposed pre-auth is what's in this file.
// Keep it small and review carefully on every change.

export function buildEnrollmentMcpServer(): McpServer {
  const server = new McpServer(
    { name: "agent-ledger-enroll", version: "0.2.0-dev" },
    {
      capabilities: { tools: {} },
      instructions:
        "Enrollment surface for agents that do not yet have an agent_id. Two tools: enrollment.submit (request an agent) and enrollment.claim (exchange an enrollment_id + claim_secret for the issued agent_id once an operator has approved the request). All other ledger functionality lives behind authentication at /mcp.",
    },
  );

  server.registerTool(
    "enrollment.submit",
    {
      description:
        "Request a new agent identity. Returns an enrollment_id and a single-use claim_secret. An operator must approve the request out-of-band before claim succeeds.",
      inputSchema: {
        oauth_subject: z
          .string()
          .min(1)
          .max(255)
          .describe("Stable identifier for this agent. Will become agents.oauth_subject on approval."),
        note: z
          .string()
          .max(512)
          .optional()
          .describe("Optional free-text justification shown to the operator during review."),
      },
    },
    wrap("enrollment.submit", async (args) => {
      const r = await submitEnrollment(getDb(), {
        oauthSubject: args.oauth_subject,
        note: args.note ?? null,
      });
      return {
        enrollment_id: r.enrollment_id,
        claim_secret: r.claim_secret,
        expires_at: r.expires_at.toISOString(),
        status: r.status,
      };
    }),
  );

  server.registerTool(
    "enrollment.claim",
    {
      description:
        "Exchange an enrollment_id + claim_secret for the issued agent_id. Returns status='pending' if the operator has not reviewed the request yet; the caller should retry. On success the secret is burned and cannot be reused.",
      inputSchema: {
        enrollment_id: z.string().uuid(),
        claim_secret: z.string().min(16).max(256),
      },
    },
    wrap("enrollment.claim", async (args) => {
      return await claimEnrollment(getDb(), {
        enrollmentId: args.enrollment_id,
        claimSecret: args.claim_secret,
      });
    }),
  );

  return server;
}
