# Review this week's agent activity with a human

An owner-side weekly review of immutable audit history and automation control state,
with explicit limits on what can safely run unattended today.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Review this week's agent activity with a human
description: >-
  An owner-side weekly review of immutable audit history and automation control
  state, with explicit limits on what can safely run unattended today.
category: ops
tags:
  - audit-log
  - weekly-review
  - automation
  - governance
  - ops
prompt: >-
  Review the last seven days of immutable Agentry audit history and the current
  automation control state. Summarize material actions, failed or escalated
  runs, pending approvals, external follow-up, and anything that needs an owner
  decision.
difficulty: intermediate
time_to_value: 10 minutes
prereqs:
  - 'An owner or member opens an authenticated, interactive agent session'
  - >-
    The reviewer can distinguish completed audit operations from in-progress
    external-provider sagas
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
  - audit-log-monitoring
  - auto-fix-routine
  - weekly-changelog
execution_mode: human_review
required_resources:
  - audit
  - automation_control
publishedAt: 2026-05-16T00:00:00.000Z
updatedAt: 2026-07-10T00:00:00.000Z
featured: false
```

</details>

## Why this remains a human review

An unattended scheduler must never hold `AGENTRY_PRIVATE_API_KEY`. Owner keys
can read project-wide audit and policy data and are intentionally broader than a
single automation. Runner credentials are narrowly bound to one automation and
cannot perform generic audit reads.

That means an owner-key cron which reads all audit rows and posts them to a chat
webhook is not a supported safe automation pattern. Do this review in an
authenticated interactive session. If you need a scheduled report, use a
versioned automation workflow whose server-owned report source is explicitly
listed in its policy; do not widen a runner credential.

## Run the review

Fetch the exact schemas from the filtered OpenAPI document, then read:

```text
GET /v1/audit/recent?hours=168
GET /v1/projects/:project_id/automation-control
```

The default audit view contains completed operations. Include attempts only
when reconciling an external-provider mutation that may be `intent`, `failed`,
or `indeterminate`. Treat an indeterminate provider outcome as unknown and
inspect the authenticated provider before retrying.

The automation control response is a bounded, telemetry-free, eventually
consistent view. Use its single `as_of` clock, attention priorities, stable item
IDs, and source cursors. It deliberately has no durable acknowledgement ledger,
so record any reviewed item in your team's existing issue or handoff system if
it must survive the session.

## Suggested review order

1. Global and per-automation kill switches.
2. Failed, escalated, or overdue runs and released claims.
3. Pending approvals and approvals that are non-actionable because policy is
   paused.
4. Draft PRs missing trusted CI proof, deploy binding, traffic, or completed
   verification.
5. Cancelled runs whose `external_follow_up` says provider state is unknown.
6. Credential expiry, revocation, or missing automation bindings.
7. Completed audit operations grouped by action and actor.
8. External mutation attempts that require reconciliation.

Keep counts and IDs separate from interpretation. Human-authored descriptions
and runner-attested usage values are labelled as such; they are not proof that
an external action succeeded.

## Output format

```text
Weekly automation review — <period>

Owner decisions
- <approval or policy decision, exact id and deadline>

External follow-up
- <run id, provider object, why state is unknown>

Reliability
- <failed/escalated runs and recurring error codes>

Credentials and budgets
- <expiring/revoked bindings and rolling capacity>

Completed material actions
- <action, actor, resource id, committed time>

Readiness gaps
- <anything the available control/audit data cannot establish>
```

Do not invent week-over-week trends unless you queried exact non-overlapping
windows. Do not claim a merge, deploy, rollback, message delivery, or case fix
from a runner summary alone. Do not publish or send the review without a human
explicitly choosing the audience and destination.

## When to use a scheduled report instead

For a weekly conversion review, use
`weekly-funnel-review@2.0.0`. Its runner receives only a server-executed,
run-bound aggregate generated from an immutable query plan. It does not receive
an owner key, raw users, generic HogQL, or authority to change code, publish a
report, or run an experiment.
