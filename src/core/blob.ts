import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../storage/postgres/schema.js";
import { BlobStore, hashBytes } from "../storage/blob-fs.js";
import { LedgerError } from "./errors.js";
import { loadConfig } from "../config.js";

// `blob` — content-addressed binary storage. Server-side hashing only (I21).
// Refs are typed and transactional (I22); this module handles the storage side
// and metadata. `blob_refs` accounting lives in `doc.ts` adjustBlobRefs because
// it's derived from schema walks — keep it in one place to avoid drift.

export const BLOB_MAX_BYTES_CAP = 4 * 1024 * 1024;
const CONTENT_TYPE_MAX = 128;

export interface BlobPutResult {
  sha256: string; // hex
  size: number;
  alreadyStored: boolean;
}

export async function blobPut(
  db: Kysely<Database>,
  bytes: Buffer,
  contentType: string | null,
): Promise<BlobPutResult> {
  const cfg = loadConfig();
  if (bytes.byteLength > cfg.BLOB_MAX_BYTES) {
    throw new LedgerError("too_large", `blob exceeds ${cfg.BLOB_MAX_BYTES} bytes`);
  }
  if (bytes.byteLength > BLOB_MAX_BYTES_CAP) {
    throw new LedgerError("too_large", `blob exceeds hard cap of ${BLOB_MAX_BYTES_CAP} bytes`);
  }
  if (contentType !== null) {
    if (typeof contentType !== "string" || contentType.length > CONTENT_TYPE_MAX) {
      throw new LedgerError("invalid_params", "content_type too long");
    }
    if (!/^[\x20-\x7E]*$/.test(contentType)) {
      throw new LedgerError("invalid_params", "content_type must be printable ASCII");
    }
  }

  // Server computes hash; client input ignored.
  const hash = hashBytes(bytes);
  const hex = hash.toString("hex");

  const store = BlobStore.fromConfig();
  const { alreadyStored } = await store.put(bytes);

  // Upsert metadata. Size/content_type are first-writer-wins (content-addressed,
  // so content is identical; content_type is metadata-only).
  await sql`
    INSERT INTO blobs (sha256, size_bytes, content_type)
    VALUES (${hash}, ${bytes.byteLength}, ${contentType})
    ON CONFLICT (sha256) DO NOTHING
  `.execute(db);

  return { sha256: hex, size: bytes.byteLength, alreadyStored };
}

export async function blobGet(
  db: Kysely<Database>,
  sha256Hex: string,
): Promise<{ bytes: Buffer; contentType: string | null; size: number }> {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) {
    throw new LedgerError("invalid_params", "sha256 must be 64 hex chars");
  }
  const sha = Buffer.from(sha256Hex, "hex");
  const row = await db
    .selectFrom("blobs")
    .select(["size_bytes", "content_type"])
    .where("sha256", "=", sha)
    .executeTakeFirst();
  if (!row) {
    throw new LedgerError("not_found", "blob not found");
  }
  const bytes = await BlobStore.fromConfig().get(sha);
  return { bytes, contentType: row.content_type, size: Number(row.size_bytes) };
}

export async function blobExists(db: Kysely<Database>, sha256Hex: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) return false;
  const sha = Buffer.from(sha256Hex, "hex");
  const row = await db
    .selectFrom("blobs")
    .select("sha256")
    .where("sha256", "=", sha)
    .executeTakeFirst();
  return Boolean(row);
}
