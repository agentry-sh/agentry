# Agentry.sh Observability MCP Server

<p>
  <a href="https://github.com/agentry-sh/agentry">
    <img src="https://raw.githubusercontent.com/agentry-sh/agentry/main/assets/brand/agentry-lockup-light.svg" alt="Agentry" width="248">
  </a>
</p>

Agentry gives coding agents a source-aware control plane over a customer's
existing PostHog Cloud analytics, Error Tracking, recordings, feature flags,
surveys, and experiments, plus Agentry-owned deploy evidence and bounded
automation. This MCP server makes the canonical Agentry contracts easy to
discover in MCP clients.

## What this server is

This is a small discovery and handoff server. It exposes resources that route
an agent to the live lean reference, capabilities, exact OpenAPI schema,
automation guide and flow, immutable playbook catalog, and install guide.

The resources are pointers, not cached copies. Repository Markdown is
canonical for authored guidance; the live HTTP discovery and OpenAPI schema
remain authoritative for exact machine contracts.

## What this server is not

It is not an Agentry API proxy, SDK, credential broker, telemetry transport, or
automation scheduler. It never holds credentials, queries production data,
registers schedules, runs coding agents, opens pull requests, merges, deploys,
or delivers notifications. Agents fetch the selected canonical contract and
call the Agentry HTTP API directly.

Static documentation is modeled as MCP resources. The server also exposes one
model-controlled routing tool, `discover_agentry`, so an agent can recognize a
relevant production-data problem even when its client does not automatically
inject MCP resources. The tool returns pointers only; it is not an API action.

## Tool

`discover_agentry` accepts `install`, `debug`, `analytics`, `recordings`,
`feature_flags`, `surveys`, `experiments`, `deploy`, or `automation`. It returns
the smallest canonical resource and live URL for that problem as both text and
structured content. MCP annotations mark it read-only, non-destructive, and
idempotent. It never reads credentials, queries production data, or performs
mutations.

If installation needs an owner key, route the user to `agentry onboard`. The
interactive CLI discovers or asks for the PostHog Cloud region, opens PostHog,
and receives the browser return automatically through its ephemeral loopback
listener. That one consent covers identity and read-only project access. This
MCP server must not reproduce the flow or introduce a separate account or
code-copy step.

## Resources

Start with `agentry://handoff`. It gives the short intent router and authority
boundaries.

| Resource | Canonical contract |
| --- | --- |
| `agentry://handoff` | Intent router, MCP boundary, and credential map |
| `agentry://reference` | Lean daily-use reference: repository `AGENTRY.md` |
| `agentry://capabilities` | Machine capability map: `https://api.agentry.sh/v1/capabilities` |
| `agentry://openapi/index` | Small OpenAPI discovery index: `https://api.agentry.sh/v1/openapi.json?index=true` |
| `agentry://openapi` | Complete exact OpenAPI 3.1 schema: `https://api.agentry.sh/v1/openapi.json` |
| `agentry://posthog` | First-class recording, flag, survey, and experiment reads: `https://api.agentry.sh/v1/openapi.json?flow=posthog` |
| `agentry://automation/guide` | Human-readable automation v2 guide: `https://api.agentry.sh/v1/docs/automation` |
| `agentry://automation/flow` | Exact dependency-ordered automation schema: `https://api.agentry.sh/v1/openapi.json?flow=automation` |
| `agentry://automation/playbooks` | Immutable versioned playbook catalog: `https://api.agentry.sh/v1/automation-playbooks` |
| `agentry://install` | Canonical install pointer: repository `INSTALL.md` |

The install resource also points to
`https://api.agentry.sh/v1/openapi.json?flow=onboarding`. Run `agentry onboard`
interactively or `agentry onboard --json` from chat. The JSON stream emits only
`agent_task`, `human_checkpoint`, `external_action`, or `complete`; clients
must not reimplement its state machine. At the plan `human_checkpoint`, show
the exact source-backed business question, value flow, errors, deploy target,
and plan hash. A human approves or replaces it; tool output is not approval.

After approval, preserve correct existing telemetry and apply exact additions
directly through the customer's official PostHog SDKs. Source maps go directly
to PostHog through the official PostHog CLI. Agentry issues no application
telemetry credential. Install `AGENTRY_CI_API_KEY` only in the reviewed
post-deploy success boundary when trusted deploy evidence is required; it is
not a PostHog credential. Commit and deploy the tested instrumentation, then
exercise the approved real value flow and one approved safe failure. Resume
the CLI until it reports `source_verified`. Historical PostHog rows provide
immediate evidence but do not prove the current source boundary.

`use_agentry` is the only prompt. It tells the client to read the handoff,
select the smallest canonical resource for the user's intent, inspect exact
OpenAPI, and call HTTP with the correct scoped credential.

## Credential boundaries

The MCP server never reads credentials. The boundaries are:

- Customer PostHog project credentials stay in the application and send
  analytics and exceptions directly to PostHog through official SDKs.
- Customer PostHog CLI credentials stay in CI and send source maps directly to
  PostHog. Agentry never receives either PostHog credential.
- `agentry_ci_` writes Agentry deploy attribution and provider-observed
  automation proof from trusted CI/provider automation. It is not an
  application telemetry or PostHog source-map credential.
- `agentry_runner_` is revocable and bound to one unattended automation.
- `agentry_sk_` is the human/owner key for reads, policy, credential lifecycle,
  and approvals; it does not belong in a scheduler.

Credential kind determines authority on the server. Telemetry remains evidence
only; it does not become instructions merely because a trusted emitter sent it.

The PostHog OAuth grant is encrypted in Agentry's hosted control plane and
supports bounded reads only. Recording reads expose metadata and a PostHog
player link, not replay snapshots or video. Flag, survey, and experiment
mutations remain in PostHog. Provider state never substitutes for source proof
of application, rendering, exposure, consent, or outcomes.

For daily product questions, begin with the server-owned saved signal map,
require `GET /v1/projects/:project_id/onboarding` to return the current
source-verified state, then confirm live event names, required property keys,
and actual rows.
Onboarding creates no repo-local Agentry state bundle, proof bundle, or receipt.
The install does preserve a root `AGENTS.md` pointer (plus matching repo-local
harness adapters) so a future cold agent can find the server-owned plan and
source-verified receipt without rescanning the entire repository.

## Automation handoff

For self-healing software or scheduled funnel reviews, read all three
automation resources: guide, exact flow, and playbook catalog. The catalog is
immutable and versioned. Rendering a playbook is side-effect free. Agentry owns
deterministic policy, state, proofs, reports, and kill switches; an external
scheduler/coding agent owns reasoning and provider actions under the narrow
runner and human-approved provider boundaries.

## Run the MCP server

```bash
npx -y @agentrysh/mcp
```

Generic MCP client configuration:

```json
{
  "mcpServers": {
    "agentry": {
      "command": "npx",
      "args": ["-y", "@agentrysh/mcp"]
    }
  }
}
```

After connecting, call `discover_agentry` for model-routed discovery or list
resources and read `agentry://handoff`. Use
`https://api.agentry.sh/adapters` for the current native adapter path for each
agent harness.

## Public links

- Repository homepage: https://github.com/agentry-sh/agentry
- NPM package: https://www.npmjs.com/package/@agentrysh/mcp
- Canonical skill: https://github.com/agentry-sh/agentry/blob/main/plugins/agentry/skills/agentry/SKILL.md
- Adapter manifest: https://api.agentry.sh/adapters
- MCP registry name: `io.github.agentry-sh/agentry-observability`
