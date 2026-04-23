import os from "node:os";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { getDb, closeDb } from "./storage/postgres/client.js";
import {
  approveEnrollment,
  rejectEnrollment,
  listPendingEnrollments,
  getEnrollment,
  sweepExpired,
} from "./control/enrollment.js";
import { logger } from "./telemetry/logger.js";

// Operator CLI for reviewing enrollment requests.
//
//   npm run enroll -- list                                pending only
//   npm run enroll -- list --all                          all statuses
//   npm run enroll -- show <enrollment-id>
//   npm run enroll -- approve <enrollment-id>             prints AGENT_ID=...
//   npm run enroll -- reject  <enrollment-id> [--reason "..."]
//   npm run enroll -- sweep                               mark past-TTL rows expired
//
// `reviewed_by_subject` is recorded as `<unix-user>@<host>` so audit history
// reflects which operator session approved the request. There is no other
// notion of operator identity at this layer (operator is whoever has shell on
// the host).

function operatorTag(): string {
  const user = process.env["USER"] ?? process.env["LOGNAME"] ?? "unknown";
  return `${user}@${os.hostname()}`;
}

function usage(): string {
  return `Usage:
  enroll list [--all]
  enroll show <enrollment-id>
  enroll approve <enrollment-id>
  enroll reject <enrollment-id> [--reason "..."]
  enroll sweep
`;
}

async function main(): Promise<number> {
  const positionals = process.argv.slice(2);
  const cmd = positionals[0];
  if (!cmd) {
    process.stderr.write(usage());
    return 2;
  }

  loadConfig();
  const db = getDb();

  switch (cmd) {
    case "list": {
      const { values } = parseArgs({
        args: positionals.slice(1),
        options: { all: { type: "boolean", default: false } },
        strict: true,
      });
      const rows = await listPendingEnrollments(db, { includeAll: values.all === true });
      if (rows.length === 0) {
        process.stdout.write(values.all ? "(no enrollment requests)\n" : "(no pending requests)\n");
        return 0;
      }
      for (const r of rows) {
        process.stdout.write(
          [
            `id:           ${r.id}`,
            `oauth_subject: ${r.oauth_subject}`,
            `status:        ${r.status}`,
            `requested_at:  ${r.requested_at.toISOString()}`,
            `expires_at:    ${r.expires_at.toISOString()}`,
            r.note ? `note:          ${r.note}` : null,
            r.agent_id ? `agent_id:      ${r.agent_id}` : null,
            r.reviewed_by_subject ? `reviewed_by:   ${r.reviewed_by_subject}` : null,
            r.reviewed_at ? `reviewed_at:   ${r.reviewed_at.toISOString()}` : null,
            r.reject_reason ? `reject_reason: ${r.reject_reason}` : null,
            "",
          ]
            .filter((s) => s !== null)
            .join("\n") + "\n",
        );
      }
      return 0;
    }

    case "show": {
      const id = positionals[1];
      if (!id) {
        process.stderr.write("error: enrollment-id required\n");
        return 2;
      }
      const r = await getEnrollment(db, id);
      if (!r) {
        process.stderr.write(`error: enrollment ${id} not found\n`);
        return 1;
      }
      process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      return 0;
    }

    case "approve": {
      const id = positionals[1];
      if (!id) {
        process.stderr.write("error: enrollment-id required\n");
        return 2;
      }
      const r = await approveEnrollment(db, {
        enrollmentId: id,
        reviewedBySubject: operatorTag(),
      });
      // Stable, parseable output for shell capture, mirrors bootstrap.ts.
      process.stdout.write(`AGENT_ID=${r.agent_id}\n`);
      process.stdout.write(`OAUTH_SUBJECT=${r.oauth_subject}\n`);
      process.stdout.write(`ENROLLMENT_ID=${r.enrollment_id}\n`);
      return 0;
    }

    case "reject": {
      const { values, positionals: rest } = parseArgs({
        args: positionals.slice(1),
        options: { reason: { type: "string" } },
        allowPositionals: true,
        strict: true,
      });
      const id = rest[0];
      if (!id) {
        process.stderr.write("error: enrollment-id required\n");
        return 2;
      }
      const rejectInput: Parameters<typeof rejectEnrollment>[1] = {
        enrollmentId: id,
        reviewedBySubject: operatorTag(),
      };
      if (values.reason !== undefined) rejectInput.reason = values.reason;
      await rejectEnrollment(db, rejectInput);
      process.stdout.write(`rejected ${id}\n`);
      return 0;
    }

    case "sweep": {
      await sweepExpired(db);
      process.stdout.write("sweep complete\n");
      return 0;
    }

    default:
      process.stderr.write(`unknown command: ${cmd}\n` + usage());
      return 2;
  }
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (err) => {
    logger.error({ err }, "enroll-cli failed");
    process.stderr.write(`error: ${(err as Error).message}\n`);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
