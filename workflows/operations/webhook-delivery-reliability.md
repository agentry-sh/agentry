# Monitor webhook delivery reliability

Track failed, retried, and slow webhook deliveries by provider, event type, and customer
before integrations silently break.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Monitor webhook delivery reliability
description: >-
  Track failed, retried, and slow webhook deliveries by provider, event type,
  and customer before integrations silently break.
category: ops
tags:
  - analytics
  - webhooks
  - integrations
  - reliability
  - automation
  - b2b
prompt: >-
  Show webhook delivery health for the last 7 days: failures, retries, p95
  delivery time, and customers with repeated delivery problems.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - >-
    `webhook_delivery` events include provider, event_type, status, attempt,
    duration_ms, and customer_id
applies_to:
  - b2b-saas
  - devtools-api
  - marketplace
required_events:
  - webhook_delivery
readiness_events:
  - webhook_delivery
required_event_properties:
  webhook_delivery:
    - provider
    - event_type
    - status
    - attempt
    - duration_ms
    - customer_id
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
ask_if_missing:
  - >-
    Which observed events map to webhook_delivery? Are the required signals
    source-verified, and do live PostHog event/property reads show real traffic
    for them?
  - >-
    Which live properties provide webhook_delivery.provider,
    webhook_delivery.event_type, webhook_delivery.status,
    webhook_delivery.attempt, webhook_delivery.duration_ms,
    webhook_delivery.customer_id, and which stable user or account identifier
    joins the signals?
related:
  - rate-limit-alert-routing
  - audit-log-monitoring
  - api-usage-by-customer
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

## Why this matters

Webhook failures are support tickets with a delay. Your customer thinks your product stopped syncing, but the real signal is buried in retry logs. Agentry can rank unreliable integrations from the event stream.

## What you get

- Failure and retry rates by provider and event type
- Customers with repeated delivery problems
- Slow delivery outliers
- A short remediation plan: customer endpoint issue, provider outage, or your retry worker

## Walk through it

**You:**
> Which webhooks are failing this week?

**Agent:**
> I'll group delivery events by provider, event type, and customer.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.provider AS provider, properties.event_type AS event_type, properties.customer_id AS customer, count() AS deliveries, countIf(properties.status = 'failed') AS failed, countIf(toInt(properties.attempt) > 1) AS retried, quantile(0.95)(toFloat(properties.duration_ms)) AS p95_ms FROM events WHERE event = 'webhook_delivery' AND timestamp > now() - INTERVAL 7 DAY GROUP BY provider, event_type, customer ORDER BY failed DESC, retried DESC LIMIT 50"
```

## The output

The agent returns a list of customers and event types that need action. It should distinguish one-off retries from persistent failure and include whether failures started after a deploy.

## Setting it up

Emit `webhook_delivery` from the worker that sends outbound webhooks. Include both terminal failures and successful retries.

## Variations

- *"Alert if any enterprise customer has more than 10 failed deliveries in an hour."*
- *"Which event type is causing most retries?"*
- *"Compare webhook health before and after the new retry policy."*
