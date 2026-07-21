# Schedule a private weekly funnel review

Render the bounded weekly-funnel-review template so a scoped runner records an
exact-period aggregate report without raw users or mutation authority.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Schedule a private weekly funnel review
description: >-
  Render the bounded weekly-funnel-review template so a scoped runner records an
  exact-period aggregate report without raw users or mutation authority.
category: ops
tags:
  - analytics
  - automation
  - funnels
  - weekly-review
  - governance
prompt: >-
  Render weekly-funnel-review@2.0.0 for this project. Map 2–20 distinct approved
  events in exact funnel order, choose an exact schedule and timezone, require a
  meaningful minimum sample, keep every mutation forbidden, and leave the
  candidate disabled for owner review.
difficulty: advanced
time_to_value: 30 minutes to review and configure
prereqs:
  - The saved signal map defines 2–20 distinct events in exact funnel order
  - >-
    The required signals are source-verified and live PostHog reads show real
    traffic for every selected event
  - >-
    A selected scheduler can run with one credential bound to this automation
    only
applies_to:
  - universal
required_events:
  - funnel_entry
  - funnel_progressed
  - funnel_completed
readiness_events:
  - funnel_entry
  - funnel_progressed
  - funnel_completed
required_event_properties: {}
negative_fit:
  - >-
    Do not render this template until 2–20 distinct live events are approved and
    observed for the project.
  - >-
    Do not use this report to infer causality or authorize code, experiment,
    publication, messaging, merge, or deploy changes.
  - >-
    Do not give the scheduler a private owner key or a runner credential shared
    with another automation.
ask_if_missing:
  - Which 2–20 observed events define the funnel in exact order?
  - >-
    What timezone, weekly boundary, comparison-period length, and minimum sample
    should govern the report?
  - >-
    Which scheduler and escalation destination will own failed, late, or blocked
    runs?
related:
  - signup-funnel
  - weekly-changelog
  - weekly-agent-digest
execution_mode: automation_template
automation_playbook_id: weekly-funnel-review
automation_playbook_version: 2.0.0
required_resources:
  - signal_map
  - onboarding_state
  - automation_control
  - automation_contract
  - automation_runner_credential
publishedAt: 2026-07-10T00:00:00.000Z
featured: true
```

</details>

## Why this is different from a weekly prompt

A cron prompt with a private owner key can choose new queries, read raw users,
and turn a report into an unreviewed side effect. It also tends to compare
moving `now()` windows, which makes reruns produce different evidence.

`weekly-funnel-review@2.0.0` renders a disabled automation-v2 candidate with a
single immutable report source. Agentry anchors the comparison to the trusted
schedule receipt, executes the approved aggregate blueprint server-side, and
gives the exact runner only that run-bound source. The runner cannot read raw
identities or generic analytics.

The template never publishes, sends messages, changes code, creates a draft PR,
starts an experiment, merges, deploys, or enables itself.

## Configure it

Start with the machine-readable version and filtered OpenAPI schemas:

```text
GET /v1/automation-playbooks/weekly-funnel-review?version=2.0.0
POST /v1/projects/:project_id/automation-playbooks/weekly-funnel-review/render
```

The strict renderer requires:

- 2–20 distinct ordered event names from the saved signal map;
- a conservative five-field cron expression and IANA timezone;
- a bounded schedule-start window and exact comparison-period length;
- a minimum sample size for both adjacent periods;
- run, turn, runtime, and cost budgets with the PR budget locked to zero;
- the selected runner provider and an escalation destination.

It also checks the saved signal map, source-verified evidence, live PostHog
event/property reads, scoped credentials, and saved
contract, and `ordered_funnel_period_compare` blueprint. Missing or synthetic-only
events, stale verification, an unavailable blueprint, or missing scheduler
readiness remain blocking gates.

Review the normalized definition and binding hash, then save it with:

```http
PUT /v1/projects/:project_id/automation-contract
```

Saving leaves the automation disabled. An owner reviews the exact ETag, creates
one `agentry_runner_…` credential bound to this `automation_id`, configures the
selected scheduler, and explicitly enables the reviewed contract.

## What one run does

1. The scheduler wakes Agentry using only the configured `automation_id`.
2. Agentry issues a single-use schedule receipt for one eligible occurrence.
3. The exact runner credential starts a run whose policy is snapshotted.
4. Agentry executes `ordered_funnel_period_compare` using the trusted scheduled time as
   the exclusive end of the current period.
5. The blueprint returns prior and current half-open windows, ordered funnel
   counts, conversion and drop-off values, and explicit sample readiness.
6. The runner reads only the run-bound aggregate report source and records a
   private typed report of evidence, hypotheses, gaps, and escalation needs.
7. Agentry closes or escalates the run according to the saved policy.

Rerunning the same occurrence preserves the same evidence window. The runner
cannot replace the event names, move the period boundary, or request arbitrary
HogQL during the run.

## Review the report

Use the human control aggregate to inspect the schedule, credential health,
latest runs, budgets, and attention items:

```http
GET /v1/projects/:project_id/automation-control
```

A safe report separates exact evidence from interpretation:

```text
Weekly funnel review — <prior bounds> vs <current bounds>

Readiness
- approved events: <entry> → <progress> → <completion>
- prior/current minimum sample: pass | blocked

Observed
- step counts and conversion for both exact periods
- absolute and relative movement
- largest measured drop-off change

Hypotheses
- <explicitly labelled ideas to investigate>

Missing proof / escalation
- <telemetry gap, low sample, late run, or owner decision>
```

No report row grants authority to contact customers, change a product, or make
a causal claim. A human chooses any follow-up.

## Stop control

An owner can cancel a nonterminal run with a stable `Idempotency-Key`:

```http
POST /v1/automation-runs/:run_id/cancel
```

Cancellation stops Agentry coordination and releases internal claims. It does
not undo an external scheduler action or publish anything on the user's behalf.

## Review checklist

- Every selected event is approved, observed, distinct, and in exact order.
- The schedule timezone and boundary match the business reporting calendar.
- The minimum sample is meaningful for both periods.
- The runner credential is bound to this one automation and is not an owner key.
- Generic analytics, raw identities, publication, messaging, and code changes remain forbidden.
- The candidate stays disabled until an owner reviews and enables its exact ETag.
