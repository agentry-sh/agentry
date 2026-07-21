# Track engagement during enterprise POCs

Daily engagement per account for active POCs. Flag any account that has gone quiet for
3+ days so AEs can act.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Track engagement during enterprise POCs
description: >-
  Daily engagement per account for active POCs. Flag any account that has gone
  quiet for 3+ days so AEs can act.
category: growth
tags:
  - analytics
  - sales
  - enterprise
  - b2b
  - account-health
  - customer-success
prompt: >-
  I'm running 4 enterprise POCs. For each account, show daily event volume
  during the trial period. Flag any that have gone quiet for 3+ days.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - Events tagged with `account_id`
  - >-
    A way to mark accounts as 'POC' — either an `is_poc` property or a known
    list of account_ids
applies_to:
  - b2b-saas
  - enterprise-sales
requires_b2b: true
required_events:
  - feature_used
  - implementation_milestone
  - demo_completed
required_event_properties:
  feature_used:
    - account_id
    - is_poc
  implementation_milestone:
    - account_id
    - milestone
  demo_completed:
    - account_id
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
  - >-
    Do not recommend this when the product has no stable account or workspace
    identity.
  - >-
    Do not present illustrative custom analysis as a built-in query blueprint or
    runnable Agentry product surface.
ask_if_missing:
  - >-
    Which observed events map to feature_used, implementation_milestone,
    demo_completed? Are the required signals source-verified, and do live
    PostHog event/property reads show real traffic for them?
  - >-
    Which live properties provide feature_used.account_id, feature_used.is_poc,
    implementation_milestone.account_id, implementation_milestone.milestone,
    demo_completed.account_id, and which stable user or account identifier joins
    the signals?
related:
  - account-health-score
  - dormant-account-revival
  - trial-to-paid-conversion
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
example_only: true
```

</details>

## Why this matters

Sales-led POCs are won by paying attention. The AE running the POC is on 6 other deals at the same time and can't manually check whether each prospect is logging in. A POC that goes quiet on day 4 of a 14-day trial is almost certainly lost — but only if someone notices on day 4, not day 14.

Salesforce has POC tracking; nobody fills in the daily fields. Hubspot has "engagement score" but it counts emails, not product usage. The hot signal — "is the prospect actually opening the tool you sold them on?" — lives in your event database.

Agentry's one prompt: per-POC daily activity, ranked by trend, with red-flag callouts on accounts that stopped. AE walks into Monday standup with the call list pre-prioritized.

## What you get

- A per-POC daily activity chart for the active trial window
- A "red flag" list: POCs with no activity in 3+ days
- A "green flag" list: POCs accelerating week-over-week (close-ready)

## Walk through it

**You:**
> I'm running 4 enterprise POCs. For each account, show daily event volume during the trial period. Flag any that have gone quiet for 3+ days.

**Agent:**
> Which accounts? Should I look for `is_poc=true` on your events, or do you have a specific list?

**You:**
> List: acct_megacorp, acct_innovate, acct_scaleco, acct_bigfish. Trial started 12 days ago for all of them.

**Agent:**
> Pulling daily event volume per account for the last 12 days.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.account_id AS account, toDate(timestamp) AS day, count() AS events, uniq(distinct_id) AS users FROM events WHERE properties.account_id IN ('acct_megacorp','acct_innovate','acct_scaleco','acct_bigfish') AND event != '$exception' AND timestamp >= now() - INTERVAL 12 DAY GROUP BY account, day ORDER BY account, day"
```
```text
{
  "rows": [
    { "account": "acct_megacorp",  "day": "2026-05-04", "events": 412, "users": 14 },
    { "account": "acct_megacorp",  "day": "2026-05-05", "events": 380, "users": 12 },
    { "account": "acct_megacorp",  "day": "2026-05-06", "events": 88,  "users": 4  },
    { "account": "acct_megacorp",  "day": "2026-05-07", "events": 12,  "users": 2  },
    { "account": "acct_megacorp",  "day": "2026-05-08", "events": 0,   "users": 0  },
    { "account": "acct_megacorp",  "day": "2026-05-09", "events": 0,   "users": 0  },
    { "account": "acct_megacorp",  "day": "2026-05-10", "events": 0,   "users": 0  },
    { "account": "acct_innovate", "day": "2026-05-04", "events": 88,  "users": 4 },
    { "account": "acct_innovate", "day": "2026-05-12", "events": 612, "users": 9 },
    { "account": "acct_innovate", "day": "2026-05-13", "events": 880, "users": 11 }
  ]
}
```

**Agent:**
> Mixed picture. Status of all four POCs:
>
> - **megacorp** — Day 1-3 strong (~400 events), Day 4-5 tapering, **Day 6-12 = silence**. RED FLAG. Almost certainly lost; AE should call today.
> - **innovate** — Slow start, **accelerating: 88 → 880 events/day**. GREEN FLAG. Schedule the close call.
> - **scaleco** — (no rows shown but the agent has them) — flat, low-volume throughout. Probably the champion left.
> - **bigfish** — Steady 200-300/day, ~6 users active. Healthy but not exciting.
>
> This is a custom account-scoped engagement query, not a built-in public-query blueprint. I can put it in a protected internal view for the sales team. If you want a browser-safe public URL, I should first add a real query blueprint for active POC engagement and then publish that blueprint.

## The output

```
Active POCs — Day 12 of 14

RED FLAGS (3+ days silent)
  megacorp     Day 6-12: 0 events / 0 users
               Started strong (400/day), dropped Day 4, dead since Day 5
               AE action: call champion TODAY, find out what stopped

GREEN FLAGS (accelerating)
  innovate     Day 1-7:  ~80-200 events/day (exploring)
               Day 8-12: 600-900 events/day (operationalizing)
               AE action: schedule close call this week

STEADY
  bigfish      ~250 events/day, 6 active users
               AE action: continue scheduled check-ins

NEEDS DIAGNOSIS
  scaleco      <50 events/day throughout, 1 user
               AE action: champion likely disengaged — re-onboard or pivot

Protected internal view:
  /admin/agentry/poc-health
  ↳ Server-side Agentry read for the sales team unless/until a real active-POC query blueprint is added.
```

## Setting it up

Same instrumentation as `account-health-score`: every event needs `account_id`. The only POC-specific addition is marking the trial start so you know which window matters.

```ts
// Existing, initialized official PostHog Node client.
posthog.capture({
  distinctId: account.id,
  event: "poc_started",
  properties: {
    account_id: account.id,
    poc_owner_ae_id: owner.id,
    poc_duration_days: 14,
  },
});

posthog.capture({
  distinctId: user.id,
  event: "feature_used",
  properties: {
    account_id: user.workspace_id,
    is_poc: account.is_poc ?? false,
  },
});
```

If you do not want to instrument `is_poc`, pass a reviewed account-id list at
query time. Run `agentry onboard` to avoid placing customer names or salesperson
emails in telemetry when stable internal ids are sufficient.

## Variations

- *"For each POC, show which FEATURES they used most. Tells me what the demo should focus on at close."*
- *"Compare POC engagement curves of accounts that closed-won vs closed-lost last quarter. What patterns do winners show?"*
- *"On demand, list any POC with no activity yesterday and draft a #sales-pocs summary for review."*
- *"Prepare an AE-specific view with their accounts highlighted; let a human choose the recipients and sharing channel."*
