# Is checkout too slow?

Compute p50/p90/p99 of checkout duration split by mobile and desktop. Mobile p99 is
usually 4-8x worse than desktop p50.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Is checkout too slow?
description: >-
  Compute p50/p90/p99 of checkout duration split by mobile and desktop. Mobile
  p99 is usually 4-8x worse than desktop p50.
category: growth
tags:
  - analytics
  - checkout
  - ecommerce
  - performance
  - posthog-alternative
prompt: >-
  Compute p50, p90, p99 of the time from checkout_started to purchase. Split by
  device (mobile vs desktop).
difficulty: intermediate
time_to_value: 2 minutes
prereqs:
  - Events for `checkout_started` and `order_completed` (or your equivalents)
  - Device/browser info on events — auto-attached if you send from the browser
applies_to:
  - ecommerce
required_events:
  - checkout_started
  - order_placed
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
    Which observed events map to checkout_started, order_placed? Are the required signals
    source-verified, and do live PostHog event/property reads show
    real traffic for them?
related:
  - cart-abandonment-funnel
  - stripe-payment-failure
  - browser-version-errors
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
example_only: true
```

</details>

## Why this matters

Checkout speed is one of the few performance metrics that ties directly to revenue. The industry rule of thumb: every additional second of checkout time costs you ~3% conversion. A 4-second checkout vs an 8-second checkout is the difference between profit and a marketing budget that feels mysteriously inefficient.

The aggregate "average checkout time" hides the truth. The metric that matters is the **mobile p99** — what your slowest 1% of mobile users experience. That's where the conversion bleed happens, because mobile p99 is typically 4-8x worse than desktop p50, and it's where impulse-buyers live.

GA4 won't show you this without custom dimensions. Shopify Analytics gives you "store performance" which is a server-side metric, not a per-shopper timing. Agentry computes it from your existing event timestamps in one HogQL query.

## What you get

- Percentile distribution (p50, p90, p99) of `order_completed_ts - checkout_started_ts`, in seconds
- Split by device (mobile / desktop / tablet)
- A protected metric report so you can watch it after every checkout optimization

## Walk through it

**You:**
> Compute p50, p90, p99 of the time from checkout_started to purchase. Split by device.

**Agent:**
> Self-join on distinct_id, compute the duration, percentile by device.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "WITH starts AS (SELECT distinct_id, properties.$device_type AS device, timestamp AS start_ts FROM events WHERE event = 'checkout_started' AND timestamp >= now() - INTERVAL 30 DAY), purchases AS (SELECT distinct_id, timestamp AS purchase_ts FROM events WHERE event = 'order_completed' AND timestamp >= now() - INTERVAL 30 DAY), durations AS (SELECT s.device AS device, dateDiff('second', s.start_ts, p.purchase_ts) AS duration_s FROM starts s INNER JOIN purchases p ON s.distinct_id = p.distinct_id AND p.purchase_ts > s.start_ts AND p.purchase_ts < s.start_ts + INTERVAL 1 HOUR) SELECT device, count() AS n, round(quantile(0.5)(duration_s)) AS p50_s, round(quantile(0.9)(duration_s)) AS p90_s, round(quantile(0.99)(duration_s)) AS p99_s FROM durations GROUP BY device ORDER BY n DESC"
```
```text
{
  "rows": [
    { "device": "Desktop", "n": 2840, "p50_s": 38,  "p90_s": 96,  "p99_s": 280 },
    { "device": "Mobile",  "n": 1240, "p50_s": 72,  "p90_s": 320, "p99_s": 1840 },
    { "device": "Tablet",  "n": 120,  "p50_s": 58,  "p90_s": 198, "p99_s": 720 }
  ]
}
```

**Agent:**
> The numbers confirm the usual story, hard:
>
> | Device  | n     | p50  | p90  | p99   |
> |---------|------:|-----:|-----:|------:|
> | Desktop | 2,840 | 38s  | 96s  | 280s  |
> | Mobile  | 1,240 | 72s  | 320s | **1,840s** |
> | Tablet  | 120   | 58s  | 198s | 720s  |
>
> Mobile p99 is **30 minutes**. The 1% slowest mobile users sit on your checkout page for half an hour before completing. Most of them don't — they bail (that's why this workflow pairs with `cart-abandonment-funnel`, which would show you the mobile-specific abandonment rate).
>
> Desktop p90 of 96s is fine. Mobile p90 of 320s (5.3 min) is the silent killer — that's the curve where ~10% of mobile shoppers sit waiting and many will tab away.
>
> Two things to investigate:
> 1. **Payment-form latency on mobile** — Stripe Elements is heavier than the built-in `<input>` and slower on low-end Android
> 2. **Network ping for the confirm POST** — mobile users on cellular hit 200-500ms RTTs vs desktop's <50ms
>
> This percentile query is custom HogQL, not a built-in public-query blueprint. I can keep it in a protected server-side view that reruns the `analytics/query` call. If you explicitly want a browser-safe public URL, I should first add a real query blueprint for checkout duration percentiles and then publish that blueprint.

## The output

```
Checkout Duration (30d)

DEVICE     N         p50      p90       p99
Desktop  2,840    38s ▎    96s ▎▎    280s ▎▎▎▎
Mobile   1,240    72s ▎▎  320s ▎▎▎▎  1,840s ▎▎▎▎▎▎▎▎▎▎▎▎▎▎▎▎▎▎▎ ★ FIX
Tablet     120    58s ▎▎  198s ▎▎▎    720s ▎▎▎▎▎▎▎▎▎▎▎

KEY NUMBERS:
  Desktop p50 (good baseline):       38s
  Mobile  p50:                       72s  (1.9x desktop)
  Mobile  p90:                       320s (3.3x desktop)
  Mobile  p99:                     1,840s (6.6x desktop)  ← optimization target

REVENUE IMPACT (rough, using 3%-per-second heuristic):
  Reducing mobile p90 from 320s → 200s would lift mobile conversion by ~12%
  At your current 1,240 mobile completions / 30d, that's +150 orders / month
  At avg order $69 (your current AOV), ~$10k/month uplift

Optional public view:
  Only after you ask for a browser-safe share link, use Agentry's returned public_url from a real query blueprint.

SUGGESTED INVESTIGATIONS:
  - Replace Stripe Elements with Payment Request / Apple Pay on mobile
  - Preconnect to api.stripe.com on checkout page load
  - Lazy-load the confirmation page JS bundle on /checkout
```

## Setting it up

You need two events with timestamps and a device-type tag:

```ts
// Existing, initialized official PostHog web SDK.
posthog.capture("checkout_started", { cart_value: cart.total });

// Capture only after the order boundary succeeds.
posthog.capture("order_completed", { order_id: order.id, total: order.total });
```

Use PostHog's standard device context rather than maintaining a second user-
agent parser. Run `agentry onboard` to verify stable identity, the exact success
boundary, and the device property used by the connected project.

For sub-second precision, the workflow also works if you send a single `checkout_completed_in_s` property on `order_completed` (computed client-side as `Date.now() - checkoutStartedAt`). HogQL is happier with explicit durations than with timestamp diffs at scale.

## Variations

- *"Same query but split by BROWSER as well — old Safari might dominate the slow tail."*
- *"Split by checkout payment method — is Stripe Link faster than card form?"*
- *"Compute the same percentiles for product_page_load_ms and add_to_cart_response_ms. Where else is the friction?"*
- *"Watch this metric: alert me if mobile p90 increases by >20% week-over-week."* (uses `POST /v1/projects/:project_id/alerts`)
