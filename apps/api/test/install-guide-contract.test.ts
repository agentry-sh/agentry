import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const AGENTRY_INSTALL_MD = readFileSync(
  new URL("../../../INSTALL.md", import.meta.url),
  "utf8",
);

describe("CLI and chat onboarding guide", () => {
  it("uses one CLI state machine for interactive and chat onboarding", () => {
    expect(AGENTRY_INSTALL_MD).toContain("npx -y @agentrysh/cli onboard");
    expect(AGENTRY_INSTALL_MD).toContain("npx -y @agentrysh/cli onboard --json");
    expect(AGENTRY_INSTALL_MD).toContain("The CLI is the stateful secure actuator");
    for (const checkpoint of [
      "`agent_task`",
      "`human_checkpoint`",
      "`external_action`",
      "`complete`",
    ]) {
      expect(AGENTRY_INSTALL_MD).toContain(checkpoint);
    }
    expect(AGENTRY_INSTALL_MD).toContain("Do not reimplement onboarding logic in an agent skill");
    expect(AGENTRY_INSTALL_MD).toContain("under `~/.agentry/`");
  });

  it("connects one customer-owned PostHog Cloud project through read-only OAuth", () => {
    expect(AGENTRY_INSTALL_MD).toContain("read-only PostHog Cloud OAuth");
    expect(AGENTRY_INSTALL_MD).toContain("stores the access and refresh tokens encrypted");
    expect(AGENTRY_INSTALL_MD).toContain("neither the CLI nor the coding agent receives them");
    expect(AGENTRY_INSTALL_MD).toContain("`active`");
    expect(AGENTRY_INSTALL_MD).toContain("`reauth_required`");
    expect(AGENTRY_INSTALL_MD).toContain("`detached`");
    expect(AGENTRY_INSTALL_MD).toContain("must never delete or modify the customer's PostHog project");
    expect(AGENTRY_INSTALL_MD).toContain("PostHog Cloud only");
    expect(AGENTRY_INSTALL_MD).toContain("Do not silently substitute a personal API key");
  });

  it("separates historical evidence from source verification", () => {
    expect(AGENTRY_INSTALL_MD).toContain("`historically_observed`");
    expect(AGENTRY_INSTALL_MD).toContain("`source_verified`");
    expect(AGENTRY_INSTALL_MD).toContain("Historical observation is immediate value, not onboarding completion");
    expect(AGENTRY_INSTALL_MD).toContain("Do not accept or preserve a generic `verified` alias");
    expect(AGENTRY_INSTALL_MD).toContain("must not claim current source ownership from event names alone");
    expect(AGENTRY_INSTALL_MD).toContain("exact approved plan hash");
    expect(AGENTRY_INSTALL_MD).toContain("fresh read-only review pass");
    expect(AGENTRY_INSTALL_MD).toContain("real shipped path");
  });

  it("sends application telemetry and source maps directly to PostHog", () => {
    expect(AGENTRY_INSTALL_MD).toContain("existing official PostHog SDK");
    expect(AGENTRY_INSTALL_MD).toContain("application sends analytics and exceptions directly to PostHog");
    expect(AGENTRY_INSTALL_MD).toContain("there is no Agentry transport, runtime helper, delivery queue, or proxy endpoint");
    expect(AGENTRY_INSTALL_MD).toContain("official PostHog CLI directly against the customer's PostHog project");
    expect(AGENTRY_INSTALL_MD).toContain("Do not route source maps through Agentry");
    expect(AGENTRY_INSTALL_MD).toContain("`AGENTRY_CI_API_KEY` as a PostHog credential");
    expect(AGENTRY_INSTALL_MD).toContain("exclude secrets, raw content, unnecessary personal data");
  });

  it("keeps deploy proof separate and requires real deployment and traffic", () => {
    expect(AGENTRY_INSTALL_MD).toContain("`AGENTRY_CI_API_KEY` may be placed only in the reviewed CI/provider post-success job");
    expect(AGENTRY_INSTALL_MD).toContain("It is not an application telemetry or PostHog source-map credential");
    expect(AGENTRY_INSTALL_MD).toContain("Never emit a deploy from browser code, app startup, request handlers, cron routes");
    expect(AGENTRY_INSTALL_MD).toContain("exercise the real shipped path");
    expect(AGENTRY_INSTALL_MD).toContain("insufficient traffic");
    expect(AGENTRY_INSTALL_MD).toContain("PostHog project and bounded query receipt");
  });

  it("detects the runner but requires explicit enablement and rejects legacy ingest", () => {
    expect(AGENTRY_INSTALL_MD).toContain("detects the available coding-agent harness, scheduler, and secret store");
    expect(AGENTRY_INSTALL_MD).toContain("Detection is not authorization");
    expect(AGENTRY_INSTALL_MD).toContain("one `AGENTRY_RUNNER_API_KEY` bound to that automation");
    expect(AGENTRY_INSTALL_MD).toContain("Draft PR is the maximum autonomous authority");

    for (const retired of [
      "AGENTRY_PUBLIC_API_KEY",
      "AGENTRY_SERVER_API_KEY",
      "agentry_pk_",
      "agentry_server_",
      "/v1/logs/",
      "/v1/analytics/",
      "POSTHOG_MASTER_API_KEY",
      "AGENTRY_ADMIN_TOKEN",
      "definition.telemetry_operations",
      'status: "verified"',
      "installation_complete",
      "X-Agentry-Onboarding-Proof",
      "agentry_onboarding_proof",
    ]) {
      expect(AGENTRY_INSTALL_MD).not.toContain(retired);
    }

    expect(AGENTRY_INSTALL_MD.split("\n").length).toBeLessThan(220);
    expect(Buffer.byteLength(AGENTRY_INSTALL_MD)).toBeLessThan(32 * 1_024);
  });
});
