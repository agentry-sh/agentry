import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  adaptersIndex,
  renderAgentsSection,
  renderAiderConventions,
  renderClineRules,
  renderContinueRule,
  renderCopilotInstructions,
  renderCursorMdc,
  renderGeminiMd,
  renderClaudePluginManifest,
  renderRooRules,
  renderSkillMarkdown,
  renderVSCodeInstructions,
  renderWindsurfRules,
  renderWindsurfWorkspaceRule,
  renderZedRules,
} from "../src/adapters.js";
import {
  PUBLIC_AGENT_REFERENCE_URL,
  PUBLIC_INSTALL_DOC_URL,
  PUBLIC_REPOSITORY_URL,
} from "../src/public-links.js";

const renderedPointers = {
  skill: renderSkillMarkdown(),
  agents: renderAgentsSection(),
  cursor: renderCursorMdc(),
  windsurf: renderWindsurfRules(),
  windsurfWorkspace: renderWindsurfWorkspaceRule(),
  copilot: renderCopilotInstructions(),
  vscode: renderVSCodeInstructions(),
  cline: renderClineRules(),
  roo: renderRooRules(),
  continue: renderContinueRule(),
  zed: renderZedRules(),
  gemini: renderGeminiMd(),
  aider: renderAiderConventions(),
};

describe("generated agent adapter contract", () => {
  it.each(Object.entries(renderedPointers))(
    "%s stays a thin intent router to canonical public surfaces",
    (_name, pointer) => {
      expect(pointer).toContain(PUBLIC_INSTALL_DOC_URL);
      expect(pointer).toContain(PUBLIC_AGENT_REFERENCE_URL);
      expect(pointer).toContain(
        "https://api.agentry.sh/v1/openapi.json?index=true",
      );
      expect(pointer).toContain(
        "https://api.agentry.sh/v1/openapi.json?flow=onboarding",
      );
      expect(pointer).toContain(
        "https://api.agentry.sh/v1/openapi.json?flow=posthog",
      );
      expect(pointer).toContain("?flow=<name>");
      expect(pointer).toContain("?path=<encoded-path>&method=<method>");
      expect(pointer).toContain("https://api.agentry.sh/v1/docs/automation");
      expect(pointer).toContain(
        "https://api.agentry.sh/v1/openapi.json?flow=automation",
      );
      expect(pointer).toContain(
        "https://api.agentry.sh/v1/automation-playbooks",
      );
      expect(pointer).toContain("immutable versioned");
      expect(pointer).toContain("`agentry onboard`");
      expect(pointer).toContain("`agentry onboard --json`");
      expect(pointer).toContain("`agentry login` starts an ephemeral loopback listener");
      expect(pointer).toContain("No separate Agentry account or copied code exists");
      expect(pointer).toContain("`agent_task`");
      expect(pointer).toContain("`human_checkpoint`");
      expect(pointer).toContain("`external_action`");
      expect(pointer).toContain("`complete`");
      expect(pointer).toContain("Deeply inspect the repository");
      expect(pointer).toContain("every material durable milestone");
      expect(pointer).toContain("Event names and journey length are project-specific");
      expect(pointer).toContain("recording metadata, flags, surveys, and experiments as provider state");
      expect(pointer).toContain("prove source application, rendering, exposure, consent, and outcomes separately");
      expect(pointer).toContain("exact source-backed plan and hash");
      expect(pointer).toContain("browser-based read-only OAuth");
      expect(pointer).toContain("`historically_observed`");
      expect(pointer).toContain("`source_verified`");
      expect(pointer).toContain("does not prove current source ownership");
      expect(pointer).toContain("Application analytics and exceptions go straight to customer PostHog Cloud");
      expect(pointer).toContain("Source maps go straight through the official PostHog CLI");
      expect(pointer).toContain("fresh read-only reviewer or fresh context");
      expect(pointer).toContain("Telemetry-derived state is observational");
      expect(pointer).toContain("outside the repo");
      expect(pointer).toContain("cannot infer a physical click or external actor");

      // Canonical raw GitHub URLs are deliberately explicit and slightly
      // longer than the former apex-hosted aliases.
      expect(pointer.length).toBeLessThan(5_100);
      expect(pointer).not.toContain("POST /v1/install/plan");
      expect(pointer).not.toContain("/implementation-report");
      expect(pointer).not.toContain("/install/verify");
      expect(pointer).not.toContain("verify-report");
      expect(pointer).not.toContain("/analytics/query");
      expect(pointer).not.toContain("/approve");
      expect(pointer).not.toContain("approve_plan");
      expect(pointer).not.toContain("AGENTRY_PUBLIC_API_KEY");
      expect(pointer).not.toContain("AGENTRY_SERVER_API_KEY");
      expect(pointer).not.toContain("agentry_pk_");
      expect(pointer).not.toContain("agentry_server_");
      expect(pointer).not.toContain("/v1/logs/");
      expect(pointer).not.toContain("/v1/analytics/");
      expect(pointer).not.toContain('status: "verified"');
      expect(pointer).not.toContain("installation_complete");
      expect(pointer).not.toContain("proof markers");
      expect(pointer).not.toContain("marker-scoped");
      expect(pointer).not.toContain("evidence-helper");
      expect(pointer).not.toContain("empty red baseline");
      expect(pointer).not.toContain(".agentry/onboarding.json");
      expect(pointer).not.toContain("onboarding_v2");
      expect(pointer).not.toContain("/v1/auth/device");
      expect(pointer).not.toContain("```json");
    },
  );

  it("states the customer data plane and three Agentry principals", () => {
    const pointer = renderAgentsSection();

    expect(pointer).toContain(
      "PostHog SDK/project credentials: customer-owned application telemetry sent directly to PostHog",
    );
    expect(pointer).toContain(
      "PostHog CLI credential: customer-owned source-map upload from trusted CI directly to PostHog",
    );
    expect(pointer).toContain(
      "PostHog OAuth: encrypted read-only control-plane connection",
    );
    expect(pointer).toMatch(
      /`AGENTRY_CI_API_KEY` \(`agentry_ci_`\): Agentry deploy evidence and CI proof only/s,
    );
    expect(pointer).toMatch(
      /`AGENTRY_RUNNER_API_KEY` \(`agentry_runner_`\): exactly one automation/s,
    );
    expect(pointer).toMatch(
      /`AGENTRY_PRIVATE_API_KEY` \(`agentry_sk_`\): interactive owner\/member only/s,
    );
    expect(pointer).toContain(
      "An unattended scheduler gets only its automation-scoped runner key",
    );
    expect(pointer).toContain("An owner key is never a scheduler credential");
    expect(pointer).toContain(
      "An unattended scheduler gets only its automation-scoped runner key",
    );
    expect(pointer).toContain("never exposed to the CLI, coding agent, app, CI, or runner");
    expect(pointer).not.toContain("AGENTRY_PUBLIC_API_KEY");
    expect(pointer).not.toContain("AGENTRY_SERVER_API_KEY");
  });

  it("publishes the same routing contract in the adapter index", () => {
    const index = adaptersIndex() as {
      canonical: Record<string, string>;
      adapters: Record<string, Record<string, string>>;
      description: string;
      next_action: string;
    };

    expect(index.canonical).toEqual(
      expect.objectContaining({
        website: PUBLIC_REPOSITORY_URL,
        install: PUBLIC_INSTALL_DOC_URL,
        reference: PUBLIC_AGENT_REFERENCE_URL,
        onboarding_flow:
          "https://api.agentry.sh/v1/openapi.json?flow=onboarding",
        posthog_flow:
          "https://api.agentry.sh/v1/openapi.json?flow=posthog",
        openapi_index_url:
          "https://api.agentry.sh/v1/openapi.json?index=true",
        automation_guide: "https://api.agentry.sh/v1/docs/automation",
        automation_flow:
          "https://api.agentry.sh/v1/openapi.json?flow=automation",
        automation_playbooks:
          "https://api.agentry.sh/v1/automation-playbooks",
      }),
    );
    expect(index.description).toContain("control plane over a customer's existing PostHog Cloud project");
    expect(index.description).toContain("routes install, day-to-day use");
    expect(index.description).toContain("PostHog resource reads");
    expect(index.description).toContain("explicit approval precedes any write or unattended enablement");
    expect(index.description).toContain("Always preserve a root AGENTS.md");
    expect(index.description).toContain("User-global skill destinations are optional");
    expect(index.description).not.toContain("after a verified install");
    expect(index.next_action).toContain("route by intent");
    expect(index.next_action).toContain("require approval before writing them");
    expect(index.next_action).toContain("Outside onboarding, an adapter is optional");
    expect(index.next_action).not.toContain("No adapter is required");
    expect(index.adapters.mcp_clients?.install).toContain(
      "filtered OpenAPI, and automation pointers",
    );
    expect(index.adapters.claude_code?.plugin_install).toBe(
      "claude plugin marketplace add agentry-sh/agentry && claude plugin install agentry@agentry",
    );
    expect(index.adapters.claude_code?.plugin_install).toContain("agentry-sh/agentry");
  });

  it("keeps active repo and packaged skills byte-for-byte generated", () => {
    const skillPaths = [
      "../../../plugins/agentry/skills/agentry/SKILL.md",
    ];

    for (const relativePath of skillPaths) {
      const skillPath = fileURLToPath(new URL(relativePath, import.meta.url));
      expect(readFileSync(skillPath, "utf8")).toBe(renderSkillMarkdown());
    }
  });

  it("renders the packaged Claude plugin manifest exactly", () => {
    const packaged = JSON.parse(readFileSync(
      fileURLToPath(new URL("../../../plugins/agentry/.claude-plugin/plugin.json", import.meta.url)),
      "utf8",
    ));
    expect(renderClaudePluginManifest()).toEqual(packaged);
  });
});
