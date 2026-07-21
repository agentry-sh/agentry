# Track dunning recovery from failed invoices

Measure failed-payment recovery from invoice failure through retry, card update,
recovery, or cancellation for subscription revenue.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Track dunning recovery from failed invoices
description: >-
  Measure failed-payment recovery from invoice failure through retry, card
  update, recovery, or cancellation for subscription revenue.
category: growth
tags:
  - analytics
  - revenue
  - stripe
  - dunning
  - churn
  - saas
prompt: >-
  Build a dunning recovery funnel: invoice failed → retry scheduled → payment
  method updated → payment recovered or subscription canceled.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - 'Billing webhook events include account_id, invoice_id, amount, and plan'
applies_to:
  - b2c-saas
  - b2b-saas
  - devtools-api
requires_revenue: true
required_events:
  - invoice_payment_failed
  - payment_method_updated
  - invoice_payment_recovered
readiness_events:
  - invoice_payment_failed
required_event_properties:
  invoice_payment_failed:
    - account_id
    - invoice_id
    - amount
  payment_method_updated:
    - account_id
  invoice_payment_recovered:
    - account_id
    - invoice_id
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
  - >-
    Do not recommend this for products without a real revenue lifecycle or an
    equivalent paid-account signal.
ask_if_missing:
  - >-
    Which observed events map to invoice_payment_failed, payment_method_updated,
    invoice_payment_recovered? Are the required signals source-verified, and do
    live PostHog event/property reads show real traffic for them?
  - >-
    Which live properties provide invoice_payment_failed.account_id,
    invoice_payment_failed.invoice_id, invoice_payment_failed.amount,
    payment_method_updated.account_id, invoice_payment_recovered.account_id,
    invoice_payment_recovered.invoice_id, and which stable user or account
    identifier joins the signals?
related:
  - stripe-payment-failure
  - churn-prediction
  - trial-to-paid-conversion
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

## Why this matters

Failed payments are often recoverable churn. A dunning funnel shows whether users update cards, retries recover revenue, or accounts silently cancel.

## What you get

- Recovery rate after failed invoices
- Time to recovery
- Cancellations after dunning
- Revenue at risk and recovered

## Walk through it

**You:**
> How effective is our dunning flow?

**Agent:**
> I'll stitch billing webhook events into a recovery funnel.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT event, count(DISTINCT properties.invoice_id) AS invoices, sum(toFloat(properties.amount)) AS amount FROM events WHERE event IN ('invoice_payment_failed','payment_method_updated','invoice_payment_recovered','subscription_canceled') AND timestamp > now() - INTERVAL 60 DAY GROUP BY event ORDER BY invoices DESC"
```

## The output

The agent returns recovery rate, lost revenue, and suggested actions such as improving retry timing or card-update emails.

## Setting it up

Emit billing lifecycle events from Stripe or your subscription provider webhook handler.

## Variations

- *"Segment recovery by plan."*
- *"Find accounts with repeated payment failures."*
- *"Draft a Slack digest for at-risk revenue."*
