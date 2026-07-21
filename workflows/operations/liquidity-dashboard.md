# Match supply to demand per region or category

Per-region ratio of buyer-side events to seller-side events. Spot starved regions before
they churn. Liquidity is the metric that decides supply vs demand growth investment.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Match supply to demand per region or category
description: >-
  Per-region ratio of buyer-side events to seller-side events. Spot starved
  regions before they churn. Liquidity is the metric that decides supply vs
  demand growth investment.
category: ops
tags:
  - analytics
  - dashboards
  - marketplace
  - liquidity
  - ops
  - b2c
prompt: >-
  Per region (or category), compute the ratio of buyer-side events to
  seller-side events. Flag regions where supply or demand is starved, return the
  evidence table, and only create a CS-visible dashboard if I ask for a
  persistent view.
difficulty: advanced
time_to_value: 10 minutes
prereqs:
  - >-
    Buyer-side and seller-side events both tagged with `region` (or `category`
    if that's your slice)
  - >-
    Enough event volume per slice to be statistically meaningful (~100
    events/week)
applies_to:
  - marketplace
requires_two_sided: true
required_events:
  - search
  - listing_viewed
  - add_to_cart
  - order_placed
  - listing_published
  - order_fulfilled
required_event_properties:
  search:
    - region
  listing_viewed:
    - region
  add_to_cart:
    - region
  order_placed:
    - region
  listing_published:
    - region
  order_fulfilled:
    - region
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
  - >-
    Do not recommend this when the product has no distinct supply and demand
    sides with stable identities.
  - >-
    Do not present illustrative custom analysis as a built-in query blueprint or
    runnable Agentry product surface.
ask_if_missing:
  - >-
    Which observed events map to search, listing_viewed, add_to_cart,
    order_placed, listing_published, order_fulfilled? Are the required signals
    source-verified, and do live PostHog event/property reads show real traffic
    for them?
  - >-
    Which live properties provide search.region, listing_viewed.region,
    add_to_cart.region, order_placed.region, listing_published.region,
    order_fulfilled.region, and which stable user or account identifier joins
    the signals?
related:
  - supply-side-activation
  - account-health-score
  - public-stats-page
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
example_only: true
```

</details>

## Why this matters

Marketplaces grow on liquidity — the ratio of demand to supply in a market. Too much demand and not enough supply means buyers leave empty-handed and never come back. Too much supply and not enough demand means sellers list, get no orders, and churn off.

The interesting fact about marketplaces is that **liquidity is local**. Aggregate liquidity is usually fine. Per-region (or per-category) liquidity is where the leaks are: SF has tons of sellers and no buyers; Phoenix has buyers searching with no sellers to fulfill. Aggregating these averages out and tells you nothing.

Most marketplaces never compute per-region liquidity because joining buyer events and seller events across a region dimension is annoying. Agentry has both event types in one table — the cross-tab is a 10-line HogQL pass.

## What you get

- A per-region (or per-category) table: buyer events, seller events, ratio, health flag
- Dashboard rows the CS / supply / marketing teams can pull up from a server-side panel
- A clear list of starved regions (needs supply growth) and saturated regions (needs demand growth)

## Walk through it

**You:**
> Per region, compute buyer-side events ÷ seller-side events over the last 30 days. Flag regions where the ratio is outside the healthy band. Return rows I can render in a dashboard.

**Agent:**
> One HogQL query, then dashboard-ready rows.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "
    with buyer_events as (
      select properties.region as region, count() as buyer_n
      from events
      where event in ('search', 'listing_viewed', 'add_to_cart', 'order_placed')
        and timestamp > now() - interval 30 day
      group by region
    ),
    seller_events as (
      select properties.region as region, count() as seller_n
      from events
      where event in ('listing_published', 'order_fulfilled')
        and timestamp > now() - interval 30 day
      group by region
    )
    select
      coalesce(b.region, s.region) as region,
      coalesce(b.buyer_n, 0) as buyers,
      coalesce(s.seller_n, 0) as sellers,
      coalesce(b.buyer_n, 0) / nullIf(coalesce(s.seller_n, 0), 0) as ratio
    from buyer_events b
    full outer join seller_events s on b.region = s.region
    having buyers > 100 or sellers > 100
    order by ratio desc
  "
```
```text
{
  "rows": [
    { "region": "Phoenix-AZ",   "buyers": 14200, "sellers":   180, "ratio": 78.89 },
    { "region": "Austin-TX",    "buyers":  8400, "sellers":   320, "ratio": 26.25 },
    { "region": "NYC",          "buyers": 24800, "sellers":  1800, "ratio": 13.78 },
    { "region": "Chicago-IL",   "buyers":  6200, "sellers":   620, "ratio": 10.00 },
    { "region": "LA",           "buyers": 18200, "sellers":  2400, "ratio":  7.58 },
    { "region": "SF-Bay",       "buyers":  4200, "sellers":  3800, "ratio":  1.11 },
    { "region": "Seattle-WA",   "buyers":  2800, "sellers":  4200, "ratio":  0.67 }
  ]
}
```

**Agent:**
> "Healthy" depends on your specific category — for most goods marketplaces a ratio of 5-15 buyer-events per seller-event is the sweet spot. Below 1 you're supply-saturated; above 30 you're demand-saturated.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "<same query as above>"
```
```text
{ "rows": [/* dashboard rows */], "row_count": 7 }
```

**Agent:**
> Dashboard data ready. The picture:
>
> - **Phoenix (78× ratio)**: demand-saturated. Buyers are searching with nothing to buy. Top supply-growth target — recruit sellers here.
> - **Austin (26× ratio)**: also demand-heavy. Worth advertising for sellers.
> - **NYC, Chicago, LA (8-14×)**: healthy band. Don't perturb.
> - **SF-Bay (1.1×)**: supply-saturated. Sellers listing without buyers. Don't recruit more sellers; instead spend on buyer-side ads here.
> - **Seattle (0.67×)**: heavily supply-saturated. Sellers will churn off. Demand-side spend here is urgent.
>
> Two follow-ups worth doing:
>
> 1. Pull the seller churn rate per region — Seattle and SF-Bay sellers are probably leaving at higher rates. Confirm with `dispute-rate-monitoring` or a churn query.
> 2. Re-run this monthly. Liquidity moves — what's starved today could be saturated in 3 months as your growth programs land.

## The output

```
Per-region liquidity (30d)

Region           Buyer events   Seller events   Ratio    Health
─────────────────────────────────────────────────────────────────
Phoenix-AZ          14,200            180        78.9    ★ supply starved
Austin-TX            8,400            320        26.3    ★ supply starved
NYC                 24,800          1,800        13.8    ✓ healthy
Chicago-IL           6,200            620        10.0    ✓ healthy
LA                  18,200          2,400         7.6    ✓ healthy
SF-Bay               4,200          3,800         1.1    ★ demand starved
Seattle-WA           2,800          4,200         0.7    ★★ demand starved (urgent)

Healthy band: 5-15 (varies by category)

Action plan:
  Phoenix, Austin     → ramp seller recruitment (paid + organic)
  Seattle, SF-Bay     → ramp buyer ads / promo spend in-region
  NYC, Chicago, LA    → maintain, no action

Dashboard data:
  returned by POST /v1/projects/:project_id/analytics/query

Suggested next:
  - Per-region seller churn rate (sellers in SF/Seattle probably leaving)
  - Re-run monthly to track shifts as growth programs land
  - Cross-cut by category for narrower targeting
```

## Setting it up

The only requirement is that buyer-side and seller-side events both carry `region` (or `category`, or both). The region usually comes from one of:

- The user profile (`user.region`)
- IP geolocation at request time
- Explicit per-event metadata (shipping address, listing location)

Pick one source per event type and stay consistent. Mixing IP geo on the buyer side with profile-region on the seller side will look like noise:

```ts
// Existing, initialized official PostHog Node client.
posthog.capture({
  distinctId: buyer.id,
  event: "search",
  properties: {
    region: buyer.region,
    category: filters.category,
  },
});

posthog.capture({
  distinctId: seller.id,
  event: "listing_published",
  properties: {
    region: listing.location.region,
    category: listing.category,
    price: listing.price,
  },
});
```

Do not capture raw search text unless it passes a separate privacy review. Run
`agentry onboard` to source-verify both sides and their region semantics.

For higher-fidelity liquidity, weight events differently — a `search` is weaker demand signal than `order_placed`. Adjust the buyer-event SUM to count `order_placed * 5 + add_to_cart * 2 + search * 1`. Agentry's HogQL handles weighted sums natively.

## Variations

- *"Per-category liquidity instead of per-region — same query, swap the group key."*
- *"Weighted liquidity: count buyer events as $X = order * 5 + cart * 2 + search * 1. Apply to seller events as listings * 1 + fulfillments * 5."*
- *"Time-series: per-region ratio per week over the last 90 days. Which regions are improving/worsening?"*
- *"Cross-cut region × category. Phoenix might be supply-starved in furniture but saturated in electronics."*
