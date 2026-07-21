# Review account-health evidence before outreach

Combine verified account usage, revenue context, and support-friction signals into a
review queue without pretending a universal score proves churn or intent.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Review account-health evidence before outreach
description: >-
  Combine verified account usage, revenue context, and support-friction signals
  into a review queue without pretending a universal score proves churn or
  intent.
category: ops
tags:
  - analytics
  - customer-success
  - account-health
  - b2b
  - revenue
  - human-review
prompt: >-
  Prepare an account-health review for the current and prior 30-day periods. Use
  only verified account-level usage, revenue, and support-friction signals, show
  each component separately, flag missing data, and stop before contacting
  anyone.
difficulty: advanced
time_to_value: 10 minutes
prereqs:
  - The product has a stable account or workspace identifier
  - >-
    Usage, revenue snapshots, and support-friction events use that same
    identifier
  - A customer-success owner has approved the definitions and review audience
applies_to:
  - b2b-saas
  - devtools-api
  - enterprise-sales
requires_revenue: true
requires_b2b: true
required_events:
  - account_snapshot
  - product_value_completed
  - support_ticket_opened
readiness_events:
  - account_snapshot
  - product_value_completed
required_event_properties:
  account_snapshot:
    - account_id
    - plan
    - mrr
  product_value_completed:
    - account_id
  support_ticket_opened:
    - account_id
    - topic
negative_fit:
  - >-
    Do not recommend this when the product has no stable account identity or no
    verified paid-account lifecycle.
  - >-
    Do not present a composite score as a churn prediction, customer intent, or
    objective truth.
  - >-
    Do not publish account-level rows or automatically contact, downgrade,
    upsell, or escalate customers from this review.
ask_if_missing:
  - >-
    Which observed event represents delivered product value, and which account
    snapshot is the source of plan and revenue context?
  - >-
    Which exact current and prior periods, account population, and minimum
    activity threshold should be compared?
  - >-
    How should support friction be measured, and who reviews the resulting
    account queue?
related:
  - csm-book-of-business-digest
  - seat-utilization
  - dormant-account-revival
execution_mode: human_review
required_resources:
  - signal_map
  - onboarding_state
  - analytics
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
featured: true
example_only: true
```

</details>

## Why this matters

Customer-success teams need a prioritized review queue, but a single opaque
“health score” can hide missing data and encode arbitrary weights. Low usage can
mean churn risk, seasonality, successful automation, or simply a quiet account.
High ticket volume can mean friction or a deeply engaged implementation.

Use Agentry to assemble the verified components and their trends. If the team
wants a composite score, show the formula, owners, missing-data behavior, and
validation history. Keep the source components visible so a reviewer can
challenge the conclusion.

## What you get

- Current and prior-period value-event counts by account
- Latest verified plan and revenue context
- Support-friction counts only when the signal is actually wired
- A human-reviewed priority queue with missing data and alternative explanations

## Walk through it

**You:**
> Which paid accounts deserve a health review this week?

**Agent:**
> I will verify the account-level signals, compare exact periods, and show the
> components separately. I will not contact customers or infer churn intent.

```http
GET /v1/projects/:project_id/signal-map
GET /v1/projects/:project_id/onboarding
# Require source-verified signals; use live PostHog reads for current evidence.
GET /v1/projects/:project_id/event-property-keys?events=account_snapshot,product_value_completed,support_ticket_opened
```

If the three signals and account key are observed, run a bounded owner-side
aggregate query using the current OpenAPI schema:

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Query plan:
  - bind exact current and immediately preceding half-open periods
  - use the latest account_snapshot for plan and MRR context
  - count product_value_completed separately in both periods
  - count support_ticket_opened separately in the current period
  - return account-level aggregate rows only; no user identities
```

```json
{
  "rows": [
    {
      "account_id": "<account>",
      "plan": "enterprise",
      "mrr": 5000,
      "value_events_current": 42,
      "value_events_prior": 91,
      "support_tickets_current": 6
    }
  ]
}
```

This row establishes a usage decline and measured support load for the declared
signals. It does not establish why usage changed or whether the customer plans
to churn.

## The output

```text
Account-health review — <exact periods>

Priority review
- <account id>
  revenue context: <plan/MRR and source timestamp>
  product value: <current> vs <prior> (<delta>)
  support friction: <count/topic or not measured>
  missing evidence: <gaps>
  hypotheses: <labelled alternatives>
  human next step: <review owner and question to answer>

Healthy / no action
- <accounts with adequate evidence and no material change>

Method
- exact event definitions, time bounds, thresholds, and any score formula
```

The account identifier and revenue context make this a private owner-side
report. Do not turn it into a public-query publication.

## Setting it up

Emit a stable `account_id` on the small set of events used for account-level
decisions. Record periodic account snapshots from the trusted billing or account
system, not from client claims. Choose one value event that reflects delivered
product value rather than raw pageviews or total event volume.

If support tickets are imported as analytics events, include a bounded topic or
reason code and the same account ID; do not copy message bodies or personal data.
Operational error cases are a separate evidence source unless you have a
verified account-level mapping—do not silently join them into an analytics score.

## Variations

- *"Review only accounts renewing in the next 60 days, using a verified renewal signal."*
- *"Show the components for the five accounts with the largest value-event decline."*
- *"Compare the queue with seat utilization, but keep both definitions visible."*
- *"Draft a CSM brief for review; do not choose recipients or send it."*
