# Who's still on the old client?

Distinct users per app_version over 7 days. See the long tail of old clients — informs
the force-update decision and deprecation timing.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Who's still on the old client?
description: >-
  Distinct users per app_version over 7 days. See the long tail of old clients —
  informs the force-update decision and deprecation timing.
category: ops
tags:
  - analytics
  - mobile-app
  - app-version
  - releases
  - ops
prompt: >-
  Show me distinct users per app_version in the last 7 days. What % are still on
  N-2 or older? Worth a force-update?
difficulty: beginner
time_to_value: 1 minute
prereqs:
  - >-
    Analytics events flowing with `app_version` (e.g. on `app_open` /
    `session_start`)
  - Stable `distinct_id` per user (so distinct-user counts are meaningful)
applies_to:
  - mobile-app
required_events:
  - app_open
required_event_properties:
  app_open:
    - app_version
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
    Which observed events map to app_open? Are the required signals
    source-verified, and do live PostHog event/property reads show real traffic for
    them?
  - >-
    Which live properties provide app_open.app_version, and which stable user or
    account identifier joins the signals?
related:
  - crash-free-user-rate
  - deploy-regression
  - cdn-asset-404s
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
example_only: true
```

</details>

## Why this matters

Old mobile clients are a slow-moving operational tax:

- They hit endpoints you've already deprecated, forcing you to maintain shims
- They crash on patterns you've already fixed, dragging your aggregate crash-free metric down
- They miss the security fix you shipped last quarter
- They prevent you from removing legacy fields from your API contract

The fix is usually a force-update prompt — but you can't make that call without knowing the population. Force-updating 80% of your users is a PR disaster. Force-updating 4% is a Tuesday.

Agentry gives you the distribution in one query: distinct users per version over a 7-day window. The N-2-or-older percentage tells you whether the force-update is now or later.

## What you get

- Per-version distinct user count and rollout share
- N-2-and-older count and percentage — the "force update" candidate population
- Dashboard rows for the mobile/ops team to pull up at release planning

## Walk through it

**You:**
> Show me distinct users per app_version in the last 7 days. What % are still on N-2 or older?

**Agent:**
> Distinct users grouped by version, then a tail sum.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "
    select
      properties.app_version as ver,
      count(distinct distinct_id) as users
    from events
    where event = 'app_open'
      and timestamp > now() - interval 7 day
    group by ver
    order by ver desc
  "
```
```text
{
  "rows": [
    { "ver": "4.2.0",  "users":  68420 },
    { "ver": "4.1.3",  "users": 142100 },
    { "ver": "4.1.2",  "users":  61880 },
    { "ver": "4.1.1",  "users":  18340 },
    { "ver": "4.0.5",  "users":   8400 },
    { "ver": "4.0.4",  "users":   2300 },
    { "ver": "3.9.2",  "users":   1840 },
    { "ver": "3.8.1",  "users":    420 }
  ]
}
```

**Agent:**
> Now the rollup. Latest is 4.2.0, so "N-2 or older" means anything below 4.1.3.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "
    with d as (
      select properties.app_version as ver,
        count(distinct distinct_id) as users
      from events
      where event = 'app_open' and timestamp > now() - interval 7 day
      group by ver
    )
    select
      sum(users) as total_users,
      sumIf(users, ver >= '4.1.3') as latest_or_n_minus_1,
      sumIf(users, ver <  '4.1.3') as n_minus_2_or_older
    from d
  "
```
```text
{
  "rows": [
    { "total_users": 303700, "latest_or_n_minus_1": 210520, "n_minus_2_or_older": 93180 }
  ]
}
```

**Agent:**
> Distribution:
>
> - **Latest or N-1 (4.1.3+):** 210,520 (69%)
> - **N-2 or older (≤ 4.1.2):** 93,180 (31%)
> - **3.x:** 2,260 (0.7%) — these are the truly ancient
>
> 31% on N-2-or-older is borderline. A force-update right now would inconvenience ~93k users. If your `4.0.x` cohort is missing a security fix you've shipped, do it. If they're just missing a UI refresh, wait one more release.
>
> Worth a separate look: the 1,840 users on `3.9.2`. Those are 18 months stale. Force-update those specifically with a one-time prompt is usually low-PR-risk.
>
> Let me prepare the dashboard rows.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "<first query above>"
```
```text
{ "rows": [/* dashboard rows */], "row_count": 10 }
```

## The output

```
App version distribution (7d distinct users)

Version    Users      Share    Cumulative
─────────────────────────────────────────────
4.2.0       68,420   22.5%     22.5%       ← current
4.1.3      142,100   46.8%     69.3%       ← N-1
4.1.2       61,880   20.4%     89.7%       ← N-2 ★ force-update candidate
4.1.1       18,340    6.0%     95.7%
4.0.5        8,400    2.8%     98.5%
4.0.4        2,300    0.8%     99.3%
3.9.2        1,840    0.6%     99.9%       ★ 18 months stale
3.8.1          420    0.1%    100.0%       ★ ancient — force update

Recommended:
  - Force-update 3.x users now (low PR risk, ~2,260 users)
  - Wait one more release before force-updating 4.0.x
  - Re-run on demand when the latest version reaches >40% adoption

Public view:
  Use Agentry's returned public_url after publishing a real query blueprint.
```

## Setting it up

You only need `app_version` on a regular event — typically `app_open` or `session_start`:

Use the repository's installed official PostHog Android or iOS SDK to capture
`app_open` at the reviewed cold-start boundary with `app_version`, `platform`,
and `os_version`. SDK signatures differ by platform, so this workflow does not
invent a shared mobile helper. Run `agentry onboard` to review the actual calls,
stable identity, and standard properties in the connected PostHog project.

## Variations

- *"Same query split by platform — iOS adopters tend to update faster than Android."*
- *"Per-country distribution — emerging markets have older OS versions and slower updates."*
- *"Show me the adoption curve of v4.2.0 day-by-day since release. Is it tracking last release's curve?"*
- *"Compare crash-free rate of users on N-2 vs latest — are old-clients-still-using-the-API hitting issues that newer ones don't?"*
