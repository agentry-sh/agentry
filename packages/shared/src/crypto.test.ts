import { describe, expect, it } from "vitest";
import { constantTimeEqual, mintApiKey, sha256Hex } from "./crypto.js";

describe("sha256Hex", () => {
  it("hashes deterministically", async () => {
    expect(await sha256Hex("hello")).toBe(await sha256Hex("hello"));
    expect(await sha256Hex("hello")).not.toBe(await sha256Hex("world"));
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("constantTimeEqual", () => {
  it("works", () => {
    expect(constantTimeEqual("a", "a")).toBe(true);
    expect(constantTimeEqual("a", "b")).toBe(false);
    expect(constantTimeEqual("ab", "a")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("mintApiKey", () => {
  it("produces an agentry_sk_ prefixed key with consistent hash", async () => {
    const k = await mintApiKey();
    expect(k.raw).toMatch(/^agentry_sk_/);
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex(k.raw)).toBe(k.hash);
    expect(k.prefix).toBe(k.raw.slice(0, "agentry_sk_".length + 8));
  });
  it("never collides", async () => {
    const k1 = await mintApiKey();
    const k2 = await mintApiKey();
    expect(k1.raw).not.toBe(k2.raw);
  });
});
