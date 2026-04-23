import crypto from "node:crypto";
import { loadConfig } from "../config.js";
import { LedgerError } from "./errors.js";

// HMAC-signed opaque cursors (ARCHITECTURE.md I26).
// Clients cannot forge, skip ranges, or probe arbitrary offsets.
//
// Wire format:  base64url( mac16 || json-state )
//   mac16 = HMAC-SHA256(key, version || json-state) truncated to 16 bytes

const VERSION = Buffer.from([0x01]);
const MAC_LEN = 16;

function key(): Buffer {
  return Buffer.from(loadConfig().CURSOR_HMAC_KEY, "utf8");
}

export function signCursor<T>(state: T): string {
  const json = Buffer.from(JSON.stringify(state), "utf8");
  const mac = crypto
    .createHmac("sha256", key())
    .update(VERSION)
    .update(json)
    .digest()
    .subarray(0, MAC_LEN);
  return Buffer.concat([mac, json]).toString("base64url");
}

export function verifyCursor<T>(cursor: string): T {
  let raw: Buffer;
  try {
    raw = Buffer.from(cursor, "base64url");
  } catch {
    throw new LedgerError("cursor_invalid", "cursor is not valid base64url");
  }
  if (raw.length <= MAC_LEN) {
    throw new LedgerError("cursor_invalid", "cursor too short");
  }
  const mac = raw.subarray(0, MAC_LEN);
  const json = raw.subarray(MAC_LEN);
  const expected = crypto
    .createHmac("sha256", key())
    .update(VERSION)
    .update(json)
    .digest()
    .subarray(0, MAC_LEN);
  if (!crypto.timingSafeEqual(mac, expected)) {
    throw new LedgerError("cursor_invalid", "cursor signature mismatch");
  }
  try {
    return JSON.parse(json.toString("utf8")) as T;
  } catch {
    throw new LedgerError("cursor_invalid", "cursor payload malformed");
  }
}
