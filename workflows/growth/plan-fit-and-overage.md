# Find plan fit and overage opportunities

Identify accounts close to limits, repeatedly over quota, or paying for capacity they do
not use so revenue teams know who to help.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Find plan fit and overage opportunities
description: >-
  Identify accounts close to limits, repeatedly over quota, or paying for
  capacity they do not use so revenue teams know who to help.
category: growth
tags:
  - analytics
  - revenue
  - expansion
  - quotas
  - b2b
  - customer-success
prompt: >-
  Find accounts with plan-fit issues: near quota, over quota, or underusing paid
  capacity. Rank by revenue impact and suggested CS action.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - 'Usage or quota events include account_id, metric, used, limit, and plan'
applies_to:
  - b2b-saas
  - devtools-api
  - enterprise-sales
requires_revenue: true
requires_b2b: true
required_events:
  - quota_snapshot
readiness_events:
  - quota_snapshot
required_event_properties:
  quota_snapshot:
    - account_id
    - metric
    - used
    - limit
    - plan
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
  - >-
    Do not recommend this for products without a real revenue lifecycle or an
    equivalent paid-account signal.
  - >-
    Do not recommend this when the product has no stable account or workspace
    identity.
ask_if_missing:
  - >-
    Which observed events map to quota_snapshot? Are the required signals
    source-verified, and do live PostHog event/property reads show real traffic for
    them?
  - >-
    Which live properties provide quota_snapshot.account_id,
    quota_snapshot.metric, quota_snapshot.used, quota_snapshot.limit,
    quota_snapshot.plan, and which stable user or account identifier joins the
    signals?
related:
  - api-usage-as-upsell-signal
  - seat-utilization
  - expansion-prediction
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

## Why this matters

Quota pressure is an expansion signal. Underuse is a churn signal. Both are revenue moments that rarely show up in one place.

## What you get

- Accounts near or over quota
- Accounts underusing paid plans
- Suggested action: upsell, enablement, downgrade risk, or no action
- A dashboard CS and revenue ops can review weekly

## Walk through it

**You:**
> Which accounts are on the wrong plan?

**Agent:**
> I'll rank quota usage by account and plan.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.account_id AS account, properties.plan AS plan, properties.metric AS metric, argMax(toFloat(properties.used), timestamp) AS used, argMax(toFloat(properties.limit), timestamp) AS limit, used / nullIf(limit, 0) AS utilization FROM events WHERE event = 'quota_snapshot' AND timestamp > now() - INTERVAL 14 DAY GROUP BY account, plan, metric ORDER BY utilization DESC LIMIT 50"
```

## The output

The agent returns accounts grouped into expansion, risk, and healthy buckets. It should avoid treating temporary spikes as expansion without recent trend.

## Setting it up

Emit a periodic `quota_snapshot` event from billing or usage metering. Include current plan and metric names.

## Variations

- *"Only show enterprise accounts."*
- *"Find accounts over 80% for three days in a row."*
- *"Publish a quota-health board for CS."*
