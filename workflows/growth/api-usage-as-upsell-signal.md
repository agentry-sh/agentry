# API quota usage as engagement and upsell timing

For each customer on a usage-based plan, show daily call volume as % of cap. Flag
accounts approaching 80% — the perfect upgrade moment.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: API quota usage as engagement and upsell timing
description: >-
  For each customer on a usage-based plan, show daily call volume as % of cap.
  Flag accounts approaching 80% — the perfect upgrade moment.
category: growth
tags:
  - analytics
  - api-quota
  - expansion
  - devtools-api
  - b2b
  - saas
prompt: >-
  For each customer on an API-call quota, show their daily usage as % of cap.
  Flag accounts approaching 80% — upsell trigger.
difficulty: intermediate
time_to_value: 3 minutes
prereqs:
  - Per-API-call analytics events with `account_id` and the count
  - >-
    A way to know each account's current quota (event with `quota_set` or
    property on every event)
applies_to:
  - devtools-api
requires_revenue: true
requires_b2b: true
required_events:
  - api_request
required_event_properties:
  api_request:
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
    Which observed events map to api_request? Are the required signals
    source-verified, and do live PostHog event/property reads show real traffic for
    them?
  - >-
    Which live properties provide api_request.account_id, and which stable user
    or account identifier joins the signals?
related:
  - expansion-prediction
  - account-health-score
  - seat-utilization
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
```

</details>

## Why this matters

API-quota pricing turns engineering into a sales-influencing function. Every call your customer makes is both a feature use AND a step toward needing more. The hot signal — "this customer is about to hit the cap" — is the warmest upsell moment in your business. They're already paying, they've already integrated, they're feeling the limit.

Stripe Metering can compute usage but doesn't surface "approaching limit" alerts in a usable form. Most teams find out a customer hit their cap when the customer gets a 429 and emails support angry.

Agentry computes per-account quota utilization in one HogQL query and ranks accounts by "about to hit the wall." Sales gets the call list; engineering gets the signal too (capacity planning).

## What you get

- A per-account utilization table: `account | quota | used_today | used_mtd | pct_of_cap | days_to_cap_at_current_rate`
- The accounts crossing thresholds (50/80/95/100%) sorted by how soon they'll hit
- A draft email per top-3 to the account's primary contact: "you're at 82% — here's how upgrading helps"

## Walk through it

**You:**
> For each customer on an API-call quota, show their daily usage as % of cap. Flag accounts approaching 80% — upsell trigger.

**Agent:**
> Computing per-account API call counts and joining against current quota.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "WITH quotas AS (SELECT properties.account_id AS aid, argMax(properties.api_quota_monthly, timestamp) AS quota FROM events WHERE event = 'quota_set' GROUP BY aid HAVING quota > 0), usage_mtd AS (SELECT properties.account_id AS aid, count() AS calls_mtd FROM events WHERE event = 'api_call' AND timestamp >= toStartOfMonth(now()) GROUP BY aid), usage_today AS (SELECT properties.account_id AS aid, count() AS calls_today FROM events WHERE event = 'api_call' AND timestamp >= toStartOfDay(now()) GROUP BY aid), days_passed AS (SELECT dateDiff('day', toStartOfMonth(now()), now()) + 1 AS days_in_mtd, dateDiff('day', toStartOfMonth(now()), toStartOfMonth(now() + INTERVAL 1 MONTH)) AS days_in_month) SELECT q.aid AS account, q.quota AS quota, COALESCE(u.calls_mtd, 0) AS used_mtd, COALESCE(t.calls_today, 0) AS used_today, round(COALESCE(u.calls_mtd, 0) * 100.0 / q.quota, 1) AS pct_of_cap, round(COALESCE(u.calls_mtd, 0) * 1.0 / d.days_in_mtd * d.days_in_month, 0) AS projected_eom, round(q.quota * 1.0 / nullIf(COALESCE(u.calls_mtd, 0) * 1.0 / d.days_in_mtd, 0)) AS days_to_cap_at_current_rate FROM quotas q LEFT JOIN usage_mtd u ON q.aid = u.aid LEFT JOIN usage_today t ON q.aid = t.aid CROSS JOIN days_passed d HAVING pct_of_cap >= 50 ORDER BY pct_of_cap DESC"
```
```text
{
  "rows": [
    { "account": "acct_megacorp", "quota": 1000000, "used_mtd": 982400, "used_today": 41200, "pct_of_cap": 98.2, "projected_eom": 1340000, "days_to_cap_at_current_rate": 0 },
    { "account": "acct_innovate", "quota": 500000,  "used_mtd": 412000, "used_today": 18400, "pct_of_cap": 82.4, "projected_eom": 562000,  "days_to_cap_at_current_rate": 4 },
    { "account": "acct_acme",     "quota": 100000,  "used_mtd": 71000,  "used_today": 3100,  "pct_of_cap": 71.0, "projected_eom": 96900,   "days_to_cap_at_current_rate": 9 },
    { "account": "acct_globex",   "quota": 250000,  "used_mtd": 142000, "used_today": 4800,  "pct_of_cap": 56.8, "projected_eom": 194000,  "days_to_cap_at_current_rate": 22 }
  ]
}
```

**Agent:**
> Three accounts in the upgrade zone:
>
> 1. **megacorp — 98.2%, ALREADY OVER projected.** They'll hit the cap today or tomorrow. Their 429s are about to start; sales should call now, not after the angry email.
> 2. **innovate — 82.4%, ~4 days to cap.** Perfect warm-lead moment. Reach out before they feel the pain.
> 3. **acme — 71%, ~9 days to cap.** Worth a CSM "heads up, you're trending toward your cap, want to discuss next tier?" message.
>
> Globex at 57% is fine; mention in next QBR. Let me draft the megacorp + innovate emails:
>
> ---
> **To: champion@megacorp.com**
> Subject: Heads up — you're at 98% of your monthly API quota
>
> Hi —
>
> Your team's pace this month puts you above your 1M-call cap by end of the month, likely as soon as tomorrow. Two options:
>
> 1. Bump to the next tier (5M calls/mo) — same per-call price, headroom for growth.
> 2. Stay on this tier and accept rate-limiting once you hit the cap.
>
> Happy to set up a quick call to discuss which fits.
> ---

## The output

```
API Quota Utilization (current month)

ACCOUNT         QUOTA      USED MTD    %     PROJ EOM    DAYS-TO-CAP
megacorp       1.0M        982,400    98%    1.34M           0  ★ CRITICAL
innovate       500k        412,000    82%      562k           4  ★ UPSELL NOW
acme           100k         71,000    71%      96.9k           9     warm
globex         250k        142,000    57%      194k          22     ok

ACTIONS:
  ★ megacorp:    AE call TODAY — they will exceed cap tomorrow
                  Draft email above
  ★ innovate:    AE outreach this week — warm lead window
  ★ acme:        CSM heads-up message
    globex:      track for next month

REVENUE OPPORTUNITY:
  If all 3 upgrade to next tier, +$3,500-$6,000 MRR.
  Cost of waiting: customer hits 429, fires angry email, downgrades or churns.
```

## Setting it up

Two events needed:

**1. Every API call as an analytics event (sampling OK if volume is huge):**

```ts
// Existing, initialized official PostHog Node client in API middleware.
posthog.capture({
  distinctId: req.account.id,
  event: "api_call",
  properties: {
    account_id: req.account.id,
    endpoint: req.route.path,
  },
});
```

At high volume, prefer a source-proven aggregate or an explicitly reviewed
sampling rate. Record that rate as bounded metadata; do not silently multiply a
sample into an exact count.

**2. Quota changes (set or updated):**

```ts
posthog.capture({
  distinctId: account.id,
  event: "quota_set",
  properties: {
    account_id: account.id,
    api_quota_monthly: account.plan.quota,
    plan: account.plan.name,
  },
});
```

Run `agentry onboard` to review volume, route cardinality, and the exact quota
owner before adding either signal.

## Variations

- *"Same query for endpoint-level usage — which endpoints are the heaviest? Maybe there's a more efficient API to suggest."*
- *"Find accounts that hit 100% last month — did they upgrade, downgrade, or just absorb the 429s?"*
- *"For each over-cap account, compute the dollar value of their overage at the next tier's rate. Use it in the sales pitch."*
- *"On demand, list accounts that crossed 80% in the last 24h and draft a #sales-pipeline summary for human review."*
