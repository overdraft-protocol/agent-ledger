import type { Kysely } from "kysely";
import type { Database } from "../storage/postgres/schema.js";

// Request-scoped context carried through every handler and primitive call.
// Built by the auth middleware once per request and immutable thereafter.

export interface CallContext {
  readonly requestId: string; // uuid
  readonly agentId: string;
  readonly tokenJti: string | null;
  readonly db: Kysely<Database>;
}

// Narrower context used inside transitions — same fields plus the
// active transaction handle. The transition engine constructs this
// before running asserts/ops.
export interface TxContext extends CallContext {
  readonly tx: Kysely<Database>;
  readonly namespaceId: string;
  readonly transitionName: string;
  readonly transitionVersion: number;
}
