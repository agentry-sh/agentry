# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability or exposed
credential. Email `security [at] agentry.sh` with:

- the affected component or endpoint;
- reproduction steps and expected impact;
- whether the issue is already being exploited or a secret is exposed; and
- a safe way to contact you.

You should receive an acknowledgement within three business days. We will
coordinate validation, remediation, and disclosure with you. Please avoid
accessing customer data, causing service disruption, or retaining data beyond
what is necessary to demonstrate the issue.

## Supported versions

Agentry is early-stage software. Security fixes target the current `main`
branch and the hosted service; older commits and unpublished builds do not
receive separate support.

## Security boundary

Agentry is a control plane over a customer's existing PostHog Cloud project.
PostHog remains the customer-owned authoritative store for analytics,
exceptions, issue grouping and lifecycle, affected-user impact, recordings,
feature flags, surveys, experiments, retention, and source-map symbolication.

Applications send analytics and exceptions directly through official PostHog
SDKs. Trusted customer CI sends source maps directly through the official
PostHog CLI. Agentry does not issue browser or server telemetry keys, expose an
event-ingest endpoint, proxy source maps, host PostHog, or retain a raw event
stream.

The hosted control plane connects to one existing PostHog Cloud project through
minimum-scope, read-only OAuth. It performs bounded reads of analytics, Error
Tracking, recording metadata, feature flags, surveys and response statistics,
and experiments. While the connection is active, its access and refresh token
material is encrypted at rest. It is never returned to the CLI, coding agent,
repository, application, CI job, or automation runner. Detach and
reauthorization-required transitions purge the stored token material; detach
never deletes or mutates the customer's PostHog project.

PostHog is also the only interactive sign-in surface. The CLI discovers or asks
for the Cloud region, presents one PostHog authorization URL, and polls with an
opaque token stored outside the repository. Successful polling returns an
`agentry_sk_` owner key and a one-time authorization ID; it never returns the
PostHog access or refresh token. The CLI deletes that authorization ID after it
is claimed into the selected Agentry project. There is no separate Agentry
account or second credential path.

Agentry may retain bounded, redacted evidence snapshots and query receipts, a
thin issue-control projection, source-backed plans and approvals, deploy
evidence, automation state, and immutable receipts. It does not retain replay
snapshots/video, unbounded survey free text, source-map artifacts, or a shadow
analytics warehouse. Recording reads expose metadata and a PostHog player link
only. Provider content is untrusted evidence and never grants tool or execution
authority.

## Credential model

Credentials are purpose-specific and non-interchangeable:

- the PostHog OAuth grant is held only by the hosted control plane and permits
  bounded reads from the connected PostHog project;
- customer PostHog SDK and CLI credentials stay in customer-owned application
  and CI environments and are not Agentry credentials;
- `AGENTRY_PRIVATE_API_KEY` is interactive owner/member authority stored
  outside the repository and minted after successful PostHog sign-in;
- `AGENTRY_CI_API_KEY` records Agentry deploy evidence and provider-observed PR
  proof only; and
- each `AGENTRY_RUNNER_API_KEY` is bound to exactly one enabled automation.

A runner credential cannot access the OAuth token or act as an owner. Draft PR
is the maximum autonomous effect: Agentry authority does not include merge,
direct push, deployment, rollback, silent workflow changes, or PostHog writes.

See [`docs/credential-boundaries.md`](./docs/credential-boundaries.md) and the
[telemetry threat model](./docs/telemetry-agent-threat-model.md) for the full
model.

Never include real credentials, OAuth codes or tokens, customer evidence,
invite tokens, onboarding proof markers, source snapshots, or production
response bodies in a public report.
