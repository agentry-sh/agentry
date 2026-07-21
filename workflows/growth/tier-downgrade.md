# Why did this account drop from pro to free?

Find accounts that downgraded in the last 30 days and compare their behavior before vs
after. The soft-churn signal nobody tracks.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Why did this account drop from pro to free?
description: >-
  Find accounts that downgraded in the last 30 days and compare their behavior
  before vs after. The soft-churn signal nobody tracks.
category: growth
tags:
  - analytics
  - churn
  - downgrade
  - b2b
  - retention
  - cohorts
prompt: >-
  List paid accounts that downgraded in the last 30 days. For each, compare
  their behavior in the 30 days before vs after the downgrade.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - >-
    Events for `plan_changed` (or `subscription_updated`) capturing from_plan +
    to_plan
  - 30+ days of event history per user (so 'before/after' is meaningful)
applies_to:
  - b2b-saas
  - b2c-saas
  - devtools-api
requires_revenue: true
required_events:
  - subscription_downgraded
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
  - >-
    Do not recommend this for products without a real revenue lifecycle or an
    equivalent paid-account signal.
ask_if_missing:
  - >-
    Which observed events map to subscription_downgraded? Are the required signals
    source-verified, and do live PostHog event/property reads show
    real traffic for them?
related:
  - churn-prediction
  - churn-survey
  - dormant-account-revival
updatedAt: 2026-07-20T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
```

</details>

## Why this matters

Downgrade is the soft-churn signal nobody tracks. Cancellation gets a workflow (exit survey, save-offer email, CS call). Downgrade just happens silently in the Stripe dashboard — they stop paying you $300/mo and start paying you $0/mo, and you find out next quarter when MRR breaks down.

A downgrade is a useful retention signal because the account still exists, but
behavioral changes do not reveal the reason by themselves. Product usage,
seasonality, team changes, correct right-sizing, or instrumentation changes can
produce the same pattern.

Agentry can run a bounded before/after comparison against the connected
PostHog project without creating a cohort or mutating account state. The result
is evidence for a human review, not an automatic outreach decision.

## What you get

- A list of accounts that downgraded in the last 30 days, with `from_plan → to_plan`
- For each: top events that **decreased the most** between equal pre and post
  windows, with incomplete windows marked explicitly
- A CS-review summary that separates observations, hypotheses, and missing
  evidence

## Walk through it

**You:**
> List paid accounts that downgraded in the last 30 days. For each, compare their behavior in the 30 days before vs after the downgrade.

**Agent:**
> I will first verify the plan-transition boundary and required properties,
> then identify recent downgrades with a bounded PostHog read.

```http
GET /v1/projects/:project_id/signal-map
GET /v1/projects/:project_id/onboarding
GET /v1/projects/:project_id/event-property-keys?events=plan_changed
```

If the transition or stable account join is not `source_verified`, stop and
name the source, deploy, property, or traffic evidence still required.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT distinct_id, properties.from_plan AS from_plan, properties.to_plan AS to_plan, timestamp AS event_ts FROM events WHERE event = 'plan_changed' AND properties.from_plan_rank > properties.to_plan_rank AND timestamp >= now() - INTERVAL 30 DAY ORDER BY event_ts DESC"
```
```text
{
  "rows": [
    { "distinct_id": "team-acme",     "from_plan": "pro",        "to_plan": "free",    "event_ts": 1747100000 },
    { "distinct_id": "team-globex",   "from_plan": "scale",      "to_plan": "pro",     "event_ts": 1746950000 },
    { "distinct_id": "team-megacorp", "from_plan": "enterprise", "to_plan": "scale",   "event_ts": 1746800000 },
    { "distinct_id": "team-tinyco",   "from_plan": "starter",    "to_plan": "free",    "event_ts": 1746700000 }
  ]
}
```

**Agent:**
> Four downgrades were observed. I will compare product behavior around each
> exact transition inside another bounded read. No PostHog cohort or user
> profile is created or changed.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Query plan:
  - bind each selected downgrade to its exact event timestamp and account identifier
  - count approved product-value events in the 30 days before and after that timestamp
  - report post_days_observed and mark any post window shorter than 30 days as partial
  - compare equal completed windows or normalized daily rates; never compare unequal raw totals
  - return only the bounded selected accounts and aggregate event counts
```
```text
{
  "rows": [
    {
      "account_id": "team-acme",
      "event": "api_call",
      "pre_count": 1240,
      "post_count": 4,
      "post_days_observed": 30,
      "window_status": "complete"
    }
  ]
}
```

**Agent:**
> Acme's bounded history shows a strong change, but not its cause:
>
> - **API calls fell from 1,240 → 4** (-99%) across the equal windows.
> - **Dashboard views fell from 480 → 200** across equal 30-day windows. The account still had observed product activity.
> - **Team invites fell from 12 → 0.** This does not prove that the team shrank.
>
> One hypothesis is that an API-dependent project ended. Other explanations
> include correct right-sizing, seasonality, identity loss, or an instrumentation
> change. A CS owner should review account context before deciding whether any
> outreach is appropriate.
>
> Want me to do the same analysis for the other three?

## The output

```
Downgrades (last 30d) — pre vs post behavior analysis

team-acme         Pro → Free       ($300/mo lost)
  ↓ api_call:               1240 → 4    (-99.7%)  ★ THE STORY
  ↓ team_member_invited:      12 → 0    (-100%)
  ↓ dashboard_view:          480 → 200  (still showing up)
  ↓ report_exported:          88 → 12
  Hypothesis: an API-dependent project ended; verify with account context.
  Human decision: review | no action | approved outreach through the normal CS process

team-globex       Scale → Pro      ($1,800/mo retained, $1,200/mo lost)
  ↓ workflow_executed:    14,200 → 4,100  (-71%)
  Observation: workflow volume fell.
  Hypothesis: the account may have right-sized; do not infer satisfaction.

team-megacorp     Enterprise → Scale  ($27k/mo lost)  ★ URGENT
  ↓ admin_action:        220 → 12   (-95%)
  ↓ team_member_invited:  24 → 0
  Observation: admin activity collapsed.
  Hypothesis: champion or team change; verify before any outreach.

team-tinyco       Starter → Free   ($60/mo lost)
  ↓ all events:           220 → 18   (-92%)
  Observation: broad activity fell.
  Hypothesis: dormancy or a project ending; no automatic action.

CAVEATS:
  - A recent downgrade can have an incomplete post window; mark it partial.
  - Usage changes do not prove why the account downgraded.
  - Do not contact an account from this evidence without human review.
```

## Setting it up

The workflow needs one event class — `plan_changed` — fired from your Stripe webhook handler whenever a subscription changes tier. Include both `from_plan` and `to_plan`, and a numeric `plan_rank` so the agent can detect "down" without hard-coding tier names:

```ts
// In your Stripe webhook handler for `customer.subscription.updated`
const PLAN_RANK: Record<string, number> = {
  free: 0,
  starter: 1,
  pro: 2,
  scale: 3,
  enterprise: 4,
};

if (oldPriceId !== newPriceId) {
  const from_plan = planNameFromPrice(oldPriceId);
  const to_plan = planNameFromPrice(newPriceId);

  posthog.capture({
    distinctId: subscription.metadata.account_id,
    event: "plan_changed",
    properties: {
      from_plan,
      to_plan,
      from_plan_rank: PLAN_RANK[from_plan],
      to_plan_rank: PLAN_RANK[to_plan],
      mrr_delta: (newPriceCents - oldPriceCents) / 100,
    },
  });
}
```

This illustrates an existing official PostHog Node client at the verified
billing-webhook transition. Run `agentry onboard` to preserve the customer's
current plan taxonomy and prove the source boundary.

For the before/after windows to work, you need at least 30 days of event history for each downgraded account. If you only started instrumenting last week, this workflow gets useful in ~3-4 weeks.

## Variations

- *"For each downgrade, also show the SUPPORT tickets they opened in the 30 days before. Was there a known frustration?"*
- *"Of the accounts that downgraded last quarter, how many fully canceled within 90 days? That's our 'downgrade → churn' conversion rate."*
- *"Build the inverse — accounts that UPGRADED. What behaviors increased?"* (see `expansion-prediction`)
- *"Review the previous week's downgrades on demand and draft a diagnosis for a CS lead to share if appropriate."*
