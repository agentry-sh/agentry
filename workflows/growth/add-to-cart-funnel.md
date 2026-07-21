# Find which products silently kill conversion

Per-SKU funnel from product view to purchase. Surface products that convert below their
category average — fix the laggards instead of generic PDP tweaks.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Find which products silently kill conversion
description: >-
  Per-SKU funnel from product view to purchase. Surface products that convert
  below their category average — fix the laggards instead of generic PDP tweaks.
category: growth
tags:
  - analytics
  - funnels
  - product
  - ecommerce
  - conversion
  - mixpanel-alternative
prompt: >-
  Build the per-SKU funnel: product_view → add_to_cart → checkout_started →
  purchase. Surface SKUs with worst conversion vs the category average.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - >-
    `product_viewed` / `add_to_cart` / `order_completed` events with `sku` and
    `category` in properties
  - At least 30 days of traffic for meaningful per-SKU sample sizes
applies_to:
  - ecommerce
required_events:
  - product_viewed
  - add_to_cart
  - order_placed
required_event_properties:
  product_viewed:
    - sku
    - category
  add_to_cart:
    - sku
  order_placed:
    - order_id
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
    Which observed events map to product_viewed, add_to_cart, order_placed? Are the required signals
    source-verified, and do live PostHog event/property reads show
    real traffic for them?
  - >-
    Which live properties provide product_viewed.sku, product_viewed.category,
    add_to_cart.sku, order_placed.order_id, and which stable user or account
    identifier joins the signals?
related:
  - cart-abandonment-funnel
  - refund-rate-by-sku
  - checkout-completion-time
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
example_only: true
```

</details>

## Why this matters

"Improve product pages" is the most useless advice in ecommerce. Of your 800 SKUs, maybe 30 are quietly dragging your conversion average down — bad hero image, missing reviews, confusing variant selector, copy that scares people off. The other 770 are fine.

The fix isn't generic PDP overhauls. It's identifying *which 30 SKUs* underperform their category average and fixing those. But nobody runs the per-SKU funnel manually because it means 800 funnel queries.

Agentry's HogQL builds the funnel for every SKU in one pass, computes the per-category baseline, and ranks the offenders. The whole loop — query, find the laggards, ship product page updates — becomes a weekly cadence instead of a once-a-year project.

## What you get

- Per-SKU conversion rate at each funnel step (view → cart → checkout → purchase)
- Per-category baseline so you can spot the SKUs that are 2-3x worse than their cohort
- Dashboard data the merchandising team can render from a server-side panel every Monday

## Walk through it

**You:**
> Build the per-SKU funnel: product_view → add_to_cart → checkout_started → purchase. Surface SKUs with worst conversion vs the category average.

**Agent:**
> One pass with HogQL — compute view-to-purchase per SKU, then deltas vs category mean.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "
    with per_sku as (
      select
        properties.sku as sku,
        properties.category as category,
        countIf(event = 'product_viewed') as views,
        countIf(event = 'order_completed') as orders
      from events
      where timestamp > now() - interval 30 day
        and event in ('product_viewed', 'order_completed')
      group by sku, category
      having views > 100
    ),
    category_mean as (
      select category, sum(orders) / sum(views) as cat_conv
      from per_sku
      group by category
    )
    select
      p.sku, p.category, p.views, p.orders,
      p.orders / p.views as sku_conv,
      c.cat_conv,
      (p.orders / p.views) / c.cat_conv as ratio_to_cat
    from per_sku p
    join category_mean c using (category)
    where (p.orders / p.views) < c.cat_conv * 0.5
    order by ratio_to_cat asc
    limit 25
  "
```
```text
{
  "rows": [
    { "sku": "tee-blk-xxl", "category": "apparel", "views": 4210, "orders":   8, "sku_conv": 0.0019, "cat_conv": 0.041, "ratio_to_cat": 0.046 },
    { "sku": "mug-12oz-grey", "category": "drinkware", "views": 2840, "orders":  14, "sku_conv": 0.0049, "cat_conv": 0.038, "ratio_to_cat": 0.130 },
    { "sku": "sock-stripe-m", "category": "apparel", "views": 1190, "orders":   9, "sku_conv": 0.0076, "cat_conv": 0.041, "ratio_to_cat": 0.184 },
    { "sku": "hat-snap-blk", "category": "headwear", "views":  920, "orders":  11, "sku_conv": 0.0120, "cat_conv": 0.048, "ratio_to_cat": 0.249 }
  ]
}
```

**Agent:**
> Four SKUs are 4-25× below their category conversion. `tee-blk-xxl` is the worst by a mile — 4,210 views, 8 orders. That's a 0.2% conversion against the apparel category average of 4.1%. Likely culprits at a glance: stockouts on size XXL, broken size guide, or a bad hero image.
>
> Let me turn this into dashboard data merch can see Monday morning, then drill into the top offender.

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

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "
    select count() as n, properties.referrer as ref
    from events
    where event = 'product_viewed'
      and properties.sku = 'tee-blk-xxl'
      and timestamp > now() - interval 7 day
    group by ref order by n desc limit 10
  "
```
```text
{
  "rows": [
    { "n": 1804, "ref": "/category/tees" },
    { "n":  920, "ref": "/search?q=black+tee" },
    { "n":  410, "ref": "google.com/ads" }
  ]
}
```

**Agent:**
> So `tee-blk-xxl` gets real intent traffic (1.8k from category listings, 410 from paid ads) and still doesn't convert. That's not a discoverability problem — it's a PDP problem.
>
> Top fixes I'd try, ranked by effort × likely impact:
>
> 1. Stockout check: is XXL actually in stock? If 80% of "view" sessions show "Out of stock" the conv is mechanically capped.
> 2. Hero image audit — XXL on a S-sized model is a known killer in apparel
> 3. Size guide link visible above the fold
>
> I can produce an on-demand top-five laggard summary for #merch; you choose whether and where to share it.

## The output

```
SKU funnel laggards (30d, conversion < 50% of category)

SKU              Cat        Views    Orders   SKU%   Cat%   Ratio
─────────────────────────────────────────────────────────────────
tee-blk-xxl      apparel    4,210      8     0.19%  4.10%  0.05x ★★★
mug-12oz-grey    drinkware  2,840     14     0.49%  3.80%  0.13x ★★
sock-stripe-m    apparel    1,190      9     0.76%  4.10%  0.18x ★★
hat-snap-blk     headwear     920     11     1.20%  4.80%  0.25x ★

Public view:
  Use Agentry's returned public_url after publishing a real query blueprint.

Top offender breakdown (tee-blk-xxl):
  Traffic source        Views
  /category/tees        1,804  ← organic browse
  /search?q=black+tee     920  ← high-intent search
  google.com/ads          410  ← paid traffic burning $$

Recommended actions:
  1. Stockout check (mechanical conversion cap)
  2. Hero image — fit on size-appropriate model
  3. Add visible size guide above fold
```

## Setting it up

You need `sku` and `category` on both `product_viewed` and `order_completed`. If you only have one of the two, the per-category baseline can't be computed.

```ts
// Existing, initialized official PostHog web SDK.
posthog.capture("product_viewed", {
  sku: product.sku,
  category: product.category,
  referrer: document.referrer,
});

// Order confirmation
posthog.capture("order_completed", {
  sku: lineItem.sku,
  category: lineItem.category,
  total: order.total,
});
```

For Shopify, use its supported PostHog/Web Pixel integration and send directly
to the customer's PostHog project. Run `agentry onboard` to review identity,
successful-order placement, and duplicate-event risk before changing a pixel.

## Variations

- *"Same query, but show me top-converting SKUs too — the ones at 2x+ category average. Those are the ones to feature in email and ads."*
- *"Per-SKU breakdown of the cart abandonment step specifically — which SKUs end up in carts but never bought?"*
- *"Compare conversion by referrer for my top 10 SKUs — does paid traffic convert worse than organic on the same product?"*
- *"Compare this week with the prior week, then draft the top five laggards for a merch lead to review and share."*
