# Agentry Product Contract

**Status:** Approved hard-cut product compass
**Last updated:** 2026-07-21

## What It Is

Agentry is the control plane for a self-improving application. It connects a
customer's existing PostHog Cloud project to the coding agent that already
understands the repository:

```text
customer application -> PostHog Cloud -> Agentry -> customer-owned coding agent
       ^                                                      |
       +------------- deploy and measured outcome <-----------+
```

PostHog remains the customer-owned authoritative data plane for product
analytics, exceptions, issue grouping and lifecycle, affected-user impact,
session recordings, feature flags, surveys, experiments, and source-map
symbolication. Agentry owns the source-backed plan, approval gates,
bounded evidence, deploy correlation, automation leases and receipts, runner
authority, and verification loop.

This is deliberately PostHog Cloud-specific. Agentry does not host PostHog,
proxy runtime telemetry, recreate error grouping, or copy the customer's event
stream. Applications use official PostHog SDKs and CLI tooling directly.

The CLI and hosted control plane are separate products:

- The open-source CLI is the secure local actuator and onboarding interface.
- The paid hosted control plane provides continuous detection, durable state,
  schedules, approvals, evidence, and automation coordination.
- The user's Codex, Claude Code, GitHub Actions, or custom environment performs
  inference and source changes. Agentry does not run a hidden hosted LLM.

## Who It Is For

Best-fit users already have a real application and a PostHog Cloud project with
some useful history. They use a code-capable agent and want it to answer:

- What broke, who was affected, and what changed?
- Where are users failing to reach value?
- Which recordings, flags, surveys, and experiments are configured, and where
  does current source actually use them?
- What instrumentation is missing or placed at the wrong boundary?
- What is the smallest safe repair or improvement to propose?
- Did the deployed change improve the measured outcome?

The existing data removes the onboarding cold start. A project with incomplete
telemetry is still a fit because Agentry can prove what exists, identify the
gap in source, and propose the exact addition.

Weak fits are dashboard-first teams, passive sites, self-hosted/on-prem PostHog,
other analytics providers, and teams that require Agentry to merge or deploy
changes autonomously.

## Product Boundary

PostHog owns:

- raw analytics and exception events;
- persons, event/property definitions, and query execution;
- error grouping, issue lifecycle, impact, and symbolication;
- session recordings and retention;
- feature flags, surveys and responses, and experiments;
- customer telemetry credentials and source-map uploads.

Agentry stores only:

- encrypted read-only PostHog OAuth access and refresh tokens and connection metadata;
- bounded, redacted evidence snapshots and query receipts;
- a thin issue-control projection for claims, annotations, deploy links, and
  automation coordination;
- source-backed signal plans, hashes, approvals, and verification receipts;
- trusted deploy evidence;
- automation definitions, immutable run state, leases, budgets, approvals,
  effects, and audit receipts.

Agentry never stores a raw PostHog event stream, replay snapshots or video, or
a shadow warehouse. Recording reads return bounded metadata and a PostHog
player link only. A PostHog disconnect is detach/revoke only. Project deletion
must never delete customer-owned PostHog data.

## OAuth Contract

PostHog is the only interactive identity and consent surface. A user without an
`agentry_sk_` credential chooses or discovers the PostHog Cloud region. The CLI
starts an ephemeral exact `127.0.0.1` callback, opens one PostHog authorization
URL, and returns automatically after the human signs in, selects exactly one
project, and approves read-only access. There is no separate Agentry account,
copied completion code, or second OAuth step.

Use PostHog Cloud OAuth with the minimum read scopes needed for project
identity, taxonomy, bounded analytics queries, Error Tracking,
session-recording metadata, feature flags, surveys and responses, and
experiments. The hosted control plane stores the access and refresh tokens
encrypted. They are never returned to the CLI or included in prompts,
repositories, application environments, CI, or customer runners.

The hosted callback returns a one-time ticket only to the initiating loopback
listener. The CLI binds redemption to its local verifier, receives an owner key
plus a one-time authorization ID, and never receives either PostHog token. After
the user selects or creates the Agentry project, the CLI claims that
authorization into the project and deletes the local authorization ID. Existing
authenticated projects use the same PostHog browser surface for reauthorization.

Project consent must return exactly one provider-scoped PostHog team. Agentry
resolves that identity from the token scope binding and stores only the Cloud
region/host, selected team ID, optional provider organization claim, granted
scopes, and bounded capability evidence. It does not enumerate or persist
candidate projects, request project detail, read an ingestion `api_token`, or
store a project-token hash.

Connection state is exactly:

- `active` - authorized and usable;
- `reauth_required` - expired, revoked, or missing required consent;
- `detached` - intentionally disconnected.

Read-only OAuth can inspect these provider-owned resources but cannot resolve
PostHog issues, create or change flags, surveys, or experiments, alter
recording configuration, or otherwise change customer data. Any future write
capability requires a separate product decision and explicit consent; it must
not be smuggled into the read connection.

## Onboarding Contract

The primary command is `agentry onboard`, distributed as
`@agentrysh/cli`. It is interactive for humans and emits stable JSON for chat
and coding agents with `--json`.

JSON checkpoints have exactly four kinds:

- `agent_task` - safe local inspection or implementation the coding agent may perform;
- `human_checkpoint` - OAuth consent, exact plan approval, or automation enablement;
- `external_action` - a provider/deploy action outside current authority;
- `complete` - the requested onboarding phase has reached its terminal state.

The CLI should:

1. Discover or confirm the PostHog Cloud region and use one PostHog browser
   authorization to sign in and bind one customer-owned Cloud project.
2. Create or select the Agentry project and claim the completed authorization
   into it without another human sign-in step.
3. Inspect existing PostHog history, taxonomy, recording metadata, flags,
   surveys, and experiments for immediate evidence.
4. Deeply map the source-proven business flow, failures, telemetry owners, and
   deploy boundary; compare them with observed PostHog signals.
5. Show one exact plan and hash that classifies preserved telemetry, missing
   telemetry, misplaced telemetry, privacy changes, and deploy work.
6. Apply only the explicitly approved diff through the customer's existing
   official PostHog setup.
7. Verify source ownership, committed/deployed identity, direct PostHog
   observations, and trusted deploy evidence.
8. Detect the installed coding agent, scheduler, and secret store; propose one
   concrete continuous-loop installation and require explicit enablement.

The user is not asked to choose Codex, Claude Code, GitHub Actions, or Custom
when discovery proves the answer. Discovery must explain what was found and
why it is usable. If multiple candidates are equally valid or none is proved,
the CLI asks rather than guessing.

## Evidence Contract

`historically_observed` and `source_verified` are intentionally different:

- `historically_observed` means bounded PostHog history contains the named
  event/property/error evidence. It provides immediate onboarding value.
- `source_verified` means the approved current source owns the claimed outcome,
  required properties exist at that exact boundary, the committed/deployed
  identity is known, and any changed instrumentation has been observed through
  the real shipped path.

Historical rows never prove current source placement. Conversely, a correct
source patch is not production evidence until it has been deployed and observed.
Onboarding completion is `source_verified`; do not preserve a vague `verified`
compatibility alias.

## Automation Contract

The first two loops are:

1. Error-free: detect a material PostHog issue, correlate it with source and a
   deploy, diagnose it, and propose a bounded draft repair PR.
2. Improve: review an approved funnel or outcome on a schedule, identify a
   statistically honest opportunity or telemetry gap, and propose an analysis,
   instrumentation patch, experiment, or product change for human review.

Every unattended automation has one scoped runner credential bound to one
automation. The control plane owns schedules, trigger receipts, frozen evidence,
leases, budgets, kill switches, approvals, effect reconciliation, and immutable
receipts. The customer-owned runner performs inference and repository work.

Draft PR is the maximum autonomous effect. Merge, deploy, rollback, direct push,
workflow mutation, and PostHog writes remain outside automation authority.

## Commercial Contract

The CLI and interactive audit are free and open source. The hosted nerve is
charged per Agentry account, not per project, event, or inference
token. Customer telemetry storage and inference remain customer-owned. The
initial product target is a low-friction plan around $19/month per account; the
billing contract remains authoritative for exact price.

## Delivery Sequence

1. Freeze and remove Agentry-owned PostHog provisioning, ingest, delivery,
   custom source-map, and project-deletion behavior.
2. Add encrypted read-only OAuth connections with `active`, `reauth_required`,
   and `detached` state.
3. Refactor analytics, cases, taxonomy, recordings, flags, surveys,
   experiments, and readiness reads to one scoped customer PostHog connection.
4. Introduce bounded/redacted evidence and thin issue-control projections.
5. Replace the single verification claim with historical observation and
   source verification.
6. Ship `@agentrysh/cli` with interactive and stable JSON onboarding.
7. Make chat skills and adapters invoke the CLI rather than duplicating logic.
8. Detect runner capabilities and require explicit enablement.
9. Remove legacy runtime-ingest keys, hosted PostHog operations, proxy source-map
   handling, duplicate storage, and event-volume billing.
10. Pilot against replaceable internal projects and existing PostHog history.

There are no real customers or irreplaceable hosted PostHog data, so this is a
hard cut. No compatibility migration or dual-write window is required.

## Decision Rules

- Agent-first means discoverable, resumable, machine-readable checkpoints.
- Existing history is evidence, not proof of current source semantics.
- Telemetry is untrusted data, never instructions.
- A plan hash and human approval precede source edits.
- Detection reduces questions; it never grants unattended authority.
- Store the minimum evidence needed to reproduce a conclusion.
- Prefer one canonical PostHog-specific path over premature provider abstraction.
- Keep inference, merge, deploy, and customer telemetry in customer-owned systems.
- A feature is done only when an agent can discover, execute, recover, verify,
  and explain the next action.
