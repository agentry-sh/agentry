# Find queue latency and dead-letter spikes

See which background jobs are backing up, retrying, or landing in dead-letter queues
before customers notice stale state.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Find queue latency and dead-letter spikes
description: >-
  See which background jobs are backing up, retrying, or landing in dead-letter
  queues before customers notice stale state.
category: debugging
tags:
  - analytics
  - errors
  - background-jobs
  - queues
  - infra
  - oncall
prompt: >-
  Show queue health for the last 24 hours: job latency, retry count, dead-letter
  count, and the job types causing the backlog.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - >-
    `job_completed` or `job_failed` events include job_type, queue, latency_ms,
    attempt, and status
applies_to:
  - universal
required_events:
  - job_completed
  - job_failed
readiness_events:
  - job_failed
required_event_properties:
  job_completed:
    - job_type
    - queue
    - latency_ms
  job_failed:
    - job_type
    - queue
    - attempt
    - status
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
ask_if_missing:
  - >-
    Which observed events map to job_completed, job_failed? Are the required signals
    source-verified, and do live PostHog event/property reads show
    real traffic for them?
  - >-
    Which live properties provide job_completed.job_type, job_completed.queue,
    job_completed.latency_ms, job_failed.job_type, job_failed.queue,
    job_failed.attempt, job_failed.status, and which stable user or account
    identifier joins the signals?
related:
  - background-task-failure
  - db-pool-exhaustion
  - time-of-day-patterns
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

## Why this matters

Queues fail quietly. The UI still loads, but emails arrive late, imports stall, and webhooks lag. This workflow makes queue health visible from the same agent loop as errors and deploys.

## What you get

- p95 job latency by queue and job type
- Retry and dead-letter spikes
- First deploy or cron window correlated with the spike
- The job type to inspect first

## Walk through it

**You:**
> Are background jobs backing up?

**Agent:**
> I'll compare completed and failed job events by queue.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT event, properties.queue AS queue, properties.job_type AS job_type, count() AS count, quantile(0.95)(toFloat(properties.latency_ms)) AS p95_latency_ms, max(toInt(properties.attempt)) AS max_attempt FROM events WHERE event IN ('job_completed','job_failed') AND timestamp > now() - INTERVAL 24 HOUR GROUP BY event, queue, job_type ORDER BY count DESC LIMIT 50"
```

## The output

The agent returns a ranked table and identifies whether the issue is latency, retries, or terminal failures. If failures map to cases, it should fetch the top case before suggesting a fix.

## Setting it up

Emit job lifecycle events from the queue worker. Use stable job type names and queue names.

## Variations

- *"Only show jobs with p95 latency over 5 minutes."*
- *"Compare the queue after the last deploy."*
- *"Group dead letters by exception fingerprint."*
