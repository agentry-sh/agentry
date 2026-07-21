# Find slow API routes by customer and plan

Rank API endpoints by p95 latency, error rate, customer, and plan so engineering can fix
performance where it affects revenue.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Find slow API routes by customer and plan
description: >-
  Rank API endpoints by p95 latency, error rate, customer, and plan so
  engineering can fix performance where it affects revenue.
category: debugging
tags:
  - analytics
  - api
  - latency
  - devtools-api
  - performance
  - b2b
  - engineering
prompt: >-
  Show p95 and p99 API latency by route for the last 24 hours, segmented by
  customer_id and plan. Rank the routes hurting paid customers first.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - >-
    `api_request` events include route, status, duration_ms, customer_id, and
    plan
applies_to:
  - devtools-api
  - b2b-saas
requires_b2b: true
required_events:
  - api_request
readiness_events:
  - api_request
required_event_properties:
  api_request:
    - route
    - status
    - duration_ms
    - customer_id
    - plan
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
  - >-
    Do not recommend this when the product has no stable account or workspace
    identity.
ask_if_missing:
  - >-
    Which observed events map to api_request? Are the required signals
    source-verified, and do live PostHog event/property reads show real traffic for
    them?
  - >-
    Which live properties provide api_request.route, api_request.status,
    api_request.duration_ms, api_request.customer_id, api_request.plan, and
    which stable user or account identifier joins the signals?
related:
  - api-usage-by-customer
  - rate-limit-spikes
  - api-usage-as-upsell-signal
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

## Why this matters

Average latency hides pain. One route can be fine for free users and brutal for enterprise accounts with larger payloads. This workflow tells engineering where performance work maps to customer value.

## What you get

- p50, p95, and p99 latency by route
- Error rate and request volume beside latency
- Segments by customer and plan
- A ranked fix list weighted toward paid usage

## Walk through it

**You:**
> Show slow API routes for paid customers.

**Agent:**
> I'll verify the `api_request` shape and rank routes by p95 latency for paid plans.

```text
Endpoint: GET /v1/projects/:project_id/event-property-keys
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fevent-property-keys&method=get
Use query parameters, not a JSON body.
Query/filter concept:
  events: ["api_request"]
```

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.route AS route, properties.plan AS plan, count() AS requests, quantile(0.95)(toFloat(properties.duration_ms)) AS p95_ms, quantile(0.99)(toFloat(properties.duration_ms)) AS p99_ms, avg(toInt(properties.status) >= 500) AS error_rate FROM events WHERE event = 'api_request' AND timestamp > now() - INTERVAL 24 HOUR GROUP BY route, plan ORDER BY p95_ms DESC LIMIT 30"
```

## The output

The agent returns a table of routes with p95/p99, request volume, error rate, and which customers are affected. It should avoid recommending a route with 3 requests over one with 30,000 unless the affected customer is high value.

## Setting it up

Emit one `api_request` event from middleware. Keep route templates stable (`/v1/users/:id`, not raw IDs) so aggregation works.

## Variations

- *"Only show enterprise customers."*
- *"Compare p95 this week vs last week."*
- *"Find routes where retries increased after the last deploy."*
