# Compare checkout payment methods

Break down checkout completion, failures, and latency by payment method so growth teams
know which option hurts revenue.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Compare checkout payment methods
description: >-
  Break down checkout completion, failures, and latency by payment method so
  growth teams know which option hurts revenue.
category: growth
tags:
  - analytics
  - checkout
  - payments
  - ecommerce
  - conversion
  - revenue
prompt: >-
  Compare checkout performance by payment method: starts, selected method,
  payment failures, completion rate, and median completion time.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - 'Checkout events include payment_method, currency, country, and order_value'
applies_to:
  - ecommerce
  - marketplace
  - single-purchase
requires_revenue: true
required_events:
  - checkout_started
  - payment_method_selected
  - payment_failed
  - checkout_completed
readiness_events:
  - checkout_completed
required_event_properties:
  payment_method_selected:
    - payment_method
  payment_failed:
    - payment_method
    - failure_code
  checkout_completed:
    - payment_method
    - order_value
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
    Which observed events map to checkout_started, payment_method_selected,
    payment_failed, checkout_completed? Are the required signals
    source-verified, and do live PostHog event/property reads show real traffic for
    them?
  - >-
    Which live properties provide payment_method_selected.payment_method,
    payment_failed.payment_method, payment_failed.failure_code,
    checkout_completed.payment_method, checkout_completed.order_value, and which
    stable user or account identifier joins the signals?
related:
  - checkout-completion-time
  - stripe-payment-failure
  - cart-abandonment-funnel
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

## Why this matters

Payment method choice can quietly change conversion. If Apple Pay, card, PayPal, or bank transfer performs differently, the checkout UI and payment routing should reflect that.

## What you get

- Completion rate by payment method
- Failure code breakdown
- Median checkout time by method
- Revenue impact estimate from underperforming methods

## Walk through it

**You:**
> Which payment methods hurt checkout conversion?

**Agent:**
> I'll compare selected payment methods against failed and completed checkouts.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.payment_method AS method, countIf(event = 'payment_method_selected') AS selected, countIf(event = 'payment_failed') AS failed, countIf(event = 'checkout_completed') AS completed FROM events WHERE event IN ('payment_method_selected','payment_failed','checkout_completed') AND timestamp > now() - INTERVAL 30 DAY GROUP BY method ORDER BY selected DESC"
```

```text
{
  "rows": [
    { "method": "card", "selected": 3800, "failed": 184, "completed": 3310 },
    { "method": "paypal", "selected": 920, "failed": 91, "completed": 731 }
  ]
}
```

## The output

The agent returns the methods ranked by lost checkout volume, then separates user-choice problems from processor failures. If useful, it can publish a lightweight revenue dashboard.

## Setting it up

Track checkout lifecycle events with a stable checkout/session id. Include payment method and failure code as normalized properties.

## Variations

- *"Compare payment methods by country."*
- *"Find the payment method with the highest failed revenue."*
- *"Publish checkout method conversion every morning."*
