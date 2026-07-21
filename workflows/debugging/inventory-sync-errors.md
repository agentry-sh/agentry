# Catch display-vs-actual-stock mismatches

Find inventory sync errors trending up by warehouse and SKU before customers do. The 'in
stock' display lie is one of the highest-cost bugs in ecommerce.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Catch display-vs-actual-stock mismatches
description: >-
  Find inventory sync errors trending up by warehouse and SKU before customers
  do. The 'in stock' display lie is one of the highest-cost bugs in ecommerce.
category: debugging
tags:
  - errors
  - inventory
  - ecommerce
  - infra
  - oncall
prompt: >-
  Are there inventory sync errors trending up? Look for InventoryMismatchError
  or related patterns. Group by warehouse and SKU.
difficulty: intermediate
time_to_value: 1 minute
prereqs:
  - PostHog exceptions from the order pipeline or inventory service
  - >-
    Errors include `warehouse_id` and `sku` in properties (or in the error
    message)
applies_to:
  - ecommerce
required_events:
  - $exception
required_event_properties:
  $exception:
    - $exception_type
    - warehouse_id
    - sku
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
ask_if_missing:
  - >-
    Which observed events map to $exception? Are the required signals
    source-verified, and do live PostHog event/property reads show real traffic for
    them?
  - >-
    Which live properties provide $exception.$exception_type,
    $exception.warehouse_id, $exception.sku, and which stable user or account
    identifier joins the signals?
related:
  - refund-rate-by-sku
  - stripe-payment-failure
  - cors-misconfig
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
```

</details>

## Why this matters

Showing "in stock" on a sold-out item is one of the most expensive bugs in ecommerce. The customer:

1. Adds it to cart
2. Pays
3. Gets a delayed-fulfillment email
4. Refunds + chargebacks + a one-star review

You eat the payment processing fee, the support time, the customer acquisition cost, *and* the SEO damage from a public review that calls you a scam.

The root cause is almost always inventory desync — your warehouse system says 0, your storefront cache says 4. Catching this in code (a `InventoryMismatchError` thrown when checkout discovers the gap) is easy. Catching it in operations means surfacing the error in 5 minutes, not 5 hours.

Agentry buckets inventory errors by warehouse and SKU automatically — you can see which warehouse's sync job is misfiring, against which products, trending which direction.

## What you get

- Per-warehouse error rate for the inventory sync pipeline
- Top SKUs implicated (so you can pull them from the storefront proactively)
- A trend line — is it spiking right now, or is this a chronic 2% noise floor?

## Walk through it

**You:**
> Are inventory sync errors trending up? Look for InventoryMismatchError or related. Group by warehouse and SKU.

**Agent:**
> Let me pull recent cases that match, then run a HogQL trend by warehouse.

```text
Endpoint: GET /v1/projects/:project_id/cases
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fcases&method=get
Use query parameters, not a JSON body.
Query/filter concept:
  status: "open",
  matching: "Inventory|StockMismatch|OutOfStock",
  window_hours: 24
```
```text
{
  "cases": [
    {
      "case_id": "c_inv_1",
      "fingerprint": "f_inv_a",
      "error_type": "InventoryMismatchError",
      "message": "Expected stock=4 actual=0 sku=wireless-buds-v2 warehouse=us-west",
      "events_count": 142,
      "users_affected": 38,
      "first_seen_at": "2026-05-15T09:22:00Z"
    },
    {
      "case_id": "c_inv_2",
      "fingerprint": "f_inv_b",
      "error_type": "OutOfStockError",
      "message": "Concurrent checkout drained inventory sku=blender-mini warehouse=us-west",
      "events_count": 68,
      "users_affected": 21,
      "first_seen_at": "2026-05-15T14:05:00Z"
    }
  ]
}
```

**Agent:**
> Two open cases, both centered on the `us-west` warehouse. 142 + 68 events in 24h. Let me trend it.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "
    select
      toStartOfHour(timestamp) as hour,
      properties.warehouse_id as warehouse,
      count() as errors
    from events
    where event = '$exception'
      and (properties.$exception_type = 'InventoryMismatchError'
           or properties.$exception_type = 'OutOfStockError')
      and timestamp > now() - interval 7 day
    group by hour, warehouse
    order by hour desc
    limit 50
  "
```
```text
{
  "rows": [
    { "hour": "2026-05-16T13:00:00Z", "warehouse": "us-west", "errors": 38 },
    { "hour": "2026-05-16T12:00:00Z", "warehouse": "us-west", "errors": 41 },
    { "hour": "2026-05-16T11:00:00Z", "warehouse": "us-west", "errors": 27 },
    { "hour": "2026-05-16T10:00:00Z", "warehouse": "us-west", "errors":  8 },
    { "hour": "2026-05-16T13:00:00Z", "warehouse": "us-east", "errors":  2 },
    { "hour": "2026-05-15T18:00:00Z", "warehouse": "us-west", "errors":  4 }
  ]
}
```

**Agent:**
> `us-west` started spiking around 10:00 today — went from 4-8/hour baseline to 27, 41, 38. Same hour the warehouse system was supposed to push its overnight delta. Almost certainly a stuck sync job, not application code.
>
> Two SKUs concentrate the failures: `wireless-buds-v2` and `blender-mini`. Both are the high-velocity ones — first to drain when sync lags.
>
> I'd:
>
> 1. Force a manual full-sync on `us-west` right now
> 2. Pull these two SKUs from the homepage hero until you confirm sync is caught up
> 3. Refund any orders placed on `wireless-buds-v2` in the last 4 hours that aren't actually fulfillable
>
> Want me to draft the customer apology template for those refunds?

## The output

```
Inventory sync errors (24h)

Warehouse    Events    Trend      Top SKUs
─────────────────────────────────────────────────────────────
us-west        210     SPIKING ★  wireless-buds-v2 (142), blender-mini (68)
us-east          5     normal     -
eu-west          1     normal     -

us-west hourly:
  10:00   8  ─
  11:00  27  ▌
  12:00  41  █     ★ sync job stuck
  13:00  38  ▊

Cases open:
  c_inv_1  InventoryMismatchError       142 events, 38 users
  c_inv_2  OutOfStockError (concurrent)  68 events, 21 users

Recommended actions (in order):
  1. Force full-sync us-west warehouse
  2. Pull wireless-buds-v2 + blender-mini from hero
  3. Manually refund affected orders, draft apology
  4. (Once stable) Add an alert: us-west errors > 20/hour
```

## Setting it up

At the inventory reservation failure boundary, use the application's existing
official PostHog server SDK exception integration and attach `warehouse_id`,
`sku`, and bounded expected/actual quantities. Re-throw or preserve the original
business failure behavior; telemetry must not change retry or response logic.

Run `agentry onboard` to review that source owner and confirm the properties in
the connected PostHog issue evidence. Then re-run the analysis when `us-west`
is suspected of exceeding 20/hour and draft an #ops summary for human review.

## Variations

- *"Same query but split by sync-job version — did the deploy at 09:30 introduce the bug?"*
- *"Per-warehouse: time between 'last successful sync' and 'first mismatch'. Are the warehouses with longer sync gaps the noisy ones?"*
- *"List SKUs whose mismatch rate exceeds 10% and recommend which homepage placements a merch owner should review; do not change merchandising automatically."*
- *"Show me which customers were affected by today's us-west spike — I want to send personal apology refunds."*
