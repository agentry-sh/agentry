# Onboarding

**Status:** canonical CLI/chat onboarding contract

Public agents start with [`agentry onboard`](../INSTALL.md). Exact HTTP and
checkpoint schemas come from the live filtered OpenAPI document. This guide
defines the product boundary those schemas must preserve.

## Goal

Connect an existing customer-owned PostHog Cloud project, compare its history
and taxonomy with the shipped source, approve one exact signal plan, and prove
the current source boundaries. Agentry does not provision PostHog, issue an
application telemetry key, or wait for events to arrive through an Agentry
ingest service.

Historical data should make the first review useful immediately. Installation
is complete only when the selected signal map is `source_verified`; a matching
historical row by itself is only `historically_observed`.

## One state machine, two interfaces

`agentry onboard` is interactive for a human. `agentry onboard --json` is the
same state machine for chat and coding agents. A JSON checkpoint has exactly one
of these kinds:

- `agent_task` — safe repository inspection or an approved source edit;
- `human_checkpoint` — PostHog OAuth consent, exact plan approval, or explicit
  unattended-automation enablement;
- `external_action` — deployment, real-traffic exercise, or another provider
  action outside current authority;
- `complete` — the requested onboarding phase reached its terminal state.

The CLI owns browser handoffs, local discovery, resumable state, plan hashes,
ETags, and secure credential storage. Chat performs agent tasks and explains
genuine checkpoints; it does not duplicate or fork the onboarding logic.

Interactive sign-in is one click: the CLI starts an ephemeral exact
`127.0.0.1` callback, opens PostHog, and receives the hosted callback's one-time
ticket automatically. This loopback belongs to the computer running the CLI,
including a third-party computer; it is not a hosted Agentry callback. JSON mode
never opens the browser and instead asks the human to run `agentry login` once
in an interactive terminal.

## Connection boundary

The browser consent flow authorizes the minimum read-only PostHog OAuth scopes
needed for project identity, taxonomy, bounded analytics queries, Error
Tracking, session-recording metadata, feature flags, surveys and responses, and
experiments. The hosted control plane stores the access and refresh tokens encrypted.
It never returns that token to the CLI, coding agent, repository, application,
CI, or customer runner.

Connection state is exactly `active`, `reauth_required`, or `detached`.
Disconnect revokes or detaches the connection and never mutates or deletes the
customer's PostHog project. Agentry v1 supports PostHog Cloud only.

## What the agent discovers

Before choosing event names or editing source, inspect:

- product docs, UI, routes, actions, jobs, webhooks, and persistence;
- the actor and eligible entry into the selected value flow;
- material durable milestones and the business result;
- impactful failures that block, corrupt, or strand that value;
- the real CI/provider boundary whose success means a release is deployed;
- the existing official PostHog SDK and CLI setup;
- the connected project's taxonomy, bounded historical evidence, recording
  metadata, feature flags, surveys, and experiments.

Compare source ownership with PostHog history rather than treating either as
sufficient alone. Preserve correct existing telemetry. Identify missing,
misplaced, unjoinable, or privacy-unsafe signals precisely.

## Plan and approval

The proposed plan names:

- one business question and its complete selected value flow;
- the reviewed source snapshot and exact source owners;
- preserved, added, moved, or removed analytics and exception signals;
- preserved or externally managed recording, flag, survey, and experiment
  configuration plus its exact source integration boundary;
- required properties, stable joins, privacy treatment, and useful segments;
- the deployment and real-traffic evidence needed for source verification;
- any official PostHog source-map CLI work required by client errors;
- one detected runner/scheduler installation proposal, if requested.

The human approves the exact plan hash before edits. Approval authorizes only
that reviewed telemetry diff. Detection of Codex, Claude Code, GitHub Actions,
or another scheduler reduces questions but never authorizes installation,
credential creation, or unattended execution.

## Applying telemetry changes

Applications keep sending analytics and exceptions directly to their own
PostHog Cloud project through the official SDK already used by the codebase.
Client source maps go directly through the official PostHog CLI with
customer-owned PostHog credentials. Agentry is not in either delivery path.

Emit a product milestone only after the source-proven outcome succeeds. Capture
an exception at its owning failure boundary while useful context is still
available. Keep the stable identity and join properties required by the
approved business question, and do not collect secrets or unnecessary personal
data.

`agentry onboard` should review and patch the repository-specific SDK usage. A
workflow page must not invent a provider-neutral capture helper or tell an
application to post runtime telemetry to Agentry.

Agentry's typed PostHog resource endpoints are reads only. Any provider
configuration change remains an explicit human action in PostHog. A resource
definition proves provider state, not that current source applied a flag,
rendered a survey, exposed an experiment, or recorded a session under the
claimed consent boundary.

## Evidence and proof

Each signal carries an honest evidence level:

| Evidence | Claim |
| --- | --- |
| `historically_observed` | Bounded PostHog history or resource reads contain the named event, property, exception, recording metadata, flag, survey, or experiment evidence. |
| `source_verified` | Approved current source owns the exact signal boundary, required properties are present, committed/deployed identity is known, and changed telemetry has been observed through the real shipped path. |

Historical rows never prove current source placement. A source patch never
proves production behavior before deployment and observation. Missing telemetry
therefore requires an approved source change, a real deployment, and real or
safe reviewed traffic before completion.

Agentry stores only bounded/redacted evidence snapshots and reproducible query
receipts, not a raw event stream or a shadow analytics warehouse. Deploy proof
uses `AGENTRY_CI_API_KEY` only at the trusted post-deploy/provider boundary;
PostHog application and source-map credentials remain outside Agentry.

## Automation handoff

After source verification, the CLI may detect a usable agent harness,
scheduler, and secret store and show one exact installation. The human must
explicitly approve it before Agentry creates an automation-bound
`AGENTRY_RUNNER_API_KEY` or enables unattended execution.

Each enabled scheduler gets one runner credential bound to one automation. It
never receives the owner credential or the PostHog OAuth token. Draft PR is the
maximum autonomous effect; merge, direct push, deploy, rollback, silent
workflow changes, and PostHog writes remain outside authority.

## Completion handoff

Report the connected PostHog project identity, connection state, approved plan
hash, evidence status per signal, source and deploy identities, tests run, and
the exact remaining checkpoint. Never report completion while any required
signal is only historically observed or still waiting for deployment or real
traffic.
