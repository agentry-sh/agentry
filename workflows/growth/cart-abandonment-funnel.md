# Measure cart-to-purchase drop-off

Map three verified ecommerce events, run the canonical ordered funnel, and separate
measured checkout loss from hypotheses about payment, shipping, or UX.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Measure cart-to-purchase drop-off
description: >-
  Map three verified ecommerce events, run the canonical ordered funnel, and
  separate measured checkout loss from hypotheses about payment, shipping, or
  UX.
category: growth
tags:
  - analytics
  - funnels
  - ecommerce
  - checkout
  - cart-abandonment
prompt: >-
  Measure add-to-cart → checkout-started → order-completed for the last 30 days.
  Verify the exact events and stable shopper identity, run funnel_3_step,
  calculate drop-offs from the returned counts, and label possible causes as
  hypotheses.
difficulty: beginner
time_to_value: 5 minutes
prereqs:
  - Three ordered ecommerce events share a stable shopper identity
  - >-
    The required signals are source-verified and live PostHog reads show real
    traffic for all three events
applies_to:
  - ecommerce
required_events:
  - add_to_cart
  - checkout_started
  - order_completed
readiness_events:
  - add_to_cart
  - checkout_started
  - order_completed
required_event_properties:
  add_to_cart:
    - sku
  order_completed:
    - order_id
negative_fit:
  - >-
    Do not use guessed ecommerce event names or interpret missing events as
    shopper abandonment.
  - >-
    Do not claim time-on-step, revenue loss, causes, or industry benchmarks from
    the three-count funnel blueprint.
  - >-
    Do not mix anonymous and known shopper identities without a verified
    identity-linking strategy.
ask_if_missing:
  - >-
    Which observed events represent add-to-cart, checkout start, and completed
    order in that exact order?
  - >-
    Which stable shopper identity joins guest and signed-in steps without double
    counting?
  - >-
    What exact lookback, storefront, device population, and exclusions should be
    applied?
related:
  - stripe-payment-failure
  - checkout-completion-time
  - checkout-payment-method-performance
execution_mode: on_demand
required_resources:
  - signal_map
  - onboarding_state
  - query_blueprints
featured: false
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
example_only: false
```

</details>

## Why this matters

A cart funnel shows where measured progression stops; it does not explain why.
Payment failures, shipping cost, inventory, slow pages, identity changes, and
simple intent can all produce similar drop-off.

The `funnel_3_step` blueprint answers the narrow ordered question reliably. Use
separate evidence to investigate causes after the largest measured loss is
known.

## What you get

- Three approved, observed ecommerce events
- Ordered shopper counts for the selected lookback
- Step and overall conversion calculated from canonical counts
- Identity and instrumentation caveats plus a ranked follow-up plan

## Walk through it

**You:**
> Where do shoppers drop between cart and completed order?

**Agent:**
> I will verify the storefront's exact event names and identity continuity before
> running the three-step funnel.

```http
GET /v1/projects/:project_id/signal-map
GET /v1/projects/:project_id/onboarding
# Require source-verified signals; use live PostHog reads for current evidence.
GET /v1/projects/:project_id/event-names
GET /v1/query-blueprints/funnel_3_step
```

```json
{
  "server_emitted": [],
  "analytics_events": [
    { "event": "cart_item_added", "count": 21400, "last_seen": 1783651200 },
    { "event": "checkout_started", "count": 8800, "last_seen": 1783651210 },
    { "event": "order_completed", "count": 4200, "last_seen": 1783651250 }
  ],
  "wildcards": []
}
```

```http
POST /v1/projects/:project_id/query-blueprints/funnel_3_step/run
```

```text
Params:
  step1: cart_item_added
  step2: checkout_started
  step3: order_completed
  days: 30
```

```json
{
  "rows": [
    { "step1_count": 21400, "step2_count": 8800, "step3_count": 4200 }
  ]
}
```

The measured conversions are 41.1% from cart to checkout, 47.7% from checkout
to order, and 19.6% overall. Those calculations do not include time-on-step,
cart value, payment failure, or a benchmark.

## The output

```text
Cart-to-purchase funnel — last 30 days

cart_item_added       21,400  100.0%
checkout_started       8,800   41.1%  drop: 58.9%
order_completed        4,200   19.6%  step conversion: 47.7%

Evidence gaps
- <identity, sampling, delayed server confirmation, missing device property>

Follow-up hypotheses
- payment failures → inspect verified payment-failure signal
- slow checkout → inspect measured completion duration
- payment-method differences → run the dedicated comparison
```

## Setting it up

Capture browser actions and server-confirmed orders through the application's
official PostHog SDKs, directly to the same customer project. Use a stable
first-party shopper identity and a source-verified transition when the shopper
signs in. Never treat a client-side “purchase clicked” event as a completed
order.

Include only necessary properties such as SKU or storefront. Keep payment data,
addresses, tokens, and cart contents outside analytics.

## Variations

- *"Segment the same funnel by an observed device property."*
- *"Compare two exact adjacent periods with the same frozen event mapping."*
- *"Measure product-view to add-to-cart separately using a suitable approved query."*
- *"Tell me which missing event prevents a trustworthy funnel."*
