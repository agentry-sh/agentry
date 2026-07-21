# Find the cron that fails every Sunday at 3am

Bucket errors by hour-of-day and day-of-week to surface periodic failures hiding inside
normal noise.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Find the cron that fails every Sunday at 3am
description: >-
  Bucket errors by hour-of-day and day-of-week to surface periodic failures
  hiding inside normal noise.
category: debugging
tags:
  - errors
  - cron
  - time-series
  - ops
  - infra
prompt: >-
  Are there error patterns that only fire at certain times? Bucket errors by
  hour-of-day and day-of-week and show me anomalies.
difficulty: intermediate
time_to_value: 1 minute
prereqs:
  - At least 14 days of error history (so weekly periodicity is visible)
  - Errors carry accurate timestamps (default — no setup)
applies_to:
  - universal
required_events:
  - $exception
required_event_properties:
  $exception:
    - fingerprint
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
ask_if_missing:
  - >-
    Which observed events map to $exception? Are the required signals
    source-verified, and do live PostHog event/property reads show real traffic for
    them?
  - >-
    Which live properties provide $exception.fingerprint, and which stable user
    or account identifier joins the signals?
related:
  - rate-limit-spikes
  - db-pool-exhaustion
  - dependency-upgrade-regression
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
```

</details>

## Why this matters

Some bugs fire 200 events a day and you see them. Some bugs fire 50 events but only between 02:50 and 03:10 UTC, every Sunday — these look like noise in a daily count but jump out as "weekly backup job is broken" the moment you bucket by hour.

Sentry's UI shows you a time-series for one fingerprint at a time; spotting periodicity requires you to already suspect it. Datadog can do hour-of-day heatmaps if you build the dashboard. Nobody builds the dashboard.

The agent builds it on demand. One prompt, one heatmap, the cron-shaped bugs reveal themselves.

## What you get

- A per-fingerprint heatmap (hour-of-day × day-of-week) for errors trending above baseline
- Top 3 fingerprints with the **highest periodicity score** (concentration in a narrow window)
- A guess at what they map to (3am UTC Sunday = weekly backup, Monday 9am = digest email, etc.)

## Walk through it

**You:**
> Are there error patterns that only fire at certain times? Bucket errors by hour-of-day and day-of-week and show me anomalies.

**Agent:**
> Let me pull error counts bucketed by (fingerprint, hour, day-of-week) for the last 28 days.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.fingerprint AS fp, toHour(timestamp) AS hour, toDayOfWeek(timestamp) AS dow, count() AS cnt FROM events WHERE event = '$exception' AND timestamp >= now() - INTERVAL 28 DAY GROUP BY fp, hour, dow HAVING cnt > 5 ORDER BY fp"
```
```text
{
  "rows": [
    { "fp": "f_a3e1", "hour": 9,  "dow": 1, "cnt": 124 },
    { "fp": "f_a3e1", "hour": 10, "dow": 1, "cnt": 18 },
    { "fp": "f_a3e1", "hour": 9,  "dow": 2, "cnt": 4 },
    { "fp": "f_b7c2", "hour": 3,  "dow": 7, "cnt": 47 },
    { "fp": "f_b7c2", "hour": 3,  "dow": 14, "cnt": 0 },
    { "fp": "f_72ac", "hour": 14, "dow": 1, "cnt": 22 },
    { "fp": "f_72ac", "hour": 14, "dow": 2, "cnt": 24 },
    { "fp": "f_72ac", "hour": 14, "dow": 3, "cnt": 19 }
  ]
}
```

**Agent:**
> Two fingerprints have very high periodicity (>80% of events fall in one hour-of-week bucket):
>
> 1. **`f_b7c2`** — 47 events, **all Sunday 03:00 UTC**. Classic weekly cron failure. Let me pull the case.
> 2. **`f_a3e1`** — 124 events, **Monday 09:00 UTC**. Looks like a digest/welcome email batch.
>
> `f_72ac` is high-volume but evenly distributed across weekdays — that's regular user traffic, not periodic.

```text
Endpoint: GET /v1/cases/:case_id
Exact shape: /v1/openapi.json?path=%2Fv1%2Fcases%2F%7Bcase_id%7D&method=get
Use query parameters, not a JSON body.
```
```text
{
  "id": "f_b7c2",
  "error_type": "TimeoutError",
  "message": "Statement timeout: backup-rotation took >300s",
  "stack_top": "src/jobs/weekly-backup.ts:88",
  "first_seen_at": 1745020800
}
```

**Agent:**
> `f_b7c2` is your weekly backup rotation timing out. It's been firing every Sunday at 03:00 UTC for 4 weeks, ~12 errors per run. Whoever wrote this hasn't seen the alert because they're asleep and nobody triages Sundays. Fix: paginate the rotation or bump the statement timeout. Want me to draft the PR?

## The output

```
Periodic-error heatmap (28d)

f_b7c2  TimeoutError: backup-rotation took >300s
         src/jobs/weekly-backup.ts:88
         Periodicity: 100% in Sunday 03:00 UTC bucket (4 occurrences)
         ↗ Weekly cron — your `runs every Sunday 3am` job

f_a3e1  SMTPError: rate-limit exceeded (Postmark)
         src/jobs/weekly-digest.ts:42
         Periodicity: 88% in Monday 09:00 UTC bucket (4 occurrences)
         ↗ Weekly digest batch — hitting Postmark cap

NON-PERIODIC (regular user traffic):
f_72ac  TypeError on auth.ts:42 — evenly distributed across weekdays
         (see deploy-regression or silent-bugs for triage)
```

## Setting it up

This works out of the box — no extra instrumentation needed. The workflow just slices on the event timestamps you're already sending.

A small upgrade is to attach a stable `job_name` such as
`weekly-backup-rotation` and, when privacy policy permits it, the configured
`cron_expr` through the existing official PostHog server SDK's exception
integration. Preserve the original exception and retry behavior.

Run `agentry onboard` to review the owning catch boundary. With `job_name` set,
the agent can ground the periodicity in source instead of guessing from a stack.

## Variations

- *"Same analysis but for analytics events — are there usage patterns that spike on specific weekdays?"*
- *"Find errors that only fire during business hours (9-5 UTC). Probably user-triggered."*
- *"Show errors that NEVER fire on weekends. They're probably internal-tool bugs."*
- *"On demand, surface any new fingerprint with a periodicity score above 70% in the last 14 days."*
