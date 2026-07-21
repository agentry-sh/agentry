# Measure landing-page source quality

Compare acquisition sources by activation, retention, and paid conversion instead of
only measuring clicks or signups.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Measure landing-page source quality
description: >-
  Compare acquisition sources by activation, retention, and paid conversion
  instead of only measuring clicks or signups.
category: growth
tags:
  - analytics
  - acquisition
  - marketing
  - activation
  - retention
  - saas
prompt: >-
  Compare acquisition sources by signup volume, activation rate, day-7
  retention, and paid conversion. Show which sources are high-quality, not just
  high-volume.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - Signup and activation events include utm_source or acquisition_source
applies_to:
  - b2c-saas
  - b2b-saas
  - devtools-api
  - content-media
  - games
required_events:
  - signup_completed
  - activated
readiness_events:
  - signup_completed
required_event_properties:
  signup_completed:
    - utm_source
  activated:
    - utm_source
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
ask_if_missing:
  - >-
    Which observed events map to signup_completed, activated? Are the required signals
    source-verified, and do live PostHog event/property reads show
    real traffic for them?
  - >-
    Which live properties provide signup_completed.utm_source,
    activated.utm_source, and which stable user or account identifier joins the
    signals?
related:
  - trial-to-paid-conversion
  - activation-moment
  - campaign-payback-by-cohort
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

## Why this matters

Marketing dashboards overvalue volume. Product teams need to know which sources create activated, retained, paying users.

## What you get

- Signup volume by source
- Activation and retention by source
- Paid conversion by source if revenue events exist
- Recommendations for where to spend or stop spending

## Walk through it

**You:**
> Which landing sources produce good users?

**Agent:**
> I'll compare acquisition source against activation and retention events.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.utm_source AS source, countIf(event = 'signup_completed') AS signups, countIf(event = 'activated') AS activated, activated / nullIf(signups, 0) AS activation_rate FROM events WHERE event IN ('signup_completed','activated') AND timestamp > now() - INTERVAL 30 DAY GROUP BY source ORDER BY signups DESC"
```

## The output

The agent returns a source-quality table and flags sources with many signups but weak activation.

## Setting it up

Persist UTM/source attribution onto signup and activation events. Anonymous pageviews are useful, but source must survive account creation.

## Variations

- *"Compare LinkedIn vs Google by paid conversion."*
- *"Only show sources with at least 50 signups."*
- *"Publish this as a marketing quality dashboard."*
