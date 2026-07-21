# Revenue-weight feature requests

Rank feature requests by account value, usage pain, and renewal risk so product and GTM
teams can prioritize with context.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Revenue-weight feature requests
description: >-
  Rank feature requests by account value, usage pain, and renewal risk so
  product and GTM teams can prioritize with context.
category: growth
tags:
  - analytics
  - revenue
  - product
  - roadmap
  - customer-success
  - expansion
prompt: >-
  Rank feature requests by requesting accounts, ARR or plan value, renewal risk,
  usage pain, and whether the feature blocks expansion.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - >-
    Feature request events include account_id, request_key, plan or revenue
    tier, and source
applies_to:
  - b2b-saas
  - enterprise-sales
  - devtools-api
requires_b2b: true
requires_revenue: true
required_events:
  - feature_requested
  - account_health_changed
  - expansion_opportunity_created
readiness_events:
  - feature_requested
required_event_properties:
  feature_requested:
    - account_id
    - request_key
    - source
  account_health_changed:
    - account_id
    - health_score
  expansion_opportunity_created:
    - account_id
    - opportunity_value
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
    Which observed events map to feature_requested, account_health_changed,
    expansion_opportunity_created? Are the required signals source-verified, and
    do live PostHog event/property reads show real traffic for them?
  - >-
    Which live properties provide feature_requested.account_id,
    feature_requested.request_key, feature_requested.source,
    account_health_changed.account_id, account_health_changed.health_score,
    expansion_opportunity_created.account_id,
    expansion_opportunity_created.opportunity_value, and which stable user or
    account identifier joins the signals?
related:
  - account-health-score
  - expansion-prediction
  - feature-launch-adoption
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

## Why this matters

Raw feature-request counts overweight noisy accounts and underweight strategic customers. Revenue weighting gives product a better signal without turning the roadmap into a sales queue.

## What you get

- Feature requests ranked by account value
- Request count by customer segment
- Expansion or renewal context for each request
- A short list of roadmap items to investigate

## Walk through it

**You:**
> Which feature requests matter most commercially?

**Agent:**
> I'll group request events by request key and weight them by account value and customer health.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.request_key AS request, count(DISTINCT properties.account_id) AS accounts, sum(toFloat(properties.opportunity_value)) AS opportunity_value FROM events WHERE event IN ('feature_requested','expansion_opportunity_created') AND timestamp > now() - INTERVAL 180 DAY GROUP BY request ORDER BY opportunity_value DESC, accounts DESC LIMIT 25"
```

## The output

The agent returns a ranked roadmap input, not an automatic roadmap. It should include request volume, revenue context, customer risk, and the next discovery question.

## Setting it up

Emit feature request events from support, sales, feedback forms, or CRM sync. Use a normalized request key so the same request is not split across wording variants.

## Variations

- *"Show requests from renewing accounts only."*
- *"Which requests block expansion?"*
- *"Compare revenue-weighted requests to usage pain."*
