# Find onboarding checklist drop-off

Analyze checklist and setup-step completion so product and CS can see exactly where new
users or accounts stall.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Find onboarding checklist drop-off
description: >-
  Analyze checklist and setup-step completion so product and CS can see exactly
  where new users or accounts stall.
category: growth
tags:
  - analytics
  - onboarding
  - activation
  - funnels
  - b2b
  - customer-success
prompt: >-
  Analyze onboarding checklist drop-off for new accounts: step started, step
  completed, time between steps, and accounts stuck for more than 7 days.
difficulty: beginner
time_to_value: 3 minutes
prereqs:
  - >-
    `onboarding_step_started` and `onboarding_step_completed` include account_id
    and step
applies_to:
  - b2c-saas
  - b2b-saas
  - devtools-api
  - enterprise-sales
required_events:
  - onboarding_step_started
  - onboarding_step_completed
readiness_events:
  - onboarding_step_completed
required_event_properties:
  onboarding_step_started:
    - account_id
    - step
  onboarding_step_completed:
    - account_id
    - step
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
ask_if_missing:
  - >-
    Which observed events map to onboarding_step_started,
    onboarding_step_completed? Are the required signals source-verified, and do
    live PostHog event/property reads show real traffic for them?
  - >-
    Which live properties provide onboarding_step_started.account_id,
    onboarding_step_started.step, onboarding_step_completed.account_id,
    onboarding_step_completed.step, and which stable user or account identifier
    joins the signals?
related:
  - signup-funnel
  - activation-moment
  - implementation-timeline
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

## Why this matters

Signup funnels stop at account creation. Onboarding checklists reveal the harder question: did the customer reach useful value?

## What you get

- Completion by checklist step
- Median time between steps
- Accounts stuck at each step
- A protected metric report for product or CS

## Walk through it

**You:**
> Where do accounts stall in onboarding?

**Agent:**
> I'll compute completion and stuck accounts by step.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.step AS step, countIf(event = 'onboarding_step_started') AS started, countIf(event = 'onboarding_step_completed') AS completed, completed / nullIf(started, 0) AS completion_rate FROM events WHERE event IN ('onboarding_step_started','onboarding_step_completed') AND timestamp > now() - INTERVAL 30 DAY GROUP BY step ORDER BY started DESC"
```

## The output

The agent returns a step table and identifies where intervention matters most. For B2B accounts, it should list stalled accounts for CS follow-up.

## Setting it up

Emit started/completed events from each checklist item or setup milestone. Keep `step` stable and human-readable.

## Variations

- *"Only show enterprise accounts created this month."*
- *"After this metric is backed by a real query blueprint, publish it as a weekly onboarding report."*
- *"Compare checklist drop-off before and after the new setup wizard."*
