import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig } from "../config.js";

// Content-addressed filesystem blob store, two-level sharded.
// Path layout: <BLOB_DIR>/<aa>/<bb>/<full-hash-hex>
//
// Invariants:
//   - Hashes are computed server-side. Never trust any client-supplied hash.
//   - Puts are atomic via write-to-temp + rename.
//   - Reads verify hash prefix only for path layout; content integrity is implicit by address.

export type BlobHash = Buffer;

export function hashBytes(bytes: Buffer): BlobHash {
  return crypto.createHash("sha256").update(bytes).digest();
}

function blobPath(root: string, hash: BlobHash): string {
  const hex = hash.toString("hex");
  const a = hex.slice(0, 2);
  const b = hex.slice(2, 4);
  return path.join(root, a, b, hex);
}

export class BlobStore {
  constructor(private readonly root: string) {}

  static fromConfig(): BlobStore {
    return new BlobStore(loadConfig().BLOB_DIR);
  }

  async put(bytes: Buffer): Promise<{ hash: BlobHash; size: number; alreadyStored: boolean }> {
    const hash = hashBytes(bytes);
    const full = blobPath(this.root, hash);
    const dir = path.dirname(full);
    await fs.mkdir(dir, { recursive: true });

    try {
      await fs.access(full);
      return { hash, size: bytes.byteLength, alreadyStored: true };
    } catch {
      // not present; write it
    }

    const tmp = `${full}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmp, bytes, { flag: "wx" });
    await fs.rename(tmp, full);
    return { hash, size: bytes.byteLength, alreadyStored: false };
  }

  async get(hash: BlobHash): Promise<Buffer> {
    const full = blobPath(this.root, hash);
    return fs.readFile(full);
  }

  async exists(hash: BlobHash): Promise<boolean> {
    try {
      await fs.access(blobPath(this.root, hash));
      return true;
    } catch {
      return false;
    }
  }

  async remove(hash: BlobHash): Promise<void> {
    const full = blobPath(this.root, hash);
    await fs.rm(full, { force: true });
  }
}
