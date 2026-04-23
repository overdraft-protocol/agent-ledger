import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { globMatches, validateGlob, validatePath } from "../../src/core/path.js";

// Property tests for the path/glob language. No DB needed — pure functions.

describe("property: globMatches", () => {
  // Generators that stay inside the accepted alphabet. `..` is rejected by
  // validatePath, so filter it out of segments.
  const segment = fc
    .stringMatching(/^[a-zA-Z0-9._\-]{1,16}$/)
    .filter((s) => s !== "..");
  const path = fc.array(segment, { minLength: 1, maxLength: 8 }).map((s) => s.join("/"));

  it("exact path glob matches exactly that path (and nothing else)", () => {
    fc.assert(
      fc.property(path, path, (p1, p2) => {
        expect(globMatches(p1, p1)).toBe(true);
        if (p1 !== p2) {
          // Different paths under an exact glob never match.
          if (globMatches(p1, p2)) return p1 === p2;
        }
        return true;
      }),
    );
  });

  it("`**` matches every valid path", () => {
    fc.assert(
      fc.property(path, (p) => {
        expect(globMatches("**", p)).toBe(true);
      }),
    );
  });

  it("`prefix/**` matches iff path starts with `prefix/` or equals `prefix`", () => {
    fc.assert(
      fc.property(segment, path, (prefix, rest) => {
        const full = `${prefix}/${rest}`;
        expect(globMatches(`${prefix}/**`, full)).toBe(true);
        // A totally unrelated prefix shouldn't match.
        const other = `not-${prefix}/${rest}`;
        expect(globMatches(`${prefix}/**`, other)).toBe(false);
      }),
    );
  });

  it("single-segment `*` matches any one segment and only one", () => {
    fc.assert(
      fc.property(segment, segment, segment, (a, b, c) => {
        expect(globMatches("orders/*/items", `orders/${b}/items`)).toBe(true);
        expect(globMatches("orders/*/items", `orders/${a}/${b}/items`)).toBe(false);
        expect(globMatches("orders/*/items", `orders/${c}`)).toBe(false);
      }),
    );
  });

  it("validateGlob accepts well-formed, rejects mixed `**`", () => {
    expect(() => validateGlob("balances/**")).not.toThrow();
    expect(() => validateGlob("balances/*")).not.toThrow();
    expect(() => validateGlob("exact/path")).not.toThrow();
    expect(() => validateGlob("bad/**/more")).toThrow();
    expect(() => validateGlob("bad/a**")).toThrow();
    expect(() => validateGlob("bad/**a")).toThrow();
  });

  it("validatePath accepts generated paths and rejects malformed ones", () => {
    fc.assert(fc.property(path, (p) => {
      expect(() => validatePath(p)).not.toThrow();
    }));
    expect(() => validatePath("/leading")).toThrow();
    expect(() => validatePath("trailing/")).toThrow();
    expect(() => validatePath("double//slash")).toThrow();
    expect(() => validatePath("../escape")).toThrow();
    expect(() => validatePath("bad char")).toThrow();
  });
});
