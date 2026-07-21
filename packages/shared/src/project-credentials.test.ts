import { describe, expect, it } from "vitest";
import {
  CreateProjectCredentialRequestSchema,
  mintProjectCredential,
  parseProjectCredential,
  scopesForProjectCredential,
} from "./project-credentials.js";

describe("project-scoped credentials", () => {
  it.each([
    ["ci_deploy", "agentry_ci_"],
    ["automation_runner", "agentry_runner_"],
  ] as const)("mints and parses %s without losing project binding", async (kind, prefix) => {
    const minted = await mintProjectCredential("project-123", kind);
    expect(minted.raw).toMatch(new RegExp(`^${prefix}project-123\\.`));
    expect(parseProjectCredential(minted.raw)).toMatchObject({ projectId: "project-123", kind });
    expect(minted.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("assigns fixed scopes by execution boundary", () => {
    expect(scopesForProjectCredential("ci_deploy")).toEqual([
      "deploys:write",
      "automation_proofs:write",
    ]);
    expect(scopesForProjectCredential("automation_runner")).toContain("approvals:request");
  });

  it("requires runner credentials to bind one automation and rejects scope-like extras", () => {
    expect(CreateProjectCredentialRequestSchema.safeParse({
      kind: "automation_runner",
      name: "runner",
    }).success).toBe(false);
    expect(CreateProjectCredentialRequestSchema.safeParse({
      kind: "ci_deploy",
      name: "ci",
      scopes: ["runs:write"],
    }).success).toBe(false);
  });
});
