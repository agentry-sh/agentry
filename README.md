<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/brand/agentry-lockup-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="./assets/brand/agentry-lockup-light.svg">
  <img alt="Agentry" src="./assets/brand/agentry-lockup-light.svg" width="310">
</picture>

# The control plane between PostHog and your coding agent

Agentry connects a customer-owned PostHog Cloud project to Codex, Claude Code,
GitHub Actions, or another customer-owned coding-agent runner. It audits the
telemetry that already exists, maps it back to source, finds errors and product
opportunities, proposes reviewable changes, and measures what happened after
deployment.

PostHog stores the analytics and errors. Your agent performs inference and
changes the repository. Agentry is the nerve between them: durable plans,
approvals, deploy correlation, schedules, bounded evidence, and receipts.
It is not another open-source error monitoring backend; it makes the existing
PostHog data plane operable by coding agents.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-4c8bf5.svg)](./LICENSE)
[![CI](https://github.com/agentry-sh/agentry/actions/workflows/ci.yml/badge.svg)](https://github.com/agentry-sh/agentry/actions/workflows/ci.yml)
[![Node.js 22+](https://img.shields.io/badge/node-22%2B-43853d.svg)](./package.json)
[![API](https://img.shields.io/badge/API-live-42b883.svg)](https://api.agentry.sh/)

[Onboard](#onboard-from-cli-or-chat) ·
[Product contract](./PLAN.md) ·
[Agent reference](./AGENTRY.md) ·
[Workflows](./workflows) ·
[OpenAPI](https://api.agentry.sh/v1/openapi.json?index=true) ·
[Pricing](./PRICING.md)

## A small, deliberate product boundary

| System | Responsibility |
| --- | --- |
| **Your PostHog Cloud project** | Raw analytics, exceptions, people, Error Tracking, recordings, feature flags, surveys, experiments, and source-map symbolication |
| **Agentry** | Read-only OAuth and bounded first-class reads, source-backed signal map, deploy attribution, approvals, automation state, and receipts |
| **Your coding agent** | Repository inspection, diagnosis, implementation, tests, and draft PRs |
| **You and your providers** | OAuth consent, plan approval, unattended enablement, merge, deploy, and rollback |

Applications send analytics and exceptions directly through official PostHog
SDKs. Source maps go directly through the official PostHog CLI. Agentry does not
host PostHog, proxy runtime events, issue application telemetry keys, retain the
raw event stream, or run a hidden hosted LLM.

The current product is intentionally PostHog Cloud-specific. It does not claim
self-hosted PostHog or provider-neutral analytics support.

## Ask the questions that start in production

Your coding agent already understands the repository. Agentry gives it bounded
production evidence and the authority model needed to connect behavior back to
code:

| Question | What the agent can inspect |
| --- | --- |
| **What broke?** | PostHog Error Tracking evidence, affected users, source locations, and recent deploys |
| **What did users do?** | Approved events/properties for funnels, adoption, conversion, and retention |
| **What changed?** | Trusted deploy evidence tied to the source revision preceding the result |
| **What is configured?** | Bounded recording metadata, flag definitions, surveys/responses, and experiment definitions |
| **What is missing?** | The exact event, property, identity join, failure boundary, deploy proof, or traffic needed next |
| **What should improve?** | A bounded opportunity with its evidence window, limitations, and reviewable next action |

Agentry does not invent an answer from a plausible event name. It distinguishes
existing historical evidence, verified current source ownership, and data that
still needs to arrive.

## Onboard from CLI or chat

Run from the application repository:

```sh
npx -y @agentrysh/cli onboard
```

Or ask a coding agent to run the same state machine:

```text
Read https://raw.githubusercontent.com/agentry-sh/agentry/main/INSTALL.md completely,
then run `npx -y @agentrysh/cli onboard --json` in this repository. Complete
safe agent tasks, show me every human checkpoint, and do not edit source until
I approve the exact plan hash. Keep credentials and onboarding artifacts outside
the repository. Stop for OAuth consent, provider actions outside this task, and
unattended automation enablement.
```

Machine-readable onboarding emits four checkpoint kinds:

- `agent_task`
- `human_checkpoint`
- `external_action`
- `complete`

The CLI discovers or asks for the PostHog Cloud region, starts an ephemeral
`127.0.0.1` callback, and opens PostHog. One consent is both identity and
read-only project authorization, and the browser returns to the same CLI
automatically—there is no Agentry signup, copied code, or second consent step.
The CLI then handles the one-time project claim, local discovery, plan
hashes, resumption, source snapshots, and machine-readable results. Chat
provides the conversation and source reasoning. Product logic stays in the same
CLI/API contract instead of being duplicated in every agent integration.

Read the full [onboarding contract](./INSTALL.md) and
[credential boundaries](./docs/credential-boundaries.md).

## Immediate value from existing PostHog data

Connecting an existing project avoids the usual blank-dashboard wait. Agentry
can immediately inspect a bounded historical window for errors, funnels,
taxonomy, recording metadata, flags, surveys, experiments, joins, sparse
signals, and suspicious telemetry placement.

Provider-resource reads establish what currently exists in PostHog. Claims that
the application applied a flag, rendered a survey, exposed an experiment, or
recorded a session with valid consent still require source-backed evidence.

It reports two different evidence levels:

- `historically_observed` — matching PostHog evidence exists in the audited window.
- `source_verified` — approved current source owns the signal at the claimed
  business boundary, and changed instrumentation was observed from the known
  deployed revision.

Historical rows are useful immediately, but they cannot prove that current
source emits an event after the right durable outcome. Conversely, a correct
patch is not production evidence until it is deployed and observed.

## Source-backed onboarding

Agentry does more than connect OAuth. The coding agent traces the primary
business-value flow from source: actor, eligible entry, durable milestones,
business result, stable joins, important failure exits, and real deploy
boundary. It compares that map with the existing PostHog taxonomy and history.

```text
PostHog OAuth and historical audit
  -> source-backed signal map
  -> exact plan and human-approved hash
  -> direct official PostHog instrumentation changes, if needed
  -> trusted deploy plus real-path observations
  -> source_verified receipt
```

Correct telemetry is preserved. Missing or misplaced telemetry is proposed at
the exact owning source boundary. Nothing changes before the human approves the
complete plan hash.

## Two continuous loops

### Keep the application error-free

Agentry freezes bounded PostHog Error Tracking evidence, connects it with source
and recent deploys, and gives the customer's coding agent one scoped repair
task. The result is a bounded draft PR or an escalation that names the missing
proof.

### Improve the product

On a reviewed schedule, Agentry compares an approved funnel or outcome with an
exact preceding period. It can propose an analysis, telemetry repair,
experiment, or product change, with sample limitations and the frozen evidence
behind the recommendation.

The CLI detects the available agent harness, scheduler, and secret store. It
proposes one concrete installation instead of asking users to choose a generic
runner type. Detection never grants authority: unattended execution requires
its own explicit approval and one automation-bound runner credential.

Draft PR is the maximum autonomous effect. Agentry does not authorize merge,
deploy, rollback, direct push, silent workflow changes, or PostHog mutation.

## Open CLI, paid nerve

The CLI and interactive audit are open source. The hosted control plane provides
the continuous connection, durable evidence, schedules, leases, budgets,
approvals, deploy context, kill switches, and receipts.

Billing is per Agentry account, not per project, event, or inference
token. PostHog handles customer telemetry storage and the customer's chosen
runner handles inference. See [pricing](./PRICING.md) for the authoritative
current plan and checkout terms.

## Agent-native discovery

The CLI works from any coding-agent shell. Agentry also ships an MCP discovery
package and Codex/Claude Code plugins that point agents to the canonical CLI,
guides, and live OpenAPI:

```sh
npx -y @agentrysh/mcp
```

```sh
# Codex
codex plugin marketplace add agentry-sh/agentry
codex plugin add agentry@agentry

# Claude Code
claude plugin marketplace add agentry-sh/agentry
claude plugin install agentry@agentry
```

These adapters do not receive telemetry or OAuth tokens and do not contain a
second onboarding implementation.

## Workflows

The repository contains reviewable workflow examples for debugging, analytics,
and operations. They are starting points to bind to a project's approved,
source-verified events and properties—not one-click claims.

| Collection | Examples |
| --- | --- |
| [Debugging](./workflows/debugging) | [Deploy regression](./workflows/debugging/deploy-regression.md), [high-impact errors](./workflows/debugging/high-impact-errors.md), [source-map coverage](./workflows/operations/sourcemap-coverage-audit.md) |
| [Growth and product analytics](./workflows/growth) | [Signup funnel](./workflows/growth/signup-funnel.md), [feature adoption](./workflows/growth/feature-launch-adoption.md), [trial conversion](./workflows/growth/trial-to-paid-conversion.md) |
| [Operations](./workflows/operations) | [Weekly funnel review](./workflows/operations/weekly-funnel-review.md), [release health](./workflows/operations/release-health-scorecard.md), [webhook reliability](./workflows/operations/webhook-delivery-reliability.md) |

[Browse the workflow index →](./workflows)

## Trust boundaries

- PostHog OAuth is read-only and stored encrypted by the hosted control plane.
- PostHog access and refresh tokens never reach the CLI, prompt, repository,
  application, CI, or runner; the CLI proves the one-time browser return with a
  local verifier and keeps only the pending authorization ID until its project
  claim completes.
- Agentry stores bounded/redacted evidence, not the raw PostHog stream, replay
  snapshots/video, or unbounded survey free text.
- Customer application and source-map credentials remain customer-owned and go
  directly to PostHog.
- The Agentry CI key records deploy/proof only; it is not a PostHog credential.
- Every unattended runner receives one automation-bound key and explicit human
  enablement.
- Telemetry and provider content are untrusted data, never instructions.
- Disconnect is detach/revoke only; Agentry never deletes customer PostHog data.

[Security policy](./SECURITY.md) ·
[Threat model](./docs/telemetry-agent-threat-model.md) ·
[Privacy](./PRIVACY.md) ·
[Terms](./TERMS.md)

## Repository map

| Path | Purpose |
| --- | --- |
| [`apps/api`](./apps/api) | PostHog sign-in and OAuth-backed reads, onboarding, deploy evidence, billing, and automation control plane |
| [`apps/redirect`](./apps/redirect) | Apex and `www` redirects |
| `packages/cli` | Interactive and JSON CLI onboarding actuator |
| [`packages/db`](./packages/db) | Connection, evidence, plan, deploy, and automation persistence |
| [`packages/mcp`](./packages/mcp) | Read-only discovery package for coding agents |
| [`packages/shared`](./packages/shared) | Shared contracts, errors, fingerprints, and key parsing |
| [`plugins/agentry`](./plugins/agentry) | Codex and Claude Code discovery adapters |
| [`workflows`](./workflows) | Debugging, analytics, and operations examples |
| [`docs`](./docs) | Architecture, onboarding, security, and credential boundaries |

## Development

Requirements: Node.js 22.12 or newer and npm.

```sh
git clone https://github.com/agentry-sh/agentry.git
cd agentry
npm ci
npm run lint
npm run typecheck
npm test
```

Start with [PLAN.md](./PLAN.md), [AGENTS.md](./AGENTS.md), and the
[agent product guide](./docs/agent-product-guide.md). Read
[CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request.

## License

Agentry is licensed under [Apache License 2.0](./LICENSE). The Agentry name and
logos are covered separately by the [trademark policy](./TRADEMARKS.md).
Third-party notices are listed in [LICENSES.md](./LICENSES.md).
