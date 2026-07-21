# Find the products driving refunds

Compute refund rate per SKU over 90 days. One bad product can poison your margins —
refund-rate-per-SKU separates the herd from the outliers.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Find the products driving refunds
description: >-
  Compute refund rate per SKU over 90 days. One bad product can poison your
  margins — refund-rate-per-SKU separates the herd from the outliers.
category: debugging
tags:
  - analytics
  - refunds
  - ecommerce
  - quality
  - customer-support
prompt: >-
  Compute refund rate per SKU (refunds ÷ purchases) over the last 90 days.
  Filter to SKUs with at least 20 orders. Rank by rate.
difficulty: beginner
time_to_value: 2 minutes
prereqs:
  - '`order_completed` events with `sku` and `order_id` in properties'
  - '`refund_issued` events (or equivalent) emitted from your refund flow'
applies_to:
  - ecommerce
required_events:
  - order_placed
  - refund_issued
required_event_properties:
  order_placed:
    - sku
  refund_issued:
    - sku
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
  - >-
    Do not present illustrative custom analysis as a built-in query blueprint or
    runnable Agentry product surface.
ask_if_missing:
  - >-
    Which observed events map to order_placed, refund_issued? Are the required signals
    source-verified, and do live PostHog event/property reads show
    real traffic for them?
  - >-
    Which live properties provide order_placed.sku, refund_issued.sku, and which
    stable user or account identifier joins the signals?
related:
  - add-to-cart-funnel
  - inventory-sync-errors
  - stripe-payment-failure
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
example_only: true
```

</details>

## Why this matters

Your overall refund rate is 3.2%. Fine. Average. Industry norm.

But that average masks the truth: 4 SKUs are at 28-35% refund rate, dragging the whole catalog up. The remaining 800 SKUs are at 1.8%. The 4 bad ones cost you $84k in refunds last quarter and ~$50k in support tickets — plus the reputational damage from one-star reviews.

Aggregate refund rate is useless. **Per-SKU refund rate** is where the actionable signal lives. Most ecommerce tools don't expose it because joining purchase and refund events per SKU is non-trivial — but it's a one-liner in HogQL.

## What you get

- Per-SKU refund rate ranked highest first, with order volume gate (min 20 orders)
- Quick segmentation of "always-refunded" vs "occasionally-refunded" SKUs
- Dashboard rows the CX team can pull up in a Monday triage

## Walk through it

**You:**
> Compute refund rate per SKU over the last 90 days. Filter to SKUs with at least 20 orders. Rank by rate.

**Agent:**
> Joining orders and refunds on `order_id`, grouped by `sku`. Filtering to ≥20 orders so we don't get sample-size noise.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "
    with orders as (
      select properties.sku as sku, properties.order_id as order_id
      from events
      where event = 'order_completed' and timestamp > now() - interval 90 day
    ),
    refunds as (
      select properties.order_id as order_id
      from events
      where event = 'refund_issued' and timestamp > now() - interval 90 day
    )
    select
      o.sku,
      count(distinct o.order_id) as orders,
      count(distinct r.order_id) as refunds,
      count(distinct r.order_id) / count(distinct o.order_id) as refund_rate
    from orders o
    left join refunds r using (order_id)
    group by o.sku
    having orders >= 20
    order by refund_rate desc
    limit 30
  "
```
```text
{
  "rows": [
    { "sku": "wireless-buds-v2", "orders":  142, "refunds": 50, "refund_rate": 0.352 },
    { "sku": "smartwatch-band-l", "orders":  84, "refunds": 24, "refund_rate": 0.286 },
    { "sku": "yoga-mat-pro",      "orders":  61, "refunds": 14, "refund_rate": 0.230 },
    { "sku": "blender-mini",      "orders":  92, "refunds": 19, "refund_rate": 0.207 },
    { "sku": "tee-blk-xxl",       "orders":  41, "refunds":  7, "refund_rate": 0.171 }
  ]
}
```

**Agent:**
> Five SKUs are clearly outliers. The wireless buds at 35% refund rate are catastrophic — that's $4-5k of refunds per month on just that one product, plus margin loss on the units. Two patterns I see:
>
> - **Defects**: `wireless-buds-v2`, `blender-mini` — high-tech, low-cost products with quality issues. Worth a chat with the supplier.
> - **Sizing**: `smartwatch-band-l`, `tee-blk-xxl` — apparel/wearables where customers can't try before buying. Better photos and a sizing chart usually halve this.
>
> Let me prepare the dashboard rows.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "<same query as above>"
```
```text
{ "rows": [/* dashboard rows */], "row_count": 25 }
```

**Agent:**
> Dashboard data ready. I'd suggest pulling `wireless-buds-v2` off the homepage hero until you investigate — at that refund rate you're paying for the customer acquisition twice.

## The output

```
Refund rate by SKU (90d, min 20 orders)

SKU                  Orders   Refunds   Rate     Cohort
─────────────────────────────────────────────────────────
wireless-buds-v2      142       50      35.2%    ★★★ pull from hero
smartwatch-band-l      84       24      28.6%    ★★  sizing — fix chart
yoga-mat-pro           61       14      23.0%    ★★  defects — check QC
blender-mini           92       19      20.7%    ★★  defects — check supplier
tee-blk-xxl            41        7      17.1%    ★   sizing
─────────────────────────────────────────────────────────
catalog avg            ─        ─        3.2%

Aggregate: 5 SKUs (0.6% of catalog) drive 41% of total refunds.

Public view:
  Use Agentry's returned public_url after publishing a real query blueprint.

Suggested next investigations:
  - inventory-sync-errors: are these "wrong item shipped" mistakes?
  - add-to-cart-funnel: do these SKUs also convert poorly? (double signal)
```

## Setting it up

Two events on the order lifecycle, both with `order_id` so they can be joined:

```ts
// Existing, initialized official PostHog web SDK on the confirmation page.
posthog.capture("order_completed", {
  order_id: order.id,
  sku: lineItem.sku,
  qty: lineItem.qty,
});
```

The refund webhook uses the customer's existing official PostHog server SDK:

```ts
posthog.capture({
  distinctId: customer.id,
  event: "refund_issued",
  properties: {
    order_id: refund.order_id,
    amount: refund.amount,
    reason: refund.reason,
  },
});
```

Use the same stable customer identity on both sides. If a single order has
multiple SKUs, emit one `order_completed` event per line item or explicitly
review an array/unnest contract. Run `agentry onboard` before changing an
existing order taxonomy.

## Variations

- *"Per-SKU refund rate broken down by refund_reason — separate 'defective' from 'changed my mind'."*
- *"Last 30 days vs prior 30 days per SKU — which products are getting worse?"*
- *"For my top 5 worst-refunding SKUs, pull the actual refund messages from CX. Are there themes?"*
- *"Compare the worst five SKUs with the prior week and draft a merch summary for human review."*
