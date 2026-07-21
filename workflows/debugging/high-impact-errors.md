# Rank errors by revenue impact, not raw count

Multiply users-affected by their plan ARR to surface the bugs costing real money. Stop
triaging by event volume.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: 'Rank errors by revenue impact, not raw count'
description: >-
  Multiply users-affected by their plan ARR to surface the bugs costing real
  money. Stop triaging by event volume.
category: debugging
tags:
  - errors
  - revenue
  - triage
  - account-health
  - b2b
  - saas
  - sentry-alternative
prompt: >-
  Show me open cases ranked by dollars-at-risk. For each, multiply
  users_affected by their plan ARR. Top 5.
difficulty: intermediate
time_to_value: 2 minutes
prereqs:
  - >-
    PostHog exceptions and analytics use the same stable, privacy-reviewed user
    identity
  - >-
    Either a `plan` property on analytics events, or a plan-tier event your
    account can join on
applies_to:
  - b2c-saas
  - b2b-saas
  - devtools-api
  - ecommerce
  - marketplace
  - enterprise-sales
required_events:
  - $exception
  - plan_changed
required_event_properties:
  $exception:
    - fingerprint
  plan_changed:
    - plan
    - mrr
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
ask_if_missing:
  - >-
    Which observed events map to $exception, plan_changed? Are the required signals
    source-verified, and do live PostHog event/property reads show
    real traffic for them?
  - >-
    Which live properties provide $exception.fingerprint, plan_changed.plan,
    plan_changed.mrr, and which stable user or account identifier joins the
    signals?
related:
  - customer-investigation
  - silent-bugs
  - account-health-score
featured: false
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
```

</details>

## Why this matters

Count-based triage is a trap. The loudest fingerprint in your error tracker is usually a cron loop hitting a stale row 5,000 times an hour — annoying, low-impact, fixable Tuesday.

Meanwhile the bug that three Pro accounts hit during checkout — twice each, total of 6 events — generated 80% of the revenue risk in that window. Sentry sorts it 80th on the list. You won't see it until those three accounts churn.

The fix is to weight every error by the affected user's plan value. Datadog won't do this. Sentry won't do this. The combination of error data + analytics data lives in one place in Agentry, so the agent can JOIN them in a single HogQL query and rank by dollars-at-risk instead of dumb count.

## What you get

- Top 5 open cases ranked by **estimated ARR-at-risk** (users-affected × per-user ARR)
- For the #1 case: the specific accounts involved, with their plan tiers
- A suggestion for who at your company should call those customers today

## Walk through it

**You:**
> Show me open cases ranked by dollars-at-risk. For each, multiply users_affected by their plan ARR. Top 5.

**Agent:**
> Let me pull open cases with their affected user lists, then join against the latest `plan` value per user.

```text
Endpoint: GET /v1/projects/:project_id/cases
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fcases&method=get
Use query parameters, not a JSON body.
Query/filter concept:
  status: "open",
  since: "14d",
  include_affected_distinct_ids: true,
  limit: 25
```
```text
{
  "cases": [
    { "id": "c_f72a", "message": "TypeError on user.plan", "users_affected": 14,
      "event_count": 89, "distinct_ids": ["alice@acme.com", "bob@globex.co", "..."] },
    { "id": "c_1cd9", "message": "fetch failed: invoice.pdf", "users_affected": 9,
      "event_count": 11, "distinct_ids": ["..."] },
    { "id": "c_2d8e", "message": "checkout 500: stripe webhook timeout", "users_affected": 3,
      "event_count": 6, "distinct_ids": ["bigco@enterprise.com", "scale@series-b.io", "..."] }
  ]
}
```

**Agent:**
> Now let me join the affected distinct_ids against current plan tier.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT distinct_id, argMax(properties.plan, timestamp) AS plan FROM events WHERE distinct_id IN ({ids}) GROUP BY distinct_id",
  params: { ids: ["alice@acme.com", "bob@globex.co", "bigco@enterprise.com", "scale@series-b.io", "..."] }
```
```text
{
  "rows": [
    { "distinct_id": "alice@acme.com", "plan": "free" },
    { "distinct_id": "bob@globex.co", "plan": "starter" },
    { "distinct_id": "bigco@enterprise.com", "plan": "enterprise" },
    { "distinct_id": "scale@series-b.io", "plan": "scale" }
  ]
}
```

**Agent:**
> Ranked by ARR-at-risk (assuming starter=$300, scale=$3,000, enterprise=$30,000):
>
> 1. **`c_2d8e` — checkout 500 on Stripe webhook timeout — $63,000 ARR at risk**
>    Only 6 events but it's hitting 2 enterprise + 1 scale account. This is your #1.
> 2. **`c_f72a` — TypeError on user.plan — $4,200 ARR**
>    14 users but 11 are on free tier (the bug literally fires on the free-tier path).
> 3. **`c_1cd9` — invoice PDF fetch — $2,700 ARR**
>    9 users, mostly starter.
>
> The numbers flip completely. `c_2d8e` is 15x more important than `c_f72a` by revenue, but raw count says the opposite. Want me to pull the case detail on `c_2d8e` and draft a Slack message to whoever owns Stripe?

## The output

```
Top 5 cases by ARR-at-risk (14d, open)

$63,000   c_2d8e   checkout 500: stripe webhook timeout
                   3 users  · 6 events
                   Affected: bigco@enterprise.com (enterprise $30k),
                             scale@series-b.io (scale $3k),
                             ops@megacorp.com (enterprise $30k)
                   ↗ Owner: @stripe-oncall — investigate webhook latency

 $4,200   c_f72a   TypeError on user.plan (free-tier path)
                   14 users · 89 events · mostly free tier
                   ↗ Low ARR, but fixable in 4 lines

 $2,700   c_1cd9   invoice.pdf fetch failed
                   9 users · 11 events · mixed plans
                   ↗ Probably CORS regression on invoice-service

   $600   c_a3e1   phone validation NANP-only
                   7 users · 14 events · all starter
                   ↗ Low priority unless we want international growth

   $300   c_4f01   pagination edge case
                   2 users · 3 events · starter
                   ↗ Easy fix, ship next sprint

Net ARR at risk: $70,800
```

## Setting it up

The workflow joins PostHog Error Tracking issues with analytics properties such
as the customer's `plan` and `mrr`. Configure the existing official PostHog SDK
so analytics and exceptions use the same stable, privacy-reviewed identity.

For an illustrative initialized Node client, a product event may look like:

```ts
posthog.capture({
  distinctId: currentUser.id,
  event: "feature_used",
  properties: { plan: currentUser.plan, mrr: currentUser.mrr },
});
```

Use the installed SDK's official exception integration with that same identity;
do not fabricate a generic exception API.

If you don't track `plan` on every event, an alternative is to fire a one-shot `plan_changed` event whenever it changes — the HogQL `argMax(properties.plan, timestamp)` pattern picks up the latest value either way.

## Variations

- *"Same ranking, but only count enterprise customers (plan = 'enterprise')."*
- *"Show errors ranked by ARR-at-risk over the last 24 hours, not 14 days. Daily oncall summary."*
- *"For the top case, draft a per-customer outreach email apologizing and offering credit."*
- *"Run this on demand for the last business day and draft the top three for an authorized CS reviewer; do not expose affected emails automatically."*
