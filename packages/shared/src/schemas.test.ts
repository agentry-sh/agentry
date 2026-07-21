import { describe, expect, it } from "vitest";
import {
  CreateProjectRequestSchema,
  SignupRequestSchema,
} from "./schemas.js";

describe("SignupRequestSchema", () => {
  it("accepts valid email", () => {
    expect(SignupRequestSchema.parse({ email: "a@b.com" }).email).toBe("a@b.com");
  });
  it("rejects junk", () => {
    expect(() => SignupRequestSchema.parse({ email: "not-an-email" })).toThrow();
    expect(() => SignupRequestSchema.parse({})).toThrow();
  });
});

describe("CreateProjectRequestSchema", () => {
  it("accepts minimum", () => {
    expect(CreateProjectRequestSchema.parse({ name: "p" }).name).toBe("p");
  });
  it("accepts full", () => {
    const p = CreateProjectRequestSchema.parse({
      name: "p",
      repo_url: "https://github.com/me/r",
      default_branch: "main",
      local_path: "/abs/path",
    });
    expect(p.repo_url).toBe("https://github.com/me/r");
  });
  it("rejects empty name", () => {
    expect(() => CreateProjectRequestSchema.parse({ name: "" })).toThrow();
  });
});
