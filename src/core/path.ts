import { LedgerError } from "./errors.js";

// Path grammar (ARCHITECTURE.md I24):
//   - NFC-normalized UTF-8
//   - Allowed chars: [a-zA-Z0-9._\-/]
//   - Segments separated by `/`
//   - No leading/trailing `/`, no `..`, no empty segments, no control chars
//   - Max 512 bytes total, max 32 segments
//   - Case-sensitive

const ALLOWED = /^[a-zA-Z0-9._\-/]+$/;
const MAX_BYTES = 512;
const MAX_SEGMENTS = 32;

export function validatePath(p: string): string {
  if (typeof p !== "string" || p.length === 0) {
    throw new LedgerError("path_invalid", "path must be a non-empty string");
  }

  const normalized = p.normalize("NFC");
  if (normalized !== p) {
    throw new LedgerError("path_invalid", "path must be NFC-normalized UTF-8");
  }

  if (Buffer.byteLength(p, "utf8") > MAX_BYTES) {
    throw new LedgerError("path_invalid", `path exceeds ${MAX_BYTES} bytes`);
  }

  if (p.startsWith("/") || p.endsWith("/")) {
    throw new LedgerError("path_invalid", "path must not start or end with '/'");
  }

  if (!ALLOWED.test(p)) {
    throw new LedgerError("path_invalid", "path contains disallowed characters");
  }

  const segments = p.split("/");
  if (segments.length > MAX_SEGMENTS) {
    throw new LedgerError("path_invalid", `path exceeds ${MAX_SEGMENTS} segments`);
  }

  for (const seg of segments) {
    if (seg.length === 0) {
      throw new LedgerError("path_invalid", "path must not contain empty segments");
    }
    if (seg === "..") {
      throw new LedgerError("path_invalid", "path must not contain '..'");
    }
  }

  return p;
}

// Glob language (ARCHITECTURE.md I13): prefix + single-segment `*` + suffix `**`.
// No regex, no alternation. Linear-time matcher.
//
// Examples:
//   "balances/**"      matches balances/alice, balances/alice/deep
//   "balances/*"       matches balances/alice, not balances/alice/deep
//   "orders/*/items"   matches orders/42/items, not orders/42
//   "exact/path"       exact match only

const GLOB_ALLOWED = /^[a-zA-Z0-9._\-/*]+$/;

export function validateGlob(g: string): string {
  if (typeof g !== "string" || g.length === 0) {
    throw new LedgerError("path_invalid", "glob must be a non-empty string");
  }
  if (g.length > MAX_BYTES) {
    throw new LedgerError("path_invalid", `glob exceeds ${MAX_BYTES} bytes`);
  }
  if (!GLOB_ALLOWED.test(g)) {
    throw new LedgerError("path_invalid", "glob contains disallowed characters");
  }
  // `**` is only permitted as a trailing segment.
  const segs = g.split("/");
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (s === "**") {
      if (i !== segs.length - 1) {
        throw new LedgerError("path_invalid", "'**' only allowed as last segment");
      }
    } else if (s.includes("**")) {
      throw new LedgerError("path_invalid", "'**' may not be mixed with other characters in a segment");
    } else if (s.includes("*") && s !== "*") {
      throw new LedgerError("path_invalid", "'*' must occupy its whole segment");
    }
  }
  return g;
}

export function globMatches(glob: string, path: string): boolean {
  // Validate path (throws on malformed input); globs are validated on registration.
  const pathSegs = path.split("/");
  const globSegs = glob.split("/");

  for (let i = 0; i < globSegs.length; i++) {
    const g = globSegs[i]!;
    if (g === "**") {
      // Consumes remaining path (zero or more segments).
      return i <= pathSegs.length;
    }
    if (i >= pathSegs.length) return false;
    if (g === "*") continue;
    if (g !== pathSegs[i]) return false;
  }
  return globSegs.length === pathSegs.length;
}

export const NAMESPACE_WIDE_GLOBS = new Set(["**", "*/**", "/**"]);

export function isNamespaceWideGlob(g: string): boolean {
  return NAMESPACE_WIDE_GLOBS.has(g);
}
