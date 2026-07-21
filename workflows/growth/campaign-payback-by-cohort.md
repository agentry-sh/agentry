# Calculate campaign payback by cohort

Tie acquisition campaigns to paid conversion, revenue, and retention so marketing and
finance can see which campaigns pay back.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Calculate campaign payback by cohort
description: >-
  Tie acquisition campaigns to paid conversion, revenue, and retention so
  marketing and finance can see which campaigns pay back.
category: growth
tags:
  - analytics
  - marketing
  - revenue
  - cohorts
  - acquisition
  - saas
prompt: >-
  Calculate campaign payback by signup cohort: campaign, spend if available,
  paid conversions, revenue, retention, and payback period.
difficulty: advanced
time_to_value: 10 minutes
prereqs:
  - Signup and revenue events include campaign or utm_campaign
  - Campaign spend is available as events or a joined property
applies_to:
  - b2c-saas
  - b2b-saas
  - ecommerce
  - devtools-api
requires_revenue: true
required_events:
  - signup_completed
  - subscription_started
readiness_events:
  - subscription_started
required_event_properties:
  signup_completed:
    - utm_campaign
  subscription_started:
    - utm_campaign
    - amount
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
    Which observed events map to signup_completed, subscription_started? Are the required signals
    source-verified, and do live PostHog event/property reads show
    real traffic for them?
  - >-
    Which live properties provide signup_completed.utm_campaign,
    subscription_started.utm_campaign, subscription_started.amount, and which
    stable user or account identifier joins the signals?
related:
  - landing-page-source-quality
  - trial-to-paid-conversion
  - self-serve-vs-sales-led
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

## Why this matters

Campaign dashboards stop at leads. Product-led teams need to know which campaigns create activated, retained, paying users.

## What you get

- Campaign cohorts by signup week
- Paid conversion and revenue
- Retention by campaign
- Payback estimate when spend is available

## Walk through it

**You:**
> Which campaigns actually paid back?

**Agent:**
> I'll group signup cohorts by campaign and join revenue events.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.utm_campaign AS campaign, countIf(event = 'signup_completed') AS signups, countIf(event = 'subscription_started') AS paid, sumIf(toFloat(properties.amount), event = 'subscription_started') AS revenue FROM events WHERE event IN ('signup_completed','subscription_started') AND timestamp > now() - INTERVAL 90 DAY GROUP BY campaign ORDER BY revenue DESC"
```

## The output

The agent returns campaigns ranked by quality and revenue, not just signup count.

## Setting it up

Persist campaign attribution onto signup and revenue lifecycle events. If spend is not in Agentry, the agent can still rank revenue and conversion.

## Variations

- *"Only compare campaigns from last quarter."*
- *"Show campaigns with high signups but low paid conversion."*
- *"Publish this as a finance review dashboard."*
