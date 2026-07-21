# Find accounts paying for 10 seats but using 3

Compute seat utilization per B2B account and flag low-use payers. Catch downgrade risk
and surface expansion-conversation accounts.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Find accounts paying for 10 seats but using 3
description: >-
  Compute seat utilization per B2B account and flag low-use payers. Catch
  downgrade risk and surface expansion-conversation accounts.
category: growth
tags:
  - analytics
  - expansion
  - seat-utilization
  - b2b
  - account-health
  - saas
prompt: >-
  For each B2B account, compute paid_seats vs active_users in the last 30 days.
  Surface accounts where utilization < 50%.
difficulty: intermediate
time_to_value: 3 minutes
prereqs:
  - 'Events tagged with `account_id` (the workspace/team, not just the user)'
  - >-
    Some way to know paid seat count per account — either an event
    (`seat_count_set`) or a property
applies_to:
  - b2b-saas
requires_b2b: true
requires_revenue: true
required_events:
  - seat_count_set
  - feature_used
required_event_properties:
  seat_count_set:
    - account_id
    - seat_count
    - mrr
  feature_used:
    - account_id
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
  - >-
    Do not recommend this for products without a real revenue lifecycle or an
    equivalent paid-account signal.
  - >-
    Do not recommend this when the product has no stable account or workspace
    identity.
ask_if_missing:
  - >-
    Which observed events map to seat_count_set, feature_used? Are the required signals
    source-verified, and do live PostHog event/property reads show
    real traffic for them?
  - >-
    Which live properties provide seat_count_set.account_id,
    seat_count_set.seat_count, seat_count_set.mrr, feature_used.account_id, and
    which stable user or account identifier joins the signals?
related:
  - account-health-score
  - dormant-account-revival
  - expansion-prediction
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
```

</details>

## Why this matters

Per-seat pricing is the most common B2B SaaS model and the most under-monitored. Acme buys 25 seats during the sales cycle, the original champion onboards 8 of them, and 17 seats sit dormant for the next 11 months. At renewal they ask "why are we paying for 25?" and downgrade to 8 — you lose 60% of that ARR overnight.

Two failure modes prevent teams from catching this:

1. **Aggregating across accounts hides it.** Total active users went up; nobody notices a single account where utilization dropped from 80% → 30%.
2. **No one runs the query.** Mixpanel can compute it but you have to build a custom dashboard per customer, and nobody does.

Agentry's one prompt: utilization per account, sorted by lost-opportunity ARR. CS gets a call sheet; product gets a "why is the second seat hard to onboard" question.

## What you get

- A ranked list of paid accounts by **utilization gap** (paid_seats − active_users in last 30d)
- ARR per account so you can prioritize by deal size
- A bucket: **at risk** (low and dropping), **expansion candidates** (high and ceiling), **dormant** (low and flat)

## Walk through it

**You:**
> For each B2B account, compute paid_seats vs active_users in the last 30 days. Surface accounts where utilization < 50%.

**Agent:**
> Let me compute the join — most-recent `seat_count_set` per account vs active distinct users in last 30 days.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "WITH seats AS (SELECT properties.account_id AS account_id, argMax(properties.seat_count, timestamp) AS paid_seats, argMax(properties.mrr, timestamp) AS mrr FROM events WHERE event = 'seat_count_set' GROUP BY account_id), active AS (SELECT properties.account_id AS account_id, uniq(distinct_id) AS active_users FROM events WHERE timestamp >= now() - INTERVAL 30 DAY GROUP BY account_id) SELECT s.account_id AS account, s.paid_seats AS paid_seats, COALESCE(a.active_users, 0) AS active_users, s.mrr AS mrr, round(COALESCE(a.active_users, 0) * 100.0 / s.paid_seats, 1) AS utilization_pct FROM seats s LEFT JOIN active a ON s.account_id = a.account_id WHERE s.paid_seats >= 5 ORDER BY (s.paid_seats - COALESCE(a.active_users, 0)) * s.mrr DESC LIMIT 20"
```
```text
{
  "rows": [
    { "account": "acct_megacorp",  "paid_seats": 50, "active_users": 14, "mrr": 5000, "utilization_pct": 28.0 },
    { "account": "acct_globex",    "paid_seats": 25, "active_users": 8,  "mrr": 1875, "utilization_pct": 32.0 },
    { "account": "acct_acme",      "paid_seats": 10, "active_users": 9,  "mrr": 750,  "utilization_pct": 90.0 },
    { "account": "acct_tinyco",    "paid_seats": 5,  "active_users": 1,  "mrr": 250,  "utilization_pct": 20.0 }
  ]
}
```

**Agent:**
> Two big at-risk accounts:
>
> 1. **megacorp** — 50 paid seats, 14 active. $5,000/mo. They're paying for 36 unused seats — that's $3,600/mo of "fake ARR" at renewal risk.
> 2. **globex** — 25 paid, 8 active. $1,875/mo. ~$1,275/mo of risk.
>
> Acme is the opposite — at 90% utilization they're capped and probably ready to add seats. Let me check megacorp's trend to see if it's worsening.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Query/filter concept:
  query: "SELECT toStartOfMonth(timestamp) AS month, uniq(distinct_id) AS active_users FROM events WHERE properties.account_id = '<source_verified_account_id>' AND timestamp >= now() - INTERVAL 120 DAY GROUP BY month ORDER BY month ASC LIMIT 4"
```
```text
{
  "rows": [
    { "month": "<month_1>", "active_users": 32 },
    { "month": "<month_2>", "active_users": 24 },
    { "month": "<month_3>", "active_users": 18 },
    { "month": "<month_4>", "active_users": 14 }
  ],
  "row_count": 4,
  "freshness": { "source": "customer_posthog_cloud_hogql" }
}
```

**Agent:**
> Megacorp's active users are dropping every month (32 → 14 over 4 months). That's a renewal-killer trajectory. They'll either downgrade to ~15 seats or churn entirely at renewal.
>
> Recommended CS workflow today:
> - Call megacorp's admin, do a usage review, identify which teams stopped
> - Quick-win: re-onboard the dormant 36 with a 2-week internal campaign
> - Acme is the expansion conversation — they're saturated, suggest 15-seat upgrade

## The output

```
Seat Utilization Report (30d)

⚠ AT RISK (utilization dropping)
   megacorp   50 paid · 14 active · 28%  · $5,000/mo
              Trend: 32 → 24 → 18 → 14 (4-mo decline)
              ↗ $3,600/mo at risk · CS call today

   globex     25 paid ·  8 active · 32%  · $1,875/mo
              ↗ $1,275/mo at risk · usage review needed

   tinyco      5 paid ·  1 active · 20%  · $250/mo
              ↗ Solo founder bought 5 seats, never onboarded team
                Low ROI for CS effort, low risk dollar

✓ EXPANSION CANDIDATES (saturated)
   acme       10 paid ·  9 active · 90%  · $750/mo
              ↗ Add 5-seat upgrade conversation
              ↗ "Looks like the team is full — should we add seats for new hires?"

TOTAL ARR AT RISK:        ~$4,875/mo  ($58.5k/yr)
EXPANSION OPPORTUNITY:    ~$375/mo    ($4.5k/yr +)
```

## Setting it up

Two events required:

**1. `seat_count_set` whenever Stripe updates the quantity:**

```ts
// In your Stripe webhook for customer.subscription.updated
const seatCount = subscription.items.data.find(i => i.price.id === SEAT_PRICE_ID)?.quantity ?? 1;

posthog.capture({
  distinctId: subscription.metadata.account_id,
  event: "seat_count_set",
  properties: {
    account_id: subscription.metadata.account_id,
    seat_count: seatCount,
    mrr: subscription.items.data[0].price.unit_amount * seatCount / 100,
  },
});
```

**2. `account_id` on every per-user event:**

```ts
posthog.capture({
  distinctId: user.id,
  event: "dashboard_view",
  properties: {
    account_id: user.workspace_id,
    role: user.role,
  },
});
```

These examples assume an initialized official PostHog Node client. Run
`agentry onboard` to prove the Stripe quantity and user-action boundaries.

## Variations

- *"Show seat utilization split by role — are admins active but ICs dormant?"*
- *"Find accounts where utilization dropped >20 points in the last quarter (faster decline)."*
- *"Turn this into a protected CS report our team can check daily."* (custom account-utilization analysis should run server-side; public-query publication is only for real query blueprints)
- *"For each at-risk account, draft a personalized re-engagement email."*
