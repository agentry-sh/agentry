# Track buyer-seller dispute frequency per seller

Per-seller disputes ÷ transactions over 90 days. Surface the top-decile dispute-drivers
proactively — proactive review costs less than reactive churn.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Track buyer-seller dispute frequency per seller
description: >-
  Per-seller disputes ÷ transactions over 90 days. Surface the top-decile
  dispute-drivers proactively — proactive review costs less than reactive churn.
category: growth
tags:
  - analytics
  - marketplace
  - trust
  - b2c
  - customer-support
prompt: >-
  Per seller, compute dispute_opened events / total_transactions over the last
  90 days. Surface sellers in the top decile — review them before customers
  notice.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - '`order_completed` events with `seller_id` and `order_id`'
  - '`dispute_opened` events with `seller_id` and `order_id`'
applies_to:
  - marketplace
  - ecommerce
required_events:
  - order_placed
  - dispute_opened
required_event_properties:
  dispute_opened:
    - seller_id
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
    Which observed events map to order_placed, dispute_opened? Are the required signals
    source-verified, and do live PostHog event/property reads show
    real traffic for them?
  - >-
    Which live properties provide dispute_opened.seller_id, and which stable
    user or account identifier joins the signals?
related:
  - review-bomb-detection
  - refund-rate-by-sku
  - account-health-score
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
example_only: true
```

</details>

## Why this matters

Marketplace trust is built on the absence of bad actors. A small percentage of sellers cause a disproportionate share of disputes — fraudulent listings, broken products shipped, post-purchase ghosting. Letting them operate burns trust on the buyer side and reputation across the platform.

The classic mistake is reactive triage: wait for buyers to complain loudly enough that CS escalates a specific seller. By the time that happens, 50 buyers have had bad experiences and your refund liability is real.

The proactive version: rank every seller by dispute rate, review the top decile on a chosen cadence, and let a human decide when intervention is justified. This workflow provides the ranking evidence.

## What you get

- Per-seller dispute rate (disputes ÷ transactions) over a 90-day window
- Volume threshold so you don't false-positive on sellers with 3 transactions
- The top decile flagged for proactive CS review
- Dashboard rows the trust & safety team can pull up from a server-side panel

## Walk through it

**You:**
> Per seller, compute dispute_opened ÷ total_transactions over the last 90 days. Surface sellers in the top decile — review them before customers notice.

**Agent:**
> One HogQL join, then the percentile cut.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "
    with orders as (
      select properties.seller_id as seller, count() as txns
      from events
      where event = 'order_completed' and timestamp > now() - interval 90 day
      group by seller
    ),
    disputes as (
      select properties.seller_id as seller, count() as disp
      from events
      where event = 'dispute_opened' and timestamp > now() - interval 90 day
      group by seller
    )
    select
      o.seller,
      o.txns,
      coalesce(d.disp, 0) as disputes,
      coalesce(d.disp, 0) / o.txns as dispute_rate
    from orders o
    left join disputes d using (seller)
    where o.txns >= 20
    order by dispute_rate desc
    limit 100
  "
```
```text
{
  "rows": [
    { "seller": "s_8421", "txns":  142, "disputes": 38, "dispute_rate": 0.268 },
    { "seller": "s_1840", "txns":   62, "disputes": 14, "dispute_rate": 0.226 },
    { "seller": "s_3110", "txns":   84, "disputes": 18, "dispute_rate": 0.214 },
    { "seller": "s_7720", "txns":   42, "disputes":  8, "dispute_rate": 0.190 },
    { "seller": "s_4421", "txns":  220, "disputes": 38, "dispute_rate": 0.173 }
  ]
}
```

**Agent:**
> Aggregate distribution to find where the cliff is.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "
    with rates as (
      select properties.seller_id as seller, coalesce(d, 0) / o as rate
      from (
        select properties.seller_id, count() as o,
          countIf(event = 'dispute_opened') as d
        from events
        where event in ('order_completed', 'dispute_opened')
          and timestamp > now() - interval 90 day
        group by properties.seller_id
        having count() >= 20
      )
    )
    select
      avg(rate)      as avg_rate,
      quantile(0.5)(rate)  as p50,
      quantile(0.9)(rate)  as p90,
      quantile(0.99)(rate) as p99,
      max(rate)      as max_rate,
      count() as n_sellers
    from rates
  "
```
```text
{
  "rows": [
    { "avg_rate": 0.022, "p50": 0.014, "p90": 0.062, "p99": 0.184, "max_rate": 0.268, "n_sellers": 4280 }
  ]
}
```

**Agent:**
> Distribution:
>
> | Stat | Value |
> |---|---|
> | Avg | 2.2% |
> | Median | 1.4% |
> | P90 | 6.2% |
> | P99 | 18.4% |
> | Max | 26.8% |
>
> The top 1% of sellers (about 42 sellers) have dispute rates of 18%+ — that's 8× the platform average. Worth proactive review on every one of those.
>
> The five sellers I surfaced earlier are all in the >17% bucket. `s_8421` at 26.8% (38 disputes on 142 transactions) is your worst-case — either fraudulent or systemic quality issue.
>
> Let me prepare the dashboard rows.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "<first query above>"
```
```text
{ "rows": [/* dashboard rows */], "row_count": 50 }
```

**Agent:**
> Two follow-ups worth doing:
>
> 1. **`s_8421` deep-dive**: pull their last 50 transactions and the 38 dispute messages. Pattern-match — is it "item never arrived" (shipping fraud) or "item not as described" (listing fraud)?
> 2. **Review threshold crossings on demand**: list sellers above 15% with the evidence a CS owner needs to decide what to do.

## The output

```
Seller dispute rates — top decile (90d)

Seller       Txns      Disputes    Rate     Decile    Action
─────────────────────────────────────────────────────────────────
s_8421        142         38       26.8%    P99       ★★★ deep-dive
s_1840         62         14       22.6%    P99       ★★ review
s_3110         84         18       21.4%    P99       ★★ review
s_7720         42          8       19.0%    P99       ★★ review
s_4421        220         38       17.3%    P99       ★ contact

Platform stats:
  Median dispute rate:    1.4%
  P90:                    6.2%
  P99:                   18.4%
  Sellers analyzed:      4,280

Recommended workflow:
  - Daily: review P99 (top ~42 sellers); confirm legitimacy
  - Weekly: outreach to P90-P99 (next ~380 sellers); offer training
  - Human review: surface new sellers above 15% without changing seller state or contacting anyone

Public view:
  Use Agentry's returned public_url after publishing a real query blueprint.
```

## Setting it up

Two events, both with `seller_id` and `order_id`:

```ts
// Existing, initialized official PostHog Node client.
posthog.capture({
  distinctId: buyer.id,
  event: "order_completed",
  properties: {
    order_id: order.id,
    seller_id: listing.seller_id,
    gmv: order.amount,
  },
});

posthog.capture({
  distinctId: buyer.id,
  event: "dispute_opened",
  properties: {
    order_id: dispute.order_id,
    seller_id: dispute.seller_id,
    reason: dispute.reason,
    amount: dispute.amount,
  },
});
```

Capture each event only after its durable business transition succeeds. Run
`agentry onboard` to review the join and the bounded dispute-reason taxonomy.

The `min 20 transactions` filter in the query is important — without it, a seller with 2 transactions and 1 dispute shows up as 50% and dominates the ranking with no signal.

## Variations

- *"Same query split by dispute reason. 'Not received' vs 'not as described' point to different bad-actor types."*
- *"Trend per seller — show me sellers whose dispute rate jumped in the last 14 days vs prior 76. Newly-bad actors."*
- *"Cohort the rate by seller tenure — do new sellers dispute more, or seasoned sellers?"*
- *"List sellers above 25% dispute rate with sample-size evidence and draft a pause recommendation for CS; do not change seller state automatically."*
