## Agentry (observability)

Agentry is the agent-first control plane over a customer's existing PostHog
Cloud project. PostHog is the customer-owned authoritative data plane for
analytics, exceptions, issue grouping/lifecycle, affected-user impact, session
recordings, feature flags, surveys, experiments, and source-map symbolication.
Agentry adds source-backed telemetry review,
historical evidence, trusted deploy attribution, approvals, durable automation
state, and bounded draft-PR workflows.

Agentry does not host PostHog, proxy application telemetry, or retain a raw
event stream. Applications send telemetry directly through official PostHog
SDKs and release tooling. Agentry connects through read-only PostHog OAuth.

## Read before every repo session

1. This file - the current operating contract and mental model.
2. [PLAN.md](./PLAN.md) - what is being built and why.
3. [docs/agent-product-guide.md](./docs/agent-product-guide.md) - the product
   and architecture decision compass.

Canonical docs and live contracts:

- [INSTALL.md](./INSTALL.md) - CLI/chat onboarding, review, proof, and runner gates.
- [AGENTRY.md](./AGENTRY.md) - daily questions, cases, analytics, deploys,
  PostHog resource reads, and automation.
- https://api.agentry.sh/ - live discovery.
- https://api.agentry.sh/v1/docs/automation - automation workflow guide.
- https://api.agentry.sh/v1/openapi.json - exact request/response shapes; filter
  with `?flow=`, `?tag=`, `?path=&method=`, or `?index=true`.
- https://api.agentry.sh/adapters - agent adapter discovery.

Use a custom User-Agent header for non-browser direct HTTP calls. Browser fetch
uses the browser's own User-Agent and cannot set this header manually.

Auth: the CLI stores the Agentry owner credential outside the repository in
`~/.agentry/credentials.json`. With no credential it discovers or asks for the
PostHog Cloud region and presents one PostHog authorization URL. That is both
sign-in and read-only project consent; there is no separate Agentry account or
second OAuth step. The CLI stores the opaque poll
token and one-time authorization ID outside the repository, deletes the ID
after project claim, and never receives the PostHog access or refresh token.
The hosted control plane stores those tokens encrypted and never exposes them
to the CLI, coding agent, application, repository, CI, or runner.

Compatibility policy: there are no real customers or irreplaceable hosted
telemetry to migrate. Make the hard cut. Do not preserve legacy runtime-ingest
credentials, hosted-PostHog provisioning, ingest endpoints, proxy source-map
flows, stale aliases, duplicate response fields, or runtime fallbacks. Update
docs, adapters, tests, and OpenAPI to the one canonical shape.

Mental model:

- PostHog Cloud is customer-owned and PostHog-specific. Agentry v1 does not
  support self-hosted PostHog or a provider-neutral telemetry abstraction.
- Application analytics and exceptions go directly to PostHog through the
  project's existing official SDKs. Source maps go directly through the
  official PostHog CLI. Agentry issues no browser or server telemetry key.
- The PostHog OAuth connection is read-only. It provides bounded first-class
  reads for analytics, Error Tracking, session-recording metadata, feature
  flags, surveys and responses, and experiments. Its connection state is
  exactly `active`, `reauth_required`, or `detached`. Disconnect revokes or
  detaches the connection; it never deletes or mutates the customer's PostHog
  project.
- OAuth consent must bind exactly one provider-scoped PostHog team. Resolve it
  from the token scope binding; do not enumerate candidate projects, request
  project detail, read an ingestion `api_token`, or store a project-token hash.
- Agentry may store only encrypted OAuth access and refresh tokens, connection metadata,
  bounded/redacted evidence snapshots, a thin issue-control projection,
  source-backed plans and approvals, deploy evidence, automation state, and
  immutable receipts. It does not store raw events, replay snapshots or video,
  or a shadow analytics warehouse. Recording reads expose bounded metadata and
  a PostHog player link only.
- Historical PostHog rows can establish `historically_observed` immediately.
  That is evidence of existing signal, not proof that current source emits it
  at the claimed business boundary. Onboarding completes only at
  `source_verified`.
- Install discovery deeply scans shipped source and maps the complete selected
  value flow: actor, entry, material durable milestones, business result,
  impactful blocking/corrupting failures, and real deploy boundary. It compares
  that source map with existing PostHog taxonomy and history before proposing
  additions or moves. Preserve correct existing telemetry.
- The human approves the exact source-backed plan hash before edits. Telemetry
  changes use the customer's existing PostHog setup and must emit only after the
  source-proven outcome succeeds. Missing telemetry still requires deployment
  and real traffic before it can become source-verified.
- CLI and chat are two interfaces over one state machine. `agentry onboard`
  provides interactive prompts; `agentry onboard --json` emits checkpoints of
  exactly `agent_task`, `human_checkpoint`, `external_action`, or `complete`.
  Chat performs agent tasks and presents only genuine human checkpoints.
- Agent harness, scheduler, and secret-store capability are detected from the
  environment. Do not ask the user to choose a runner when one can be proved.
  Detection is not authorization: show the exact installation and require
  explicit approval before creating a runner credential or enabling unattended
  execution.
- Each enabled customer scheduler gets one `AGENTRY_RUNNER_API_KEY`
  (`agentry_runner_`) bound to one automation. Never give a runner the owner
  credential or the PostHog OAuth token.
- CI/provider post-deploy automation uses `AGENTRY_CI_API_KEY` (`agentry_ci_`)
  only for Agentry deploy evidence and provider-observed PR proof. PostHog
  source-map credentials remain customer-owned and go directly to PostHog.
- Draft PR is the maximum autonomous effect. Agentry authority never includes
  merge, direct push, deploy, rollback, or silent workflow modification.
- Direct provider-state questions use the matching bounded PostHog resource
  read. Claims about runtime flag application, survey rendering, experiment
  exposure or outcomes, recording consent, or product behavior begin with the
  approved source map and its evidence status. If the required source, event,
  property, consent, or traffic is not proven, name the exact gap.

Source of truth: repository Markdown is canonical for authored guidance. The
live OpenAPI document is authoritative for endpoint paths and request/response
shapes. When prose and the machine contract differ, use OpenAPI for the exact
call and fix the repository guide in the same change.
