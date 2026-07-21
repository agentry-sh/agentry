import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const AGENTRY_MD = readFileSync(
  new URL("../../../AGENTRY.md", import.meta.url),
  "utf8",
);

describe("lean agent reference readiness", () => {
  it("starts from source-backed meaning and bounded customer PostHog evidence", () => {
    expect(AGENTRY_MD).toMatch(
      /customer's\s+PostHog Cloud analytics, Error Tracking, recordings, flags, surveys, and\s+experiments/,
    );
    expect(AGENTRY_MD).toContain("`session-recordings`");
    expect(AGENTRY_MD).toContain("`feature-flags`");
    expect(AGENTRY_MD).toContain("`surveys`");
    expect(AGENTRY_MD).toContain("`experiments`");
    expect(AGENTRY_MD).toContain("metadata and a PostHog player URL");
    expect(AGENTRY_MD).toContain("A typed read establishes provider state");
    expect(AGENTRY_MD).toContain("saved source-backed signal map");
    expect(AGENTRY_MD).toContain("approved plan hash");
    expect(AGENTRY_MD).toContain("`active`");
    expect(AGENTRY_MD).toContain("`reauth_required`");
    expect(AGENTRY_MD).toContain("`detached`");
    expect(AGENTRY_MD).toContain("`historically_observed`");
    expect(AGENTRY_MD).toContain("`source_verified`");
    expect(AGENTRY_MD).toContain("Historical rows alone do not prove current source semantics");
    expect(AGENTRY_MD).toContain("smallest bounded query");
    expect(AGENTRY_MD).toContain("Needs traffic");
    expect(AGENTRY_MD).toContain("Needs telemetry");
    expect(AGENTRY_MD).toContain("Needs reauthorization");

    expect(AGENTRY_MD).not.toContain("verify-report");
    expect(AGENTRY_MD).not.toContain("POST /v1/install/plan");
    expect(AGENTRY_MD).not.toContain("/implementation-report");
    expect(AGENTRY_MD).not.toContain("/install/verify");
    expect(AGENTRY_MD).not.toContain('status: "verified"');
    expect(AGENTRY_MD).not.toContain("installation_complete");
  });

  it("keeps onboarding in the CLI and rejects the retired ingest boundary", () => {
    expect(AGENTRY_MD).toContain("`agentry onboard`");
    expect(AGENTRY_MD).toContain("`agentry onboard --json`");
    expect(AGENTRY_MD).toContain("`agent_task`");
    expect(AGENTRY_MD).toContain("`human_checkpoint`");
    expect(AGENTRY_MD).toContain("`external_action`");
    expect(AGENTRY_MD).toContain("`complete`");
    expect(AGENTRY_MD).toContain("encrypted read-only OAuth connection");
    expect(AGENTRY_MD).toContain("Agentry issues no application telemetry credential");
    expect(AGENTRY_MD).toContain("Directly to customer PostHog Cloud through official SDKs");
    expect(AGENTRY_MD).toContain("Directly to PostHog through the official PostHog CLI");
    expect(AGENTRY_MD).not.toContain("AGENTRY_PUBLIC_API_KEY");
    expect(AGENTRY_MD).not.toContain("AGENTRY_SERVER_API_KEY");
    expect(AGENTRY_MD).not.toContain("agentry_pk_");
    expect(AGENTRY_MD).not.toContain("agentry_server_");
    expect(AGENTRY_MD).not.toContain("/v1/logs/");
    expect(AGENTRY_MD).not.toContain("/v1/analytics/");
    expect(AGENTRY_MD).not.toContain(".agentry/onboarding.json");
    expect(AGENTRY_MD.split("\n").length).toBeLessThan(240);
    expect(AGENTRY_MD.length).toBeLessThan(14_000);
  });
});
