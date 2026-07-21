# Detect frontend performance regressions

Compare page-load and interaction timing by release, browser, and route so frontend
regressions are visible beside errors.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Detect frontend performance regressions
description: >-
  Compare page-load and interaction timing by release, browser, and route so
  frontend regressions are visible beside errors.
category: debugging
tags:
  - analytics
  - frontend
  - performance
  - releases
  - browser
  - product
prompt: >-
  Compare frontend performance for the current release versus the previous
  release. Show routes with worse p75 load time or interaction latency.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - >-
    `web_vital` or `page_performance` events include route, metric, value_ms,
    release, and browser
applies_to:
  - b2c-saas
  - b2b-saas
  - ecommerce
  - marketplace
  - content-media
  - devtools-api
required_events:
  - web_vital
readiness_events:
  - web_vital
required_event_properties:
  web_vital:
    - route
    - metric
    - value_ms
    - release
    - browser
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
ask_if_missing:
  - >-
    Which observed events map to web_vital? Are the required signals
    source-verified, and do live PostHog event/property reads show real traffic for
    them?
  - >-
    Which live properties provide web_vital.route, web_vital.metric,
    web_vital.value_ms, web_vital.release, web_vital.browser, and which stable
    user or account identifier joins the signals?
related:
  - browser-version-errors
  - checkout-completion-time
  - deploy-regression
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

## Why this matters

Some deploys do not throw errors. They just make checkout feel slower or the docs app sluggish. This workflow catches those regressions as product-impacting incidents.

## What you get

- Routes whose p75 or p95 performance regressed
- Browser and release segments
- A short list of likely product surfaces affected
- Follow-up queries for specific pages

## Walk through it

**You:**
> Did the latest frontend release slow anything down?

**Agent:**
> I'll compare `web_vital` timing by route and release.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.route AS route, properties.metric AS metric, properties.release AS release, properties.browser AS browser, quantile(0.75)(toFloat(properties.value_ms)) AS p75_ms, quantile(0.95)(toFloat(properties.value_ms)) AS p95_ms, count() AS samples FROM events WHERE event = 'web_vital' AND timestamp > now() - INTERVAL 7 DAY GROUP BY route, metric, release, browser ORDER BY p95_ms DESC LIMIT 50"
```

## The output

The agent returns the routes and browser segments that worsened, with enough sample size to be credible. It should call out low-sample rows instead of overclaiming.

## Setting it up

Capture web-vital or page-timing events through the application's existing
official PostHog web SDK. Include release and a normalized route template. Run
`agentry onboard` to review sampling, property bounds, and the successful page
measurement boundary before adding or moving telemetry.

## Variations

- *"Only check checkout routes."*
- *"Compare Chrome mobile against desktop."*
- *"Publish this as a release readiness dashboard."*
