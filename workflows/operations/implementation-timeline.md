# Track enterprise implementation timeline

Follow an enterprise account from kickoff through integration, first data, first value,
and blocked steps so solutions teams can unblock launches.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Track enterprise implementation timeline
description: >-
  Follow an enterprise account from kickoff through integration, first data,
  first value, and blocked steps so solutions teams can unblock launches.
category: ops
tags:
  - analytics
  - customer-success
  - enterprise
  - onboarding
  - implementation
  - b2b
prompt: >-
  Build an implementation timeline for enterprise accounts: kickoff, integration
  started, first data received, first value achieved, and currently blocked
  steps.
difficulty: intermediate
time_to_value: 7 minutes
prereqs:
  - Implementation milestone events include account_id and milestone
applies_to:
  - enterprise-sales
  - b2b-saas
  - devtools-api
requires_b2b: true
required_events:
  - implementation_milestone
readiness_events:
  - implementation_milestone
required_event_properties:
  implementation_milestone:
    - account_id
    - milestone
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
  - >-
    Do not recommend this when the product has no stable account or workspace
    identity.
ask_if_missing:
  - >-
    Which observed events map to implementation_milestone? Are the required signals
    source-verified, and do live PostHog event/property reads show
    real traffic for them?
  - >-
    Which live properties provide implementation_milestone.account_id,
    implementation_milestone.milestone, and which stable user or account
    identifier joins the signals?
related:
  - demo-poc-tracking
  - onboarding-checklist-dropoff
  - renewal-risk-brief
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

## Why this matters

Enterprise adoption is a sequence, not a single signup. When accounts stall, CS and solutions need to know which milestone is blocked and for how long.

## What you get

- Timeline per account
- Days since last milestone
- Accounts blocked before first value
- Suggested follow-up owner

## Walk through it

**You:**
> Which enterprise implementations are stuck?

**Agent:**
> I'll reconstruct milestone timelines by account.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.account_id AS account, properties.milestone AS milestone, min(timestamp) AS first_seen, max(timestamp) AS last_seen FROM events WHERE event = 'implementation_milestone' GROUP BY account, milestone ORDER BY account, first_seen"
```

## The output

The agent returns each stuck account, last completed milestone, days stuck, and next action. It should read like an implementation standup note.

## Setting it up

Emit `implementation_milestone` from backend workflows, CRM sync, or manual admin actions.

## Variations

- *"Only show accounts with a signed contract."*
- *"Group blocked accounts by missing milestone."*
- *"Draft the implementation status email."*
