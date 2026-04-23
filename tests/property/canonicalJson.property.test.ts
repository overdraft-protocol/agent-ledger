import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { canonicalJson } from "../../src/core/audit.js";

// canonicalJson is the foundation of the audit hash chain. Two values that are
// structurally equivalent must serialize to byte-identical strings regardless
// of original key ordering.

describe("property: canonicalJson", () => {
  const jsonValue: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
    value: fc.oneof(
      { depthSize: "small" },
      fc.constant(null),
      fc.boolean(),
      fc.integer(),
      fc.string({ maxLength: 16 }),
      fc.array(tie("value"), { maxLength: 4 }),
      fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), tie("value"), { maxKeys: 4 }),
    ),
  })).value;

  it("is order-independent for object keys", () => {
    fc.assert(
      fc.property(jsonValue, (v) => {
        const a = canonicalJson(v);
        const b = canonicalJson(structuredClone(v));
        expect(a).toBe(b);
      }),
    );
  });

  it("explicitly swapping key order yields the same canonical form", () => {
    const v1 = { b: 2, a: 1, c: [3, { y: 2, x: 1 }] };
    const v2 = { c: [3, { x: 1, y: 2 }], a: 1, b: 2 };
    expect(canonicalJson(v1)).toBe(canonicalJson(v2));
  });

  it("differentiates structurally distinct values", () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: "1" }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson(null)).not.toBe(canonicalJson("null"));
  });
});
