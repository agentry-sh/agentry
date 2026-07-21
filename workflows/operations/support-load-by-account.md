# Rank support load by account

Combine errors, complaints, affected users, and plan data to show which accounts are
consuming the most support attention.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Rank support load by account
description: >-
  Combine errors, complaints, affected users, and plan data to show which
  accounts are consuming the most support attention.
category: ops
tags:
  - analytics
  - errors
  - customer-support
  - account-health
  - b2b
  - revenue
prompt: >-
  Rank accounts by support load for the last 30 days using errors, affected
  users, complaint events, and plan or revenue tier.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - Errors and support-related events carry account_id
applies_to:
  - b2b-saas
  - devtools-api
  - enterprise-sales
requires_b2b: true
required_events:
  - support_ticket_opened
readiness_events:
  - support_ticket_opened
required_event_properties:
  support_ticket_opened:
    - account_id
    - topic
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
    Which observed events map to support_ticket_opened? Are the required signals
    source-verified, and do live PostHog event/property reads show
    real traffic for them?
  - >-
    Which live properties provide support_ticket_opened.account_id,
    support_ticket_opened.topic, and which stable user or account identifier
    joins the signals?
related:
  - account-health-score
  - customer-investigation
  - high-impact-errors
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

## Why this matters

Support load is not evenly distributed. One account can dominate support because of one unresolved bug, bad onboarding, or a product mismatch.

## What you get

- Accounts ranked by tickets, errors, and affected users
- Top topics or fingerprints per account
- Revenue-aware prioritization
- Follow-up action for CS or engineering

## Walk through it

**You:**
> Which accounts are generating the most support load?

**Agent:**
> I'll join support events and error impact by account.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.account_id AS account, countIf(event = 'support_ticket_opened') AS tickets, countIf(event = '$exception') AS errors, count(DISTINCT distinct_id) AS affected_users FROM events WHERE timestamp > now() - INTERVAL 30 DAY GROUP BY account ORDER BY tickets DESC, errors DESC LIMIT 30"
```

## The output

The agent returns accounts by support load and explains whether the likely fix is product, engineering, documentation, or CS.

## Setting it up

Send support-ticket events from your help desk webhook or backend. Use the same `account_id` as analytics and errors.

## Variations

- *"Only show enterprise accounts."*
- *"Which support topics correlate with churn?"*
- *"Create a weekly support-load dashboard."*
