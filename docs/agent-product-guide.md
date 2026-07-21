# Agentry Product Guide for Agents

Use this guide as the decision compass when working on Agentry. Agentry is the
agent-first control plane between a customer-owned PostHog Cloud project and the
customer's coding agent.

## What Agentry Is

PostHog already collects and stores product analytics and errors. Coding agents
already understand and change repositories. Agentry supplies the missing closed
loop: source-backed signal plans, approvals, bounded production evidence,
trusted deploy correlation, durable automation state, and verification.

Agentry has two interfaces over one contract:

- The open-source CLI performs secure local onboarding and source work.
- Chat lets a human direct the same CLI/state machine conversationally.

Both begin with the same single PostHog browser handoff. PostHog sign-in and
read-only project consent replace a separate Agentry account flow; the CLI
receives only an Agentry owner key and one-time authorization ID,
never the PostHog access or refresh token.

The hosted control plane keeps encrypted read-only OAuth authorization,
redacted evidence, plans, approvals, deploys, schedules, leases, budgets, and
receipts. It does not run a hidden LLM. The customer's coding agent performs
reasoning and repository work.

## Product Goal

Help a coding agent keep an application error-free and improve it using real
production behavior:

1. Detect and repair material errors.
2. Find conversion, adoption, retention, or instrumentation opportunities.
3. Correlate both with the source and deploy that produced the observation.
4. Propose a reviewable change and measure the outcome after deployment.

Connecting an existing PostHog project should create value immediately from
historical signals. Where data is insufficient, Agentry should identify the
exact missing or misplaced event/property and its source boundary.

## Human and Agent Roles

Humans provide product intent and authorize meaningful effects. They consent to
PostHog OAuth, approve the exact source-backed plan hash, authorize provider
actions outside the current task, and explicitly enable unattended automation.

Agents inspect source and existing telemetry, explain gaps, implement approved
instrumentation, query bounded evidence, diagnose errors, propose improvements,
and produce draft PRs.

Do not ask humans questions the environment can answer. Detect the available
agent harness, scheduler, and secret store. Present the detected evidence and
one exact proposal. Detection never authorizes credential creation, scheduler
installation, or unattended execution.

## Data-Plane Boundary

PostHog Cloud is the customer-owned source of truth for raw analytics,
exceptions, people, issue grouping/lifecycle, affected-user impact,
symbolication, recordings, retention, feature flags, surveys, and experiments.
Application telemetry and source maps go directly to PostHog through official
SDK and CLI paths.

Agentry must not:

- provision or host a PostHog instance or project;
- issue application analytics/error credentials;
- proxy, durably queue, or mirror application events;
- retain raw events, replay snapshots, or replay video;
- rebuild grouping, symbolication, or analytics storage;
- delete or mutate the customer's PostHog project on disconnect.

The PostHog OAuth connection is read-only and Cloud-only. Agentry stores the
access and refresh tokens encrypted, exposes only connection state, and
performs bounded analytics, Error Tracking, recording-metadata, feature-flag,
survey, and experiment reads. Recording responses contain metadata and a
PostHog player link, never replay snapshots or video. The tokens never enter
prompts, repositories, application code, CI, or runners.

Consent must bind exactly one PostHog team. Resolve it from PostHog's token
scope binding; do not enumerate candidate projects or read a project detail
response that includes the ingestion `api_token`. Persist only the selected
team ID, an optional organization claim, granted scopes, and bounded capability
evidence.

When no owner key exists, discover or ask for the Cloud region before creating
the authorization. The interactive CLI binds one exact ephemeral `127.0.0.1`
callback and local verifier, opens PostHog, and completes automatically when the
hosted callback returns its one-time ticket to that listener. Then create or
select the Agentry project, claim the one-time authorization into that project,
and delete the local authorization ID. Do not introduce a second identity
provider, account screen, copied code, or consent step. Existing authenticated
projects may use a project-scoped PostHog reauthorization when their connection
is no longer usable.

## First-Class PostHog Resources

Agents can directly list and inspect four provider-owned read surfaces through
the project-scoped Agentry API:

- `session-recordings` returns bounded metadata and a PostHog player link, never
  replay snapshots or video;
- `feature-flags` returns flag definitions and rollout metadata;
- `surveys` returns definitions plus bounded response summaries and statistics;
- `experiments` returns experiment definitions and status.

List and ID-specific operations are defined by filtered OpenAPI. They are
read-only owner/member operations. Agentry exposes no create, activate, pause,
update, evaluation, or delete operation for these PostHog resources and keeps no
legacy `session-replays` or `ab-tests` aliases.

A provider definition establishes provider state, not source semantics. Before
claiming runtime behavior, verify the current source boundary that applies a
flag, renders a survey, emits experiment exposure and outcome signals, or
enables a recording under the claimed consent and redaction policy.

## Evidence and Privacy

Agentry persists only what its control plane needs: connection metadata,
bounded/redacted evidence snapshots and query receipts, a thin issue-control
projection, source-backed plans, approvals, deploy evidence, automation state,
and immutable receipts.

Every persisted evidence record should be reproducible from its connection,
query shape, time window, redaction policy, and source/deploy identity. Prefer
aggregates and minimal samples. Do not use the query API as an export path.
Secrets, raw content, unnecessary personal data, full URL queries/fragments,
headers, cookies, replay snapshots/video, and unbounded survey free text are
outside the evidence boundary.

## Historical Observation vs Source Verification

These statuses answer different questions:

- `historically_observed`: does PostHog contain matching evidence?
- `source_verified`: does the approved current source emit the signal at the
  exact claimed outcome, with the required properties, from a known deployed
  revision?

Historical evidence provides an immediate audit but cannot prove current source
placement. A source patch proves intent but cannot prove production behavior
until deployed and observed. Automation may reason about historical evidence,
but any effect that depends on signal semantics must use source-verified signal
ownership or explicitly stop on the gap.

## Error and Case Goal

Use PostHog Error Tracking for raw exception evidence, grouping, lifecycle,
impact, and symbolication. Agentry's thin projection exists only for agent
coordination: bounded observations, deploy links, claims, annotations,
approvals, automation revisions, and receipts.

The repair loop should identify a material issue, freeze the evidence used for
diagnosis, correlate it with current source and recent deploys, and either open
a bounded draft PR or escalate with the missing proof. It must not silently
resolve/suppress the PostHog issue or claim a fix from a passing local test.

## Analytics Goal

Start from the business question and work backward through the complete
source-proven value flow: actor, eligible entry, durable milestones, business
result, failure exits, stable joins, and useful segmentation properties.

Compare that map with existing PostHog taxonomy and history before proposing
telemetry changes. Preserve correct signals. Fix events emitted before the
claimed outcome, missing alternate success owners, unjoinable denominators,
unbounded properties, and materially important blind spots.

An analytics answer must distinguish missing instrumentation, insufficient
traffic, and a measured outcome. An improvement proposal should freeze its time
window and comparison, state sample limitations, and remain a proposal until a
human authorizes a product-behavior change.

## CLI and Chat Contract

`agentry onboard` is the human interface. `agentry onboard --json` is the
agent/chat interface. JSON checkpoint kinds are exactly:

- `agent_task`
- `human_checkpoint`
- `external_action`
- `complete`

Completed onboarding has `status: "completed"` and a `complete` checkpoint only
after its evidence status is `source_verified`. Completed utility commands that
do not participate in onboarding may omit a checkpoint.

The CLI owns local discovery, the single PostHog sign-in/consent handoff, plan hashes, ETags,
resumption, source snapshots, and machine-readable results. Chat explains the
checkpoint, performs safe agent tasks, and surfaces only real approvals or
external actions. Product logic must not fork between CLI, chat skills, MCP,
or HTTP adapters.

## Automation Without Composed Authority

Automation may compose typed triggers, queries, conditions, agent tasks,
approvals, effects, waits, verification, and terminal escalation. It must never
compose new authority.

Each unattended runner receives one automation-bound runner credential. The
runner never receives the owner credential or PostHog OAuth token. Evidence and
runner-generated text have no instruction authority. All effects fail closed on
expired approvals, revision changes, budget limits, kill switches, or missing
verification.

Draft PR is the maximum autonomous effect. Merge, deploy, rollback, direct push,
workflow edits, and PostHog mutations remain human/provider actions.

## Architecture Principles

### Agents First

Make every workflow discoverable, resumable, and explicit about the next action.
Errors include a stable code, retryability, and a concrete recovery step.

### Keep the Boundary Small

Use PostHog for what PostHog already does. Keep Agentry focused on source
semantics, evidence, deploys, authority, and the loop. Remove duplicate storage,
provisioning, ingest, dashboards, and provider abstractions that do not help the
agent complete the outcome.

### Plan Before Code

The human approves one exact source-backed plan hash before edits. The approved
plan names preserved signals, proposed changes, privacy effects, deploy work,
and the evidence required for source verification.

### Make Claims Honest

An observed row is not proof of source ownership. A committed patch is not a
deployed result. A draft PR is not a fix. Every conclusion says which evidence
level it reached and what is still missing.

## Non-Goals

- Hosting or self-hosting PostHog.
- Supporting self-hosted PostHog or other analytics providers in v1.
- Runtime SDK or event proxy architecture.
- A raw telemetry warehouse or full dashboard suite.
- Hidden server-side inference.
- Autonomous merge, deployment, rollback, or PostHog mutation.
- Asking users to choose infrastructure that can be reliably detected.

## Definition of Done

A feature is done when an agent can discover it, execute it through the
canonical CLI/HTTP contract, recover from common failures, verify the resulting
evidence and authority boundary, and explain the outcome or exact next action.
