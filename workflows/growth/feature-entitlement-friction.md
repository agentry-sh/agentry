# Find feature entitlement friction

See which locked features users try to access, which plans hit upgrade prompts, and
where entitlement gates create conversion opportunities.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Find feature entitlement friction
description: >-
  See which locked features users try to access, which plans hit upgrade
  prompts, and where entitlement gates create conversion opportunities.
category: growth
tags:
  - analytics
  - feature-flags
  - pricing
  - expansion
  - product
  - saas
prompt: >-
  Show feature entitlement friction for the last 30 days: locked feature views,
  upgrade prompt impressions, conversion after prompt, and accounts with
  repeated interest.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - >-
    `feature_locked_viewed` and `upgrade_prompt_clicked` include feature, plan,
    and account_id
applies_to:
  - b2c-saas
  - b2b-saas
  - devtools-api
  - enterprise-sales
requires_revenue: true
required_events:
  - feature_locked_viewed
  - upgrade_prompt_clicked
readiness_events:
  - feature_locked_viewed
required_event_properties:
  feature_locked_viewed:
    - feature
    - plan
    - account_id
  upgrade_prompt_clicked:
    - feature
    - plan
    - account_id
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
  - >-
    Do not recommend this for products without a real revenue lifecycle or an
    equivalent paid-account signal.
ask_if_missing:
  - >-
    Which observed events map to feature_locked_viewed, upgrade_prompt_clicked?
    Are the required signals source-verified, and do live PostHog event/property reads
    show real traffic for them?
  - >-
    Which live properties provide feature_locked_viewed.feature,
    feature_locked_viewed.plan, feature_locked_viewed.account_id,
    upgrade_prompt_clicked.feature, upgrade_prompt_clicked.plan,
    upgrade_prompt_clicked.account_id, and which stable user or account
    identifier joins the signals?
related:
  - experiment-analysis
  - expansion-prediction
  - plan-fit-and-overage
execution_mode: on_demand
required_resources:
  - signal_map
  - onboarding_state
  - analytics
  - feature_flags
updatedAt: 2026-07-21T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

## Why this matters

Locked-feature views are demand signals. If many starter accounts repeatedly hit the same feature gate, that is either a pricing opportunity or a product packaging problem.

## What you get

- Locked features ranked by demand
- Prompt click-through and conversion
- Accounts showing repeated expansion intent
- Packaging recommendations by plan

## Walk through it

**You:**
> Which locked features are creating upgrade demand?

**Agent:**
> I'll first inspect the live PostHog flag definitions and prove where source
> applies each relevant entitlement, then compare gate impressions to prompt
> clicks and later plan changes. I will not change a rollout.

```http
GET /v1/projects/:project_id/signal-map
GET /v1/projects/:project_id/onboarding
GET /v1/projects/:project_id/feature-flags?limit=100
GET /v1/projects/:project_id/feature-flags/:flag_id
GET /v1/projects/:project_id/event-property-keys?events=feature_locked_viewed,upgrade_prompt_clicked
```

A flag definition proves provider configuration, not that current source applies
it at the claimed gate or emits the matching demand event. Stop on a missing or
ambiguous source-to-flag mapping instead of joining by a plausible name.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.feature AS feature, properties.plan AS plan, countIf(event = 'feature_locked_viewed') AS locked_views, countIf(event = 'upgrade_prompt_clicked') AS prompt_clicks, count(DISTINCT properties.account_id) AS accounts FROM events WHERE event IN ('feature_locked_viewed','upgrade_prompt_clicked') AND timestamp > now() - INTERVAL 30 DAY GROUP BY feature, plan ORDER BY locked_views DESC LIMIT 30"
```

## The output

The agent returns feature gates with provider state, source ownership, measured
demand, and a reviewable recommendation. It never changes the flag or rollout.

## Setting it up

Emit events wherever the product blocks or upsells a feature. Include account and plan.

## Variations

- *"Show only accounts above 80% quota."*
- *"Find features that get viewed but never upgraded."*
- *"Draft pricing-page copy for the top gated feature."*
