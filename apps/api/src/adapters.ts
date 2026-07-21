// Cross-platform distribution adapters.
//
// Every agent ecosystem reads a different file — skills, AGENTS.md, Copilot
// instructions, Cursor/Cline/Roo/Continue/Zed rules, Devin Desktop/Windsurf
// rules and skills, Gemini context, Aider conventions, or MCP config — but the
// adapter contract is identical:
// identify Agentry, link the canonical docs and API, and keep the install flow
// in one place. None of these adapters duplicate install logic or API behavior.

import {
  PUBLIC_AGENT_REFERENCE_URL,
  PUBLIC_INSTALL_DOC_URL,
  PUBLIC_ORGANIZATION_URL,
  PUBLIC_REPOSITORY_URL,
  PUBLIC_SKILL_URL,
} from "./public-links.js";

const API = "https://api.agentry.sh";
const SKILL_URL = PUBLIC_SKILL_URL;
const NPM_MCP_URL = "https://www.npmjs.com/package/@agentrysh/mcp";
const PUBLIC_MCP_REPO = PUBLIC_REPOSITORY_URL;
const PUBLIC_SKILL_REPO = PUBLIC_REPOSITORY_URL;
const CODEX_MARKETPLACE_CATALOG =
  `${PUBLIC_REPOSITORY_URL}/blob/main/.agents/plugins/marketplace.json`;
const CODEX_MARKETPLACE_ADD =
  "codex plugin marketplace add agentry-sh/agentry";
const CODEX_PLUGIN_ADD = "codex plugin add agentry@agentry";
const CLAUDE_MARKETPLACE_CATALOG =
  `${PUBLIC_REPOSITORY_URL}/blob/main/.claude-plugin/marketplace.json`;
const CLAUDE_MARKETPLACE_ADD =
  "claude plugin marketplace add agentry-sh/agentry";
const CLAUDE_PLUGIN_INSTALL = "claude plugin install agentry@agentry";
const MCP_REGISTRY_NAME = "io.github.agentry-sh/agentry-observability";
const MCP_CONFIG = {
  mcpServers: {
    agentry: {
      command: "npx",
      args: ["-y", "@agentrysh/mcp"],
    },
  },
};

const SUPPORTED_AGENT_SURFACES = [
  "Codex",
  "Claude Code",
  "Cursor",
  "VS Code / GitHub Copilot",
  "Visual Studio / GitHub Copilot",
  "GitHub Copilot coding agent",
  "Devin Desktop / Windsurf Cascade",
  "Cline",
  "Roo Code",
  "Continue",
  "Zed",
  "Gemini CLI",
  "Aider",
  "OpenCode",
  "ChatGPT custom GPT Actions",
  "generic MCP clients",
  "AGENTS.md-aware agents",
];

const AGENTS_MD_COMPATIBLE_EXAMPLES = [
  "Jules",
  "Factory",
  "Amp",
  "goose",
  "Warp",
  "JetBrains Junie",
  "Augment Code",
  "Kilo Code",
  "Phoenix",
  "Semgrep",
  "Ona",
  "UiPath coded agents",
];

export const ADAPTER_DESCRIPTION =
  "Agentry — the agent-first control plane over a customer's existing PostHog Cloud project.";

export function renderSkillMarkdown(): string {
  return `---
name: agentry
description: Use for Agentry setup or use; analytics, errors, recordings, feature flags, surveys, experiments, deploy attribution, production investigation, or agentic automation.
---

# Agentry

${pointerBody()}
`;
}

// The shared body every adapter wraps. Format-agnostic markdown.
function pointerBody(): string {
  return `Agentry connects a customer's PostHog Cloud project to their coding agent. PostHog remains authoritative for analytics, Error Tracking, recordings, feature flags, surveys, and experiments; Agentry owns source-backed plans, bounded evidence, deploy attribution, approvals, and automation state. Docs/filtered OpenAPI are authoritative.

Route by task:

- Install or change telemetry: ${PUBLIC_INSTALL_DOC_URL}
- Exact onboarding schema: https://api.agentry.sh/v1/openapi.json?flow=onboarding
- Daily product/reliability questions: ${PUBLIC_AGENT_REFERENCE_URL}
- Recordings, flags, surveys, and experiments: https://api.agentry.sh/v1/openapi.json?flow=posthog
- Product discovery: https://api.agentry.sh/
- Exact payloads: https://api.agentry.sh/v1/openapi.json?index=true; filter with \`?flow=<name>\`, \`?tag=<name>\`, or \`?path=<encoded-path>&method=<method>\`.
- Automations: https://api.agentry.sh/v1/docs/automation, https://api.agentry.sh/v1/openapi.json?flow=automation, and immutable versioned https://api.agentry.sh/v1/automation-playbooks
- Refresh agent adapter pointers: https://api.agentry.sh/adapters

## First installation

Run \`agentry onboard\` interactively or \`agentry onboard --json\` from an agent, then follow its \`agent_task\`, \`human_checkpoint\`, \`external_action\`, or \`complete\` checkpoint. The CLI owns sign-in, project claim, discovery, plan hashes, resumption, and credential storage.

With no owner key, \`agentry login\` starts an ephemeral loopback listener, opens one PostHog sign-in/consent URL, and returns automatically. No separate Agentry account or copied code exists; provider tokens never reach the CLI or agent. JSON mode asks the human to run interactive login once.

Read the canonical \`INSTALL.md\` URL above completely. Connect the customer's existing PostHog Cloud project through browser-based read-only OAuth. Deeply inspect the repository before choosing telemetry: map the actor, entry, every material durable milestone, business result, impactful failure surfaces, current official PostHog setup, and real deploy boundary. Inspect recording metadata, flags, surveys, and experiments as provider state; prove source application, rendering, exposure, consent, and outcomes separately. Event names and journey length are project-specific.

Compare bounded PostHog history with current source. Label matching history \`historically_observed\`; it does not prove current source ownership. Show the exact source-backed plan and hash before editing. Installation completes only when the CLI returns \`complete\` with required signals \`source_verified\`; do not preserve a generic verified alias.

Preserve correct existing PostHog telemetry. Add or move signals only after exact plan approval, emit product outcomes after success, and use the customer's official PostHog SDKs and CLI directly. Application analytics and exceptions go straight to customer PostHog Cloud. Source maps go straight through the official PostHog CLI. Agentry never proxies either path.

Before plan submission, use a fresh read-only reviewer or fresh context to try to falsify the business flow, alternate owners, indirect state writes, exact properties, failures, privacy, identity, and deploy ordering. Telemetry-derived state is observational: do not change product queues, webhooks, notifications, retries, responses, or payloads to satisfy proof.

Keep source snapshots, plans, receipts, and credentials outside the repo. Historical rows cannot prove a current source boundary, and server evidence cannot infer a physical click or external actor. Exercise the reviewed shipped paths after deployment before claiming source verification.

Credentials are non-interchangeable:

- PostHog SDK/project credentials: customer-owned application telemetry sent directly to PostHog.
- PostHog CLI credential: customer-owned source-map upload from trusted CI directly to PostHog.
- PostHog OAuth: encrypted read-only control-plane connection for bounded analytics, Error Tracking, recording-metadata, flag, survey, and experiment reads; access/refresh tokens are never exposed to the CLI, coding agent, app, CI, or runner.
- \`AGENTRY_CI_API_KEY\` (\`agentry_ci_\`): Agentry deploy evidence and CI proof only.
- \`AGENTRY_RUNNER_API_KEY\` (\`agentry_runner_\`): exactly one automation.
- \`AGENTRY_PRIVATE_API_KEY\` (\`agentry_sk_\`): interactive owner/member only.

An owner key is never a scheduler credential. An unattended scheduler gets only its automation-scoped runner key. Do not emit deploys from browser, app startup, request handlers, or cron routes. Keep secrets out of repos, telemetry, prompts, and output.

Use a custom User-Agent for non-browser direct HTTP calls. Browser fetch uses the browser's own User-Agent and cannot set this header manually.`;
}
function supportedSurfacesSentence(): string {
  return SUPPORTED_AGENT_SURFACES.join(", ");
}

function renderRuleMarkdown(title: string): string {
  return `# ${title}\n\n${pointerBody()}\n`;
}

// AGENTS.md section (cross-tool; read by Copilot and other AGENTS.md-aware agents).
export function renderAgentsSection(): string {
  return `## Agentry (observability)\n\n${pointerBody()}\n`;
}

// Cursor rule — MDC = YAML frontmatter + markdown body.
export function renderCursorMdc(): string {
  return `---
description: ${ADAPTER_DESCRIPTION}
alwaysApply: false
---

# Agentry

${pointerBody()}
`;
}

// Windsurf rules — plain markdown, no frontmatter.
export function renderWindsurfRules(): string {
  return `# Agentry — observability over HTTP\n\n${pointerBody()}\n`;
}

// Devin Desktop / Windsurf workspace-rules directory accepts markdown rule
// files with trigger metadata. Legacy Windsurf paths are still covered below.
export function renderWindsurfWorkspaceRule(): string {
  return `---
trigger: model_decision
description: ${ADAPTER_DESCRIPTION}
---

# Agentry - observability over HTTP

${pointerBody()}
`;
}

// GitHub Copilot across VS Code, Visual Studio, JetBrains, and GitHub.com.
export function renderCopilotInstructions(): string {
  return renderRuleMarkdown("Agentry for GitHub Copilot");
}

// VS Code / Visual Studio targeted instruction file. The applyTo frontmatter
// keeps the file valid for .github/instructions/agentry.instructions.md.
export function renderVSCodeInstructions(): string {
  return `---
applyTo: "**"
description: ${ADAPTER_DESCRIPTION}
---

# Agentry

${pointerBody()}
`;
}

export function renderClineRules(): string {
  return renderRuleMarkdown("Agentry for Cline");
}

export function renderRooRules(): string {
  return renderRuleMarkdown("Agentry for Roo Code");
}

export function renderContinueRule(): string {
  return `---
name: Agentry
description: ${ADAPTER_DESCRIPTION}
alwaysApply: false
---

# Agentry

${pointerBody()}
`;
}

export function renderZedRules(): string {
  return renderRuleMarkdown("Agentry for Zed");
}

export function renderGeminiMd(): string {
  return renderRuleMarkdown("Agentry for Gemini CLI");
}

export function renderAiderConventions(): string {
  return renderRuleMarkdown("Agentry for Aider");
}

// Claude Code plugin manifest. A marketplace repo bundles the canonical skill
// (fetched from the canonical repository) under skills/agentry/SKILL.md.
export function renderClaudePluginManifest(): Record<string, unknown> {
  return {
    name: "agentry",
    version: "0.1.4",
    description: "Agentry skill for source-aware, read-only PostHog analytics, errors, recordings, feature flags, surveys, experiments, deploy attribution, and automation.",
    author: { name: "Agentry", url: PUBLIC_ORGANIZATION_URL },
    homepage: PUBLIC_REPOSITORY_URL,
    repository: PUBLIC_MCP_REPO,
    license: "Apache-2.0",
    keywords: [
      "agentry",
      "observability",
      "analytics",
      "logging",
      "error-monitoring",
      "deploy-attribution",
      "product-analytics",
      "session-recordings",
      "feature-flags",
      "surveys",
      "experiments",
      "production-debugging",
      "coding-agents",
    ],
    skills: ["./skills/agentry"],
  };
}

// Index: what adapters exist and how to install each. Every adapter is a thin
// router to the canonical task guide and filtered OpenAPI contract.
export function adaptersIndex(): Record<string, unknown> {
  return {
    description:
      "Per-ecosystem pointers for Agentry, the agent-first control plane over a customer's existing PostHog Cloud project. " +
      "Each adapter routes install, day-to-day use, PostHog resource reads, exact schema lookup, and agentic automation to the same canonical surfaces. " +
      "During onboarding, the CLI detects applicable agent harnesses and proposes repo-local pointers; explicit approval precedes any write or unattended enablement. " +
      "Always preserve a root AGENTS.md Agentry section. User-global skill destinations are optional, ask-first conveniences and are not source-verification evidence. " +
      "Any client also works with no adapter by fetching / and /v1/openapi.json?index=true.",
    supported_agent_surfaces: SUPPORTED_AGENT_SURFACES,
    agents_md_compatible_examples: AGENTS_MD_COMPATIBLE_EXAMPLES,
    canonical: {
      website: PUBLIC_REPOSITORY_URL,
      discovery: "/",
      openapi: "/v1/openapi.json",
      discovery_url: `${API}/`,
      openapi_url: `${API}/v1/openapi.json`,
      openapi_index_url: `${API}/v1/openapi.json?index=true`,
      skill: SKILL_URL,
      install: PUBLIC_INSTALL_DOC_URL,
      reference: PUBLIC_AGENT_REFERENCE_URL,
      onboarding_flow: `${API}/v1/openapi.json?flow=onboarding`,
      posthog_flow: `${API}/v1/openapi.json?flow=posthog`,
      automation_guide: `${API}/v1/docs/automation`,
      automation_flow: `${API}/v1/openapi.json?flow=automation`,
      automation_playbooks: `${API}/v1/automation-playbooks`,
      adapters: `${API}/adapters`,
      npm_mcp: NPM_MCP_URL,
      mcp_repository: PUBLIC_MCP_REPO,
      skill_repository: PUBLIC_SKILL_REPO,
      codex_marketplace_catalog: CODEX_MARKETPLACE_CATALOG,
      claude_marketplace_catalog: CLAUDE_MARKETPLACE_CATALOG,
      mcp_registry_name: MCP_REGISTRY_NAME,
    },
    mcp_client_config: MCP_CONFIG,
    install_policy: {
      detect_all_harnesses: true,
      default_repo_pointer: "AGENTS.md",
      default_scope:
        "Install every detected repo-local adapter. Ask once before writing multiple user-global skill destinations, then default to all detected harnesses unless the user narrows scope.",
      report_back:
        "Before finalizing, list the harnesses detected and the adapter paths written.",
      harness_detection: {
        codex:
          "$CODEX_HOME is set, ~/.codex/ exists, or the current agent harness is Codex.",
        claude_code:
          ".claude/ exists, ~/.claude/ exists, or the current agent harness is Claude Code.",
        cursor: ".cursor/ exists.",
        vscode_copilot:
          ".vscode/ exists, .github/ exists, GitHub Copilot is installed in VS Code, or the user mentions VS Code/Copilot.",
        visual_studio_copilot:
          "A .sln/.csproj/.vbproj/.fsproj repo, Visual Studio is the current IDE, or the user mentions Visual Studio/Copilot.",
        github_copilot_coding_agent:
          "GitHub Copilot coding agent or Copilot code review is used for this repository.",
        windsurf:
          ".devin/ exists, .windsurf/ exists, .windsurfrules exists, or Devin Desktop/Windsurf Cascade is the current harness.",
        cline: ".clinerules/ exists, .clinerules exists, or Cline is installed/current.",
        roo_code:
          ".roo/ exists, .roorules exists, or Roo Code is installed/current.",
        continue_dev:
          ".continue/ exists or Continue is installed/current.",
        zed: ".rules exists, .zed/ exists, or Zed Agent Panel is used.",
        gemini_cli:
          "GEMINI.md exists, .gemini/ exists, or Gemini CLI is the current harness.",
        aider:
          "CONVENTIONS.md, .aider.conf.yml, or .aider* exists, or aider is the current harness.",
        opencode:
          ".opencode/ exists, ~/.config/opencode is relevant, or OpenCode is the current harness.",
        mcp_clients:
          "Any client exposes MCP server configuration, including Cline, Roo Code, VS Code, Zed, Cursor, Claude Desktop, or other MCP-capable agent hosts.",
        agents_md:
          "Always applicable as the repo-local cross-tool pointer.",
        chatgpt:
          "No repo file; tell the user to import the OpenAPI Action schema.",
      },
    },
    adapters: {
      claude_code: {
        format: "skill",
        skill_url: SKILL_URL,
        install:
          "mkdir -p .claude/skills/agentry && curl -fsSL -A 'AgentryAgent/1.0' " +
          `${SKILL_URL} > .claude/skills/agentry/SKILL.md`,
        install_project:
          "mkdir -p .claude/skills/agentry && curl -fsSL -A 'AgentryAgent/1.0' " +
          `${SKILL_URL} > .claude/skills/agentry/SKILL.md`,
        install_user:
          "mkdir -p ~/.claude/skills/agentry && curl -fsSL -A 'AgentryAgent/1.0' " +
          `${SKILL_URL} > ~/.claude/skills/agentry/SKILL.md`,
        scope_note:
          "Project-local .claude/skills/agentry/SKILL.md applies to this repo; user-global ~/.claude/skills/agentry/SKILL.md applies to future Claude Code sessions across repos.",
        plugin_manifest: "/adapters/claude-plugin.json",
        plugin_install: `${CLAUDE_MARKETPLACE_ADD} && ${CLAUDE_PLUGIN_INSTALL}`,
        plugin_note:
          "One-command plugin install (bundles this skill, auto-updates). Or drop the skill file directly with the `install` command above.",
      },
      codex: {
        format: "skill",
        skill_url: SKILL_URL,
        plugin_marketplace_add: CODEX_MARKETPLACE_ADD,
        plugin_install: CODEX_PLUGIN_ADD,
        plugin_note:
          "Agentry is distributed as a Git-backed Codex marketplace source. It is not globally searchable in every Codex account until the user adds this marketplace, receives a workspace share, or OpenAI curates it.",
        install:
          "mkdir -p \"${CODEX_HOME:-$HOME/.codex}/skills/agentry\" && curl -fsSL -A 'AgentryAgent/1.0' " +
          `${SKILL_URL} > ` +
          "\"${CODEX_HOME:-$HOME/.codex}/skills/agentry/SKILL.md\"",
        install_user:
          "mkdir -p \"${CODEX_HOME:-$HOME/.codex}/skills/agentry\" && curl -fsSL -A 'AgentryAgent/1.0' " +
          `${SKILL_URL} > ` +
          "\"${CODEX_HOME:-$HOME/.codex}/skills/agentry/SKILL.md\"",
        install_note:
          "Codex skills are user-level by default. Install this whenever Codex is the current harness, $CODEX_HOME is set, or ~/.codex exists; also write AGENTS.md for repo-local recognition.",
      },
      agents_md: {
        format: "AGENTS.md section",
        url: "/adapters/AGENTS.md",
        install: "Append to AGENTS.md at the repo root.",
        install_note:
          "Install by default for every repo; this is the cross-tool fallback even when client-specific skills are also installed.",
      },
      cursor: {
        format: ".mdc rule",
        url: "/adapters/cursor.mdc",
        install: "Write to .cursor/rules/agentry.mdc.",
      },
      vscode_copilot: {
        format: "GitHub Copilot custom instructions",
        url: "/adapters/copilot-instructions.md",
        targeted_url: "/adapters/agentry.instructions.md",
        install:
          "Write to .github/copilot-instructions.md, or append to it if it already exists. For targeted VS Code instructions, write /adapters/agentry.instructions.md to .github/instructions/agentry.instructions.md.",
        install_note:
          "VS Code also reads AGENTS.md, so keep the AGENTS.md adapter as the cross-tool baseline.",
      },
      visual_studio_copilot: {
        format: "GitHub Copilot custom instructions",
        url: "/adapters/copilot-instructions.md",
        targeted_url: "/adapters/agentry.instructions.md",
        install:
          "Write to .github/copilot-instructions.md or .github/instructions/agentry.instructions.md. Visual Studio users may need to enable custom instructions in Copilot Chat settings.",
      },
      github_copilot_coding_agent: {
        format: "GitHub Copilot repository instructions",
        url: "/adapters/copilot-instructions.md",
        targeted_url: "/adapters/agentry.instructions.md",
        install:
          "Write repository instructions to .github/copilot-instructions.md and/or .github/instructions/agentry.instructions.md so Copilot coding agent and code review know when to route Agentry work to the canonical docs.",
      },
      windsurf: {
        format: "rule or skill",
        workspace_rule_url: "/adapters/windsurf.md",
        url: "/adapters/windsurfrules",
        skill_url: SKILL_URL,
        install:
          "Prefer .devin/rules/agentry.md for current Devin Desktop/Windsurf workspace rules. Use .windsurf/rules/agentry.md when the project already uses the legacy directory, or append/update .windsurfrules for the legacy single-file convention.",
        install_skill:
          "For native skill discovery, write the live skill to .windsurf/skills/agentry/SKILL.md or .agents/skills/agentry/SKILL.md.",
        install_skill_project:
          "mkdir -p .windsurf/skills/agentry && curl -fsSL -A 'AgentryAgent/1.0' " +
          `${SKILL_URL} > .windsurf/skills/agentry/SKILL.md`,
      },
      cline: {
        format: "Cline workspace rule",
        url: "/adapters/cline.md",
        install:
          "Write to .clinerules/agentry.md. Cline also reads AGENTS.md, .cursorrules, and .windsurfrules, so do not duplicate if an existing cross-tool file already carries the Agentry section.",
      },
      roo_code: {
        format: "Roo Code workspace rule",
        url: "/adapters/roo.md",
        install:
          "Prefer .roo/rules/agentry.md. If the project uses the fallback single-file convention, append/update .roorules instead.",
      },
      continue_dev: {
        format: "Continue rule",
        url: "/adapters/continue.md",
        install: "Write to .continue/rules/agentry.md.",
      },
      zed: {
        format: "Zed project rule",
        url: "/adapters/zed.rules",
        install:
          "Write to .rules at the project root when Zed is the target. If AGENTS.md already exists, Zed can use that instead; avoid duplicating the same Agentry section in both.",
      },
      gemini_cli: {
        format: "Gemini CLI context",
        url: "/adapters/GEMINI.md",
        install:
          "Append to GEMINI.md at the repo root, or create it if missing. If the repo configures Gemini to read AGENTS.md, the AGENTS.md adapter is enough.",
      },
      aider: {
        format: "Aider conventions",
        url: "/adapters/aider-conventions.md",
        install:
          "Append the Agentry section to CONVENTIONS.md if it exists, or write AGENTRY_CONVENTIONS.md and add it to .aider.conf.yml `read:` so aider loads it as read-only context.",
      },
      opencode: {
        format: "OpenCode rule or skill",
        skill_url: SKILL_URL,
        install:
          "Prefer the shared AGENTS.md adapter for repo rules. For native skill discovery, write the live skill to .opencode/skills/agentry/SKILL.md, .agents/skills/agentry/SKILL.md, or .claude/skills/agentry/SKILL.md.",
        install_project:
          "mkdir -p .opencode/skills/agentry && curl -fsSL -A 'AgentryAgent/1.0' " +
          `${SKILL_URL} > .opencode/skills/agentry/SKILL.md`,
      },
      mcp_clients: {
        format: "MCP stdio server config",
        package: "@agentrysh/mcp",
        npm: NPM_MCP_URL,
        registry_name: MCP_REGISTRY_NAME,
        config: MCP_CONFIG,
        install:
          "Add mcpServers.agentry with command `npx` and args [`-y`, `@agentrysh/mcp`] to any MCP-capable client. This MCP only returns canonical discovery, docs, filtered OpenAPI, and automation pointers.",
      },
      chatgpt: {
        format: "OpenAPI Action",
        action_schema: `${API}/v1/openapi.json`,
        install:
          "In a custom GPT, add an Action and import the OpenAPI URL above. Works for any OpenAPI-consuming agent.",
      },
    },
    next_action:
      "Fetch the adapter for your client and write it to the path shown, then the " +
      "agent recognises Agentry asks and drives the HTTP API directly. Detect all " +
      "available harnesses and install every applicable adapter, not just the first " +
      "one found. Supported surfaces include " +
      supportedSurfacesSentence() +
      ". During onboarding, let the CLI propose detected repo-local pointers and require approval before writing them. Outside onboarding, an adapter is optional because any agent can route by intent from / and use /v1/openapi.json?index=true for exact schemas.",
  };
}
