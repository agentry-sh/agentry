# Detect lifecycle email fatigue

Correlate email volume, opens, clicks, unsubscribes, activation, and churn to find where
lifecycle messaging helps or hurts.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Detect lifecycle email fatigue
description: >-
  Correlate email volume, opens, clicks, unsubscribes, activation, and churn to
  find where lifecycle messaging helps or hurts.
category: growth
tags:
  - analytics
  - email
  - lifecycle
  - churn
  - marketing
  - retention
prompt: >-
  Analyze lifecycle email fatigue: sends, opens, clicks, unsubscribes,
  activation, and churn by sequence and user cohort.
difficulty: intermediate
time_to_value: 7 minutes
prereqs:
  - 'Email events include sequence, campaign, and message_id'
  - Activation or churn events are captured for the same users
applies_to:
  - b2c-saas
  - b2b-saas
  - ecommerce
  - content-media
required_events:
  - email_sent
  - email_clicked
  - email_unsubscribed
readiness_events:
  - email_sent
required_event_properties:
  email_sent:
    - sequence
    - message_id
  email_clicked:
    - sequence
  email_unsubscribed:
    - sequence
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
ask_if_missing:
  - >-
    Which observed events map to email_sent, email_clicked, email_unsubscribed?
    Are the required signals source-verified, and do live PostHog event/property reads
    show real traffic for them?
  - >-
    Which live properties provide email_sent.sequence, email_sent.message_id,
    email_clicked.sequence, email_unsubscribed.sequence, and which stable user
    or account identifier joins the signals?
related:
  - onboarding-email-funnel
  - churn-survey
  - landing-page-source-quality
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

## Why this matters

Lifecycle email can activate users or annoy them into leaving. The difference is visible when email events are joined with product behavior.

## What you get

- Sends, opens, clicks, and unsubscribes by sequence
- Activation after email clicks
- Churn or inactivity after high-volume sequences
- Recommendations to pause, rewrite, or segment messages

## Walk through it

**You:**
> Are our lifecycle emails helping or hurting?

**Agent:**
> I'll compare email engagement with activation and churn signals.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.sequence AS sequence, countIf(event = 'email_sent') AS sent, countIf(event = 'email_clicked') AS clicked, countIf(event = 'email_unsubscribed') AS unsubscribed FROM events WHERE event IN ('email_sent','email_clicked','email_unsubscribed') AND timestamp > now() - INTERVAL 30 DAY GROUP BY sequence ORDER BY sent DESC"
```

## The output

The agent returns sequences to keep, improve, or stop. It should segment by lifecycle stage before making broad recommendations.

## Setting it up

Capture reviewed email-provider webhook outcomes through the customer's
official PostHog server SDK. Keep the stable identity aligned with product
events and do not copy message bodies or recipient addresses into properties.

## Variations

- *"Show onboarding emails only."*
- *"Find messages with high clicks but low activation."*
- *"Draft improvements for the worst-performing sequence."*
