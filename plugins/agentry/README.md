# Agentry Observability

Agentry connects coding agents to bounded read-only analytics, Error Tracking,
recording metadata, feature flags, surveys, and experiments in a customer's
existing PostHog Cloud project, plus Agentry-owned source and deploy evidence.

Use it when an agent needs to audit or add telemetry, verify signal coverage,
debug production cases, answer product analytics questions, inspect PostHog
resource state, or connect regressions to deploys from live data. PostHog
resource access is read-only; provider configuration changes stay in PostHog.

This plugin packages the Agentry skill for Codex and Claude Code marketplaces. It does
not proxy Agentry API traffic or create a second install flow. When a user asks
to set up Agentry, the skill sends the agent to the canonical repository guide:
https://raw.githubusercontent.com/agentry-sh/agentry/main/INSTALL.md.

Initial setup uses one Sign in with PostHog browser checkpoint for both identity
and read-only project consent. The interactive CLI opens PostHog and returns
automatically through an ephemeral callback on the same computer. The plugin
must not introduce a separate Agentry account, copied completion code, or second
OAuth flow.

Related public surfaces:

- Repository: https://github.com/agentry-sh/agentry
- Install guide: https://github.com/agentry-sh/agentry/blob/main/INSTALL.md
- Canonical skill: https://github.com/agentry-sh/agentry/blob/main/plugins/agentry/skills/agentry/SKILL.md
- MCP package: https://www.npmjs.com/package/@agentrysh/mcp
- MCP registry name: `io.github.agentry-sh/agentry-observability`
