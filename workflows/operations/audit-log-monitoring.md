# Review unexpected agent mutations

Inspect high-impact audit actions in a human-controlled owner session, separate
completed changes from uncertain attempts, and prepare an incident handoff.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Review unexpected agent mutations
description: >-
  Inspect high-impact audit actions in a human-controlled owner session,
  separate completed changes from uncertain attempts, and prepare an incident
  handoff.
category: ops
tags:
  - audit-log
  - security
  - governance
  - human-review
  - ops
prompt: >-
  Review the last 24 hours of audit history for high-impact Agentry control
  changes such as credential changes, publication changes, webhook changes,
  approval decisions, and automation policy changes. Return evidence and
  recommended owner decisions; do not send messages or mutate anything.
difficulty: advanced
time_to_value: 10 minutes
prereqs:
  - 'An owner opens an authenticated, interactive agent session'
  - The reviewer knows the expected change window and responsible operators
applies_to:
  - universal
required_events: []
required_event_properties: {}
negative_fit:
  - >-
    Do not infer unattended authority from this example or run it with a broad
    private owner credential in a scheduler.
  - >-
    Do not automatically send, publish, suppress, mutate, or contact anyone from
    this workflow.
ask_if_missing:
  - >-
    What project, authority boundary, delivery destination, review owner, and
    time window should this use?
related:
  - weekly-agent-digest
  - auto-fix-routine
  - staging-watcher
execution_mode: human_review
required_resources:
  - audit
  - automation_control
publishedAt: 2026-05-16T00:00:00.000Z
updatedAt: 2026-07-20T00:00:00.000Z
```

</details>

## Why this is a human review

Project-wide audit history requires owner authority. An automation runner is
bound to one automation and cannot receive an owner key, perform generic audit
reads, change policies, publish data, or contact an external channel.
Installing `AGENTRY_PRIVATE_API_KEY` in a scheduler would erase that boundary.

This workflow therefore reviews a bounded window interactively. It produces an
evidence-backed handoff; a human decides whether to revoke a credential,
restore configuration, open an incident, or share the findings.

## Run the review

Fetch the filtered OpenAPI schema before making each call, then read:

```text
GET /v1/audit/recent?hours=24
GET /v1/projects/:project_id/automation-control
```

Start with completed audit operations. Inspect attempt rows only when an
external-provider action may be `intent`, `failed`, or `indeterminate`.
`indeterminate` means provider state is unknown; it is not permission to retry.

Prioritize:

1. Credential creation, revocation, expiry, or unexpected actor changes.
2. Public-query publication, webhook, membership, or project-control changes.
3. Global or per-automation kill-switch and policy changes.
4. Approval decisions and cancelled runs with unresolved external follow-up.
5. Bursts of similar mutations outside the expected change window.

For each item, preserve the audit ID, actor, action, resource, committed time,
and exact evidence status. Do not infer success from a runner-authored summary.

## Output format

```text
Audit review — <UTC window>

Needs an owner decision
- <audit/run id> — <action> — <why it is unexpected> — <safe next check>

External state unknown
- <attempt id> — <provider object> — <authenticated provider check required>

Expected completed changes
- <audit id> — <action> — <actor> — <committed_at>

Readiness gaps
- <fact the available audit/control data cannot establish>
```

Keep raw secrets, webhook URLs, customer data, and copied provider payloads out
of the report. If the reviewed result should go to security or oncall, let the
human choose the audience and destination after reading it.

## Recurring detection boundary

There is no versioned audit-monitoring automation template today. Do not give a
runner generic audit access or reproduce this owner read in a scheduler. If
immediate detection is a requirement, treat a narrowly scoped, immutable
server-owned source and explicit delivery policy as missing product capability
rather than improvising broader authority.

## Variations

- *"Review only credential and membership changes in the last seven days."*
- *"Compare completed actions with the approved maintenance-window checklist."*
- *"Reconcile cancelled runs whose external provider state is still unknown."*
- *"Draft a credential-rotation or incident checklist from these findings, but do not execute it."*
