# Mobile background-sync failure monitoring

Background sync, refresh, prefetch jobs fail silently and degrade UX. Group failures by
task_name and network_type to find the patterns.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Mobile background-sync failure monitoring
description: >-
  Background sync, refresh, prefetch jobs fail silently and degrade UX. Group
  failures by task_name and network_type to find the patterns.
category: debugging
tags:
  - errors
  - mobile-app
  - background-jobs
  - oncall
  - infra
prompt: >-
  Are background tasks (sync, refresh, prefetch) failing more often this week?
  Group by task_name and network_type (wifi vs cellular).
difficulty: intermediate
time_to_value: 2 minutes
prereqs:
  - >-
    Mobile background tasks report failures through the existing official
    PostHog SDK with `task_name`,
    `network_type`, `app_version`
  - At least 7 days of data so week-over-week comparison is meaningful
applies_to:
  - mobile-app
required_events:
  - background_task_started
  - background_task_failed
required_event_properties:
  background_task_started:
    - task_name
    - network_type
    - app_version
  background_task_failed:
    - task_name
    - network_type
    - app_version
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
ask_if_missing:
  - >-
    Which observed events map to background_task_started,
    background_task_failed? Are the required signals source-verified, and do
    live PostHog event/property reads show real traffic for them?
  - >-
    Which live properties provide task_name, network_type, and app_version on
    both background-task events, and which stable user or account identifier
    joins them?
related:
  - crash-free-user-rate
  - rate-limit-spikes
  - db-pool-exhaustion
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
```

</details>

## Why this matters

Background failures are the worst kind of bug: invisible until the user notices the symptom. The sync didn't run. The image prefetch failed. The token refresh silently expired. The user opens the app, sees stale data, and uninstalls. No crash, no error report — just a slow drip of churn.

These bugs cluster around two dimensions:

1. **`task_name`**: which job is failing (`sync_messages`, `prefetch_images`, `refresh_token`, `upload_pending`)
2. **`network_type`**: wifi-vs-cellular reveals timeout-tuning bugs and DNS-fallback misses

Grouping by both is the diagnostic. "All `sync_messages` on cellular" → cellular timeout is too aggressive. "All `prefetch_images` everywhere" → CDN regression.

Agentry runs the cross-tab in one prompt. The signal usually surfaces in 30 seconds.

## What you get

- A failure-rate matrix: task_name × network_type
- Week-over-week delta so you can spot regressions vs chronic noise
- The top open cases tied to the worst-performing task

## Walk through it

**You:**
> Are background tasks failing more this week? Group failures by task_name and network_type.

**Agent:**
> First the matrix.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "
    select
      properties.task_name as task,
      properties.network_type as net,
      countIf(event = 'background_task_started') as started,
      countIf(event = 'background_task_failed') as failed,
      countIf(event = 'background_task_failed') / countIf(event = 'background_task_started') as fail_rate
    from events
    where event in ('background_task_started', 'background_task_failed')
      and timestamp > now() - interval 7 day
    group by task, net
    having started > 100
    order by fail_rate desc
  "
```
```text
{
  "rows": [
    { "task": "sync_messages",   "net": "cellular", "started":  84210, "failed": 24180, "fail_rate": 0.287 },
    { "task": "prefetch_images", "net": "wifi",     "started":  42100, "failed":  8420, "fail_rate": 0.200 },
    { "task": "prefetch_images", "net": "cellular", "started":  21430, "failed":  6210, "fail_rate": 0.290 },
    { "task": "refresh_token",   "net": "cellular", "started":  62800, "failed":  3820, "fail_rate": 0.061 },
    { "task": "sync_messages",   "net": "wifi",     "started": 168900, "failed":  4180, "fail_rate": 0.025 },
    { "task": "refresh_token",   "net": "wifi",     "started":  82400, "failed":   820, "fail_rate": 0.010 },
    { "task": "upload_pending",  "net": "wifi",     "started":  18400, "failed":   180, "fail_rate": 0.010 }
  ]
}
```

**Agent:**
> Now the week-over-week.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "
    select
      properties.task_name as task,
      properties.network_type as net,
      countIf(event = 'background_task_failed' and timestamp > now() - interval 7 day) /
        nullIf(countIf(event = 'background_task_started' and timestamp > now() - interval 7 day), 0) as this_week,
      countIf(event = 'background_task_failed' and timestamp between now() - interval 14 day and now() - interval 7 day) /
        nullIf(countIf(event = 'background_task_started' and timestamp between now() - interval 14 day and now() - interval 7 day), 0) as last_week
    from events
    where event in ('background_task_started', 'background_task_failed')
      and timestamp > now() - interval 14 day
    group by task, net
    having this_week > 0.05 or last_week > 0.05
    order by this_week - last_week desc
  "
```
```text
{
  "rows": [
    { "task": "sync_messages",   "net": "cellular", "this_week": 0.287, "last_week": 0.040 },
    { "task": "prefetch_images", "net": "wifi",     "this_week": 0.200, "last_week": 0.020 },
    { "task": "prefetch_images", "net": "cellular", "this_week": 0.290, "last_week": 0.022 },
    { "task": "refresh_token",   "net": "cellular", "this_week": 0.061, "last_week": 0.058 }
  ]
}
```

**Agent:**
> Two regressions, both this week:
>
> 1. **`prefetch_images` (wifi AND cellular)**: jumped from 2% to 20-29%. Same on both networks → not a network issue → CDN regression. Let me check the open cases.
> 2. **`sync_messages` (cellular only)**: jumped from 4% to 28.7%. Wifi is fine. Cellular-specific → likely a timeout tuning issue. Either you tightened a timeout in the last release or the upstream got slower.

```text
Endpoint: GET /v1/projects/:project_id/cases
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fcases&method=get
Use query parameters, not a JSON body.
Query/filter concept:
  status: "open",
  matching: "prefetch|image|sync_message|timeout",
  window_hours: 168
```
```text
{
  "cases": [
    {
      "case_id": "c_bg_1",
      "fingerprint": "f_img_a",
      "error_type": "HttpError",
      "message": "GET https://cdn.example.com/images/* returned 503",
      "events_count": 14630,
      "users_affected": 8200,
      "first_seen_at": "2026-05-13T11:00:00Z"
    },
    {
      "case_id": "c_bg_2",
      "fingerprint": "f_sync_a",
      "error_type": "SocketTimeoutException",
      "message": "Failed to connect to sync.api.example.com:443 after 5000ms",
      "events_count": 24180,
      "users_affected": 11420,
      "first_seen_at": "2026-05-13T15:30:00Z"
    }
  ]
}
```

**Agent:**
> Both cases first appeared May 13 — same window the prod deploy went out for v4.2.0.
>
> 1. **CDN 503s**: 14,630 events across 8,200 users. The CDN itself or a config push on it. Talk to whoever owns the CDN config — check if a rate-limit/auth rule was added.
> 2. **Cellular sync timeouts**: 24,180 events across 11,420 users. The 5000ms timeout in `sync_messages` is too aggressive for cellular. The Android default is 30s for a reason. Either bump the timeout for cellular, or implement an exponential-retry strategy.
>
> Both are fixable in a 4.2.1 patch. Want me to open a triage note in Agentry memory so it's pinned to these cases?

## The output

```
Background task failures (7d) — cross-tab task × network

                       WIFI fail %   CELLULAR fail %   WoW Δ (cellular)
sync_messages              2.5%        28.7% ★★★         +24.7 pp
prefetch_images           20.0% ★      29.0% ★★          +27.0 pp
refresh_token              1.0%         6.1%              +0.3 pp
upload_pending             1.0%         (no data)         —

Two regressions detected (both started May 13, deploy 4.2.0):

  1. prefetch_images: 2% → 20-29% (BOTH networks)
     Root: CDN 503s on https://cdn.example.com/images/*
     Case: c_bg_1 (14,630 events, 8,200 users)

  2. sync_messages: cellular 4% → 28.7% (wifi unaffected)
     Root: SocketTimeoutException at 5000ms — too aggressive for cellular
     Case: c_bg_2 (24,180 events, 11,420 users)

Recommended actions:
  - CDN config audit (rate limit / auth rule pushed recently?)
  - Bump cellular timeout to 30s OR add exponential retry
  - Ship 4.2.1 with both fixes
```

## Setting it up

Capture `background_task_started` at the durable task start and
`background_task_failed` only at the owning failed/retry boundary. Attach
`task_name`, `network_type`, `app_version`, and a stable user or device id. Use
the installed official PostHog mobile SDK's exception integration for the stack,
with the same diagnostic properties.

Run `agentry onboard` to review the repository-specific Android/iOS SDK calls,
preserve correct existing telemetry, and verify both events directly in the
customer's PostHog project. Do not invent a cross-language mobile helper.

## Variations

- *"Same cross-tab but per app_version — is the regression isolated to 4.2.0?"*
- *"Median retry attempts before success per task — long tails indicate flaky infrastructure."*
- *"Per-region cellular failure rate — sometimes a single carrier's gateway is the issue."*
- *"On demand, find any task × network pair above 15% failures over one hour and draft a #mobile-oncall summary for review."*
