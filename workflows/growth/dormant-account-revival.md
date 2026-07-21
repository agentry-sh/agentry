# Find quiet paying accounts before they churn

List paying accounts with zero events in 14 days. Sort by ARR. Get personalized outreach
drafted in one prompt.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Find quiet paying accounts before they churn
description: >-
  List paying accounts with zero events in 14 days. Sort by ARR. Get
  personalized outreach drafted in one prompt.
category: growth
tags:
  - analytics
  - churn
  - early-warning
  - retention
  - b2b
  - customer-success
prompt: >-
  List paying accounts with zero events in the last 14 days that haven't
  canceled. Sort by ARR. Draft me an outreach email per top-5.
difficulty: intermediate
time_to_value: 2 minutes
prereqs:
  - Events tagged with `account_id` and a paid-tier signal (`plan` or `mrr`)
  - >-
    Cancellation event (`subscription_canceled`) to exclude already-churned
    accounts
applies_to:
  - b2b-saas
  - devtools-api
requires_revenue: true
requires_b2b: true
required_events:
  - subscription_canceled
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
    Which observed events map to subscription_canceled? Are the required signals
    source-verified, and do live PostHog event/property reads show
    real traffic for them?
related:
  - churn-prediction
  - churn-survey
  - account-health-score
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
```

</details>

## Why this matters

Paying customers who stop logging in are 60-90 days from cancellation. The CS-team folklore number is "if a paid account goes 14 days without activity, they're 4-5x more likely to churn at renewal." Saving them requires noticing within those 14 days.

Almost no SaaS company does. The list-of-quiet-accounts query is doable in BigQuery if you have a data team, exists buried in Mixpanel under "RFM analysis," or requires you to install ChartMogul + connect Stripe + pay $200/mo. So nobody does it weekly.

Agentry makes the question one prompt. The agent runs the query, ranks by ARR, looks at the last activity each account had, and drafts a per-account email — no template-y "we miss you" — referencing what they were actually doing.

## What you get

- List of paid accounts with **0 events in last 14 days** (or your threshold), excluding canceled
- Sorted by **ARR** so CS time goes to highest-impact accounts first
- A draft email for the top 5, personalized to what they were last doing before going quiet

## Walk through it

**You:**
> List paying accounts with zero events in the last 14 days that haven't canceled. Sort by ARR. Draft me an outreach email per top-5.

**Agent:**
> Let me query dormant paying accounts first.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "WITH paid AS (SELECT properties.account_id AS aid, argMax(properties.plan, timestamp) AS plan, argMax(properties.mrr, timestamp) AS mrr FROM events WHERE event IN ('plan_changed','seat_count_set','subscription_started') GROUP BY aid HAVING mrr > 0), canceled AS (SELECT DISTINCT properties.account_id AS aid FROM events WHERE event = 'subscription_canceled'), activity AS (SELECT properties.account_id AS aid, max(timestamp) AS last_event_ts FROM events WHERE event != '$exception' GROUP BY aid) SELECT p.aid AS account, p.plan AS plan, p.mrr AS mrr, a.last_event_ts AS last_event_ts, dateDiff('day', a.last_event_ts, now()) AS days_quiet FROM paid p LEFT JOIN activity a ON p.aid = a.aid WHERE p.aid NOT IN (SELECT aid FROM canceled) AND (a.last_event_ts < now() - INTERVAL 14 DAY OR a.last_event_ts IS NULL) ORDER BY p.mrr DESC LIMIT 20"
```
```text
{
  "rows": [
    { "account": "megacorp",  "plan": "enterprise", "mrr": 5000, "days_quiet": 18 },
    { "account": "globex",    "plan": "scale",      "mrr": 1875, "days_quiet": 22 },
    { "account": "scaleco",   "plan": "scale",      "mrr": 1875, "days_quiet": 15 },
    { "account": "midmarket", "plan": "pro",        "mrr": 750,  "days_quiet": 31 },
    { "account": "smallpaid", "plan": "starter",    "mrr": 250,  "days_quiet": 16 }
  ]
}
```

**Agent:**
> Top dormant account is megacorp — $5,000/mo, quiet for 18 days. Let me look at what they were last doing.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Query/filter concept:
  query: "SELECT event, count() AS events FROM events WHERE properties.account_id = '<source_verified_account_id>' AND timestamp >= now() - INTERVAL 44 DAY AND timestamp < now() - INTERVAL 14 DAY GROUP BY event ORDER BY events DESC LIMIT 20"
```
```text
{
  "rows": [
    { "event": "api_call", "events": 3200 },
    { "event": "dashboard_view", "events": 640 },
    { "event": "report_generated", "events": 88 },
    { "event": "team_member_invited", "events": 4 }
  ],
  "row_count": 4,
  "freshness": { "source": "customer_posthog_cloud_hogql" }
}
```

**Agent:**
> Megacorp's verified account-level activity was concentrated in API and report
> events before the quiet period. The data does not identify a cause; PTO, a
> completed project, a tracking gap, or tool replacement are hypotheses. Draft
> for human review:
>
> ---
>
> **To:** sarah@megacorp.com
> **Subject:** Quick check-in
>
> Hi Sarah,
>
> Noticed your team's been pretty quiet on Agentry the past couple weeks — usually you and the engineering team are running 200+ API calls a day, and that's dropped to zero. Wanted to make sure nothing's blocking you (or that you haven't been away on a project).
>
> If there's something we can help unblock — or if you've moved to a different tool and want to talk through it — happy to jump on a call this week.
>
> Best,
> [your CSM]
>
> ---
>
> Want me to do the same for the other four?

## The output

```
Dormant Paying Accounts (>14 days quiet, not canceled, top by ARR)

ACCOUNT     PLAN         MRR     LAST ACTIVITY    PRIMARY USER
megacorp    enterprise   $5,000  18 days ago      sarah@megacorp.com
globex      scale        $1,875  22 days ago      ops@globex.co
scaleco     scale        $1,875  15 days ago      multiple
midmarket   pro          $750    31 days ago      one user — gone?
smallpaid   starter      $250    16 days ago      founder@smallpaid.io

Total ARR dormant: $9,750/mo ($117k/yr at risk)

DRAFT EMAILS:
  → megacorp (sarah@): "noticed your team's been quiet — API was 200+/day"
  → globex (ops@):    "your monthly report cycle hasn't run yet — anything we can help with?"
  → scaleco:           "team dispersed — would a quick 1:1 with each user help?"
  → midmarket:         "no activity for 31d — should we pause your sub temporarily?"
  → smallpaid:         "low-touch nudge — share new feature X"
```

## Setting it up

Same instrumentation as `account-health-score`: every event needs `account_id` and you need an MRR-or-plan signal per account. Then the SQL just composes a `paid ∩ not_canceled ∩ not_active` set.

```ts
// Existing, initialized official PostHog Node client.
posthog.capture({
  distinctId: user.id,
  event: "report_generated",
  properties: { account_id: user.workspace_id, report_type: "monthly" },
});

posthog.capture({
  distinctId: subscription.metadata.account_id,
  event: "subscription_canceled",
  properties: {
    account_id: subscription.metadata.account_id,
    reason: subscription.cancellation_details?.reason,
  },
});
```

Run `agentry onboard` to source-verify the activity and cancellation owners and
to bound the cancellation-reason taxonomy.

Why exclude canceled accounts? They're a different workstream (winback campaigns, not save campaigns) and would dilute the priority list.

## Variations

- *"Run the same query for trial accounts — who's mid-trial and gone silent? Probably abandoning."*
- *"Find accounts that were active last quarter but completely silent this quarter. Slower-burn churn."*
- *"For each dormant account, also pull any support tickets from the last 30 days — context for the outreach."*
- *"Weekly cron Monday 9am: post the previous week's new-dormant accounts to #cs-pulse."*
