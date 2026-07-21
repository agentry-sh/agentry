# Measure returns and exchange outcomes

Follow returns from request to refund or exchange so ecommerce teams can reduce
avoidable churn and protect revenue.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Measure returns and exchange outcomes
description: >-
  Follow returns from request to refund or exchange so ecommerce teams can
  reduce avoidable churn and protect revenue.
category: growth
tags:
  - analytics
  - ecommerce
  - retention
  - revenue
  - support
  - customer-success
prompt: >-
  Measure the returns and exchange funnel by reason, SKU, customer segment,
  refund amount, and whether the customer bought again.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - >-
    Returns events include order_id, sku, return_reason, outcome, and
    refund_amount
applies_to:
  - ecommerce
  - marketplace
requires_revenue: true
required_events:
  - return_requested
  - return_label_created
  - exchange_completed
  - refund_completed
readiness_events:
  - refund_completed
required_event_properties:
  return_requested:
    - order_id
    - sku
    - return_reason
  exchange_completed:
    - order_id
    - sku
  refund_completed:
    - order_id
    - refund_amount
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
    Which observed events map to return_requested, return_label_created,
    exchange_completed, refund_completed? Are the required signals
    source-verified, and do live PostHog event/property reads show real traffic for
    them?
  - >-
    Which live properties provide return_requested.order_id,
    return_requested.sku, return_requested.return_reason,
    exchange_completed.order_id, exchange_completed.sku,
    refund_completed.order_id, refund_completed.refund_amount, and which stable
    user or account identifier joins the signals?
related:
  - refund-rate-by-sku
  - checkout-payment-method-performance
  - support-load-by-account
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

## Why this matters

Returns are not one metric. A size-exchange flow, a defective SKU, and a buyer-remorse refund have different fixes. The agent needs the full path to recommend the right response.

## What you get

- Return request volume by SKU and reason
- Exchange completion versus refund completion
- Refund dollars by segment
- Whether returners buy again

## Walk through it

**You:**
> Are returns becoming a retention problem?

**Agent:**
> I'll group return requests by reason and compare refunds, exchanges, and repeat purchase behavior.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.return_reason AS reason, properties.sku AS sku, countIf(event = 'return_requested') AS requested, countIf(event = 'exchange_completed') AS exchanged, countIf(event = 'refund_completed') AS refunded, sumIf(toFloat(properties.refund_amount), event = 'refund_completed') AS refund_amount FROM events WHERE event IN ('return_requested','exchange_completed','refund_completed') AND timestamp > now() - INTERVAL 60 DAY GROUP BY reason, sku ORDER BY refund_amount DESC LIMIT 25"
```

## The output

The agent returns return reasons, SKUs, exchange rates, and refund impact. It should suggest merchandising, support, fulfillment, or product-page fixes based on the dominant pattern.

## Setting it up

Emit events from your returns flow and payment system with a shared order id. Include return reason and SKU as normalized fields.

## Variations

- *"Which SKUs drive the most refunds?"*
- *"Show exchanges versus refunds by size issue."*
- *"Find return reasons associated with later cancellation, without claiming prediction."*
