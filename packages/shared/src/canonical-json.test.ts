import { describe, expect, it } from "vitest";
import { canonicalJsonStringify } from "./canonical-json.js";

describe("canonicalJsonStringify", () => {
  it("sorts object keys recursively while preserving array order", () => {
    const left = {
      z: [{ beta: 2, alpha: 1 }, "last"],
      a: { nested_z: true, nested_a: null },
    };
    const right = {
      a: { nested_a: null, nested_z: true },
      z: [{ alpha: 1, beta: 2 }, "last"],
    };

    expect(canonicalJsonStringify(left)).toBe(canonicalJsonStringify(right));
    expect(canonicalJsonStringify(left)).toBe(
      '{"a":{"nested_a":null,"nested_z":true},"z":[{"alpha":1,"beta":2},"last"]}',
    );
    expect(canonicalJsonStringify([1, 2])).not.toBe(canonicalJsonStringify([2, 1]));
  });

  it("uses JSON number and string encoding deterministically", () => {
    expect(canonicalJsonStringify({ negative_zero: -0, text: "line\nfeed" })).toBe(
      '{"negative_zero":0,"text":"line\\nfeed"}',
    );
  });

  it.each([
    ["undefined", undefined],
    ["non-finite number", Number.POSITIVE_INFINITY],
    ["bigint", 1n],
    ["non-plain object", new Date(0)],
  ])("rejects %s instead of silently changing the hashed value", (_label, value) => {
    expect(() => canonicalJsonStringify(value)).toThrow(TypeError);
  });

  it("rejects circular values but permits repeated non-circular references", () => {
    const shared = { value: 1 };
    expect(canonicalJsonStringify({ left: shared, right: shared })).toBe(
      '{"left":{"value":1},"right":{"value":1}}',
    );

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => canonicalJsonStringify(circular)).toThrow("circular");
  });
});
