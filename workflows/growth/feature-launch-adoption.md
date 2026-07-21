# How fast was the new feature picked up?

Track time-to-first-use for a newly launched feature, split by trial vs paying user. The
2-week post-launch reality check.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: How fast was the new feature picked up?
description: >-
  Track time-to-first-use for a newly launched feature, split by trial vs paying
  user. The 2-week post-launch reality check.
category: growth
tags:
  - analytics
  - feature-adoption
  - launches
  - growth-loop
  - product
  - saas
prompt: >-
  We launched feature X two weeks ago. Track time-to-first-use per user cohort.
  Compare adoption among trial users vs paying customers.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - An event for the new feature use (e.g. `feature_x_used`)
  - A way to know each user's plan tier (`plan` property or paid-status event)
applies_to:
  - b2c-saas
  - b2b-saas
  - devtools-api
  - content-media
required_events:
  - report_export_v2_used
  - plan_changed
required_event_properties:
  report_export_v2_used:
    - feature
  plan_changed:
    - plan
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
ask_if_missing:
  - >-
    Which observed events map to report_export_v2_used, plan_changed? Are the required signals
    source-verified, and do live PostHog event/property reads show
    real traffic for them?
  - >-
    Which live properties provide report_export_v2_used.feature,
    plan_changed.plan, and which stable user or account identifier joins the
    signals?
related:
  - signup-funnel
  - activation-moment
  - expansion-prediction
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
```

</details>

## Why this matters

Every launch deserves an "is anyone actually using this?" check at the 2-week mark. Most teams don't run it because:

- The PM moved on to the next thing
- The dashboard didn't get built
- The launch metrics doc has "TBD" next to the adoption numbers

Two weeks is the right window. Day 1 numbers are launch-day spikes (curiosity). Day 30 numbers are too late to course-correct. Day 14 is where you see what fraction of your active users actually integrated the feature into their workflow.

The richer cut is by **plan tier**: a feature that's adopted by 60% of trial users but 5% of paying customers is fundamentally a wrong-target launch. The reverse — high paid adoption but low trial — means it's not on the activation path and you might want it to be.

Agentry produces both cuts in one prompt.

## What you get

- A time-to-first-use distribution (p50, p90 days from launch to first use, per cohort)
- A "% who tried it" by cohort (trial vs paid) — the headline number
- Bonus: a "do users come back?" indicator — % who used it twice within the first week

## Walk through it

**You:**
> We launched `report_export_v2` two weeks ago (2026-05-02). Track time-to-first-use per user cohort. Compare adoption among trial users vs paying customers.

**Agent:**
> Two queries: time-to-first-use distribution, then split by plan.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "WITH first_use AS (SELECT distinct_id, min(timestamp) AS first_used_ts FROM events WHERE event = 'report_export_v2_used' AND timestamp >= toDateTime('2026-05-02') GROUP BY distinct_id), eligible AS (SELECT DISTINCT distinct_id, argMax(properties.plan, timestamp) AS plan FROM events WHERE timestamp >= toDateTime('2026-04-20') AND timestamp < toDateTime('2026-05-02') GROUP BY distinct_id) SELECT CASE WHEN e.plan IN ('free','trial') THEN 'trial' ELSE 'paid' END AS cohort, count(DISTINCT e.distinct_id) AS eligible_users, count(DISTINCT fu.distinct_id) AS adopters, round(count(DISTINCT fu.distinct_id) * 100.0 / count(DISTINCT e.distinct_id), 1) AS adoption_pct, round(median(dateDiff('day', toDateTime('2026-05-02'), fu.first_used_ts))) AS p50_days, round(quantile(0.9)(dateDiff('day', toDateTime('2026-05-02'), fu.first_used_ts))) AS p90_days FROM eligible e LEFT JOIN first_use fu ON e.distinct_id = fu.distinct_id GROUP BY cohort"
```
```text
{
  "rows": [
    { "cohort": "trial", "eligible_users": 1840, "adopters": 88,  "adoption_pct": 4.8,  "p50_days": 7, "p90_days": 12 },
    { "cohort": "paid",  "eligible_users": 412,  "adopters": 168, "adoption_pct": 40.8, "p50_days": 3, "p90_days": 9 }
  ]
}
```

**Agent:**
> Paid users grabbed this hard, trials barely touched it:
>
> | Cohort | Eligible | Adopters | Adoption % | p50 days | p90 days |
> |--------|---------:|---------:|-----------:|---------:|---------:|
> | paid   | 412      | 168      | **40.8%**  | 3        | 9        |
> | trial  | 1,840    | 88       | 4.8%       | 7        | 12       |
>
> 40% paid adoption in 2 weeks is exceptional. 5% trial adoption suggests the feature isn't being surfaced in the trial UX — or it's an advanced feature that trial users haven't gotten to yet.
>
> Repeat-use check (did they come back?):

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "WITH usage AS (SELECT distinct_id, count() AS times_used FROM events WHERE event = 'report_export_v2_used' AND timestamp >= toDateTime('2026-05-02') GROUP BY distinct_id) SELECT countIf(times_used = 1) AS used_once, countIf(times_used >= 2) AS used_twice_plus, round(countIf(times_used >= 2) * 100.0 / count(), 1) AS repeat_rate_pct FROM usage"
```
```text
{ "rows": [{ "used_once": 88, "used_twice_plus": 168, "repeat_rate_pct": 65.6 }] }
```

**Agent:**
> 66% of users who tried it used it again within 2 weeks. That's strong sticky-use, supports the "this is real value" story.
>
> Recommendation: ship a trial-onboarding tour highlighting `report_export_v2`. The paid adoption shows it's a real feature; the trial gap is a discovery problem, not a value problem.

## The output

```
Feature Launch: report_export_v2 (launched 2026-05-02, T+14d)

ADOPTION BY COHORT
                  ELIGIBLE   ADOPTERS   ADOPTION%   p50 d   p90 d
   paid                412        168       40.8%       3       9   ★ strong
   trial             1,840         88        4.8%       7      12   ✗ low

REPEAT USE (paid + trial combined)
   used 1x                          88   34%   one-time tryouts
   used 2+ times                   168   66%   sticky use   ★

INSIGHTS:
  ★ Paid adoption (40%) in 2 weeks is excellent — strong feature/value fit
  ★ Repeat rate (66%) confirms sticky, not novelty
  ✗ Trial adoption (4.8%) suggests a discovery problem
        Likely fix: add to trial onboarding tour, surface in empty states

NEXT EXPERIMENT:
  In-product tour highlight for trial users → measure adoption lift in 2 weeks
```

## Setting it up

The workflow needs one event per feature use (which you'd presumably ship alongside the feature anyway):

```ts
// Wherever the user invokes the new feature:
async function exportReportV2(account: Account, format: "csv" | "pdf") {
  // ... actual export logic
  posthog.capture({
    distinctId: account.primary_user_id,
    event: "report_export_v2_used",
    properties: {
      account_id: account.id,
      plan: account.plan,
      format,
    },
  });
}
```

This illustrates an existing official PostHog Node client. Capture only after
the export succeeds, then run `agentry onboard` to verify that exact boundary.

The `plan` property on the event is what lets the agent split by cohort without a separate join. If you don't have it, the agent can also derive it from a recent `plan_changed` event per user — but inline is cleaner.

For the eligibility cohort ("users active in the 2 weeks BEFORE launch"), no extra setup — the agent reads existing event history.

## Variations

- *"Same workflow but for `dashboard_v3_used` — we launched the redesign last month. Compare to the old dashboard adoption curve."*
- *"Show adoption by company size (small / mid / enterprise) instead of plan tier."*
- *"Adoption by acquisition source — do Product Hunt users grab new features faster?"*
- *"Compare this launch's adoption curve to our last 3 launches. Are we accelerating or losing pace?"*
