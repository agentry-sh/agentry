# Diagnose Stripe `card_declined` patterns

Group Stripe payment failures by decline_code. Surface the top causes and the customers
affected. Different decline = different fix.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Diagnose Stripe `card_declined` patterns
description: >-
  Group Stripe payment failures by decline_code. Surface the top causes and the
  customers affected. Different decline = different fix.
category: debugging
tags:
  - errors
  - stripe
  - ecommerce
  - payments
  - customer-support
prompt: >-
  Group Stripe payment failures by decline_code from the last 30 days. Surface
  the top causes and recent affected customers.
difficulty: intermediate
time_to_value: 2 minutes
prereqs:
  - Stripe webhook handler firing `payment_failed` events to Agentry
  - '`decline_code` captured on the event (Stripe provides it)'
applies_to:
  - b2c-saas
  - b2b-saas
  - ecommerce
  - marketplace
  - devtools-api
  - single-purchase
requires_revenue: true
required_events:
  - payment_failed
required_event_properties:
  payment_failed:
    - decline_code
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
    Which observed events map to payment_failed? Are the required signals
    source-verified, and do live PostHog event/property reads show real traffic for
    them?
  - >-
    Which live properties provide payment_failed.decline_code, and which stable
    user or account identifier joins the signals?
related:
  - cart-abandonment-funnel
  - customer-investigation
  - checkout-completion-time
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
```

</details>

## Why this matters

Payment failures cluster by reason — and each reason needs a different response:

- `insufficient_funds` → customer issue, retry in 3 days
- `do_not_honor` → bank issue, retry in 1 day, try different processor
- `card_velocity_exceeded` → your retry logic is too aggressive, slow down
- `incorrect_cvc` → UX issue, surface a clearer error in your form
- `card_declined` (generic) → ambiguous, possibly fraud — different ladder entirely

Most teams treat all payment failures as a single "Stripe error" line in their error tracker. They retry the same way regardless. The result: aggressive retries on real bank declines (annoys customer), gentle retries on velocity-exceeded (just stalls), and no UX fix for CVC errors (which are 100% addressable).

Agentry groups by `decline_code` in one query and tells you which patterns to fix in code vs which to handle in CS workflow.

## What you get

- Top decline codes from the last 30 days with count and ARR exposure
- For each: a recommended response strategy (retry timing, UX fix, CS outreach)
- The specific customers in the top bucket so support can reach out before they churn

## Walk through it

**You:**
> Group Stripe payment failures by decline_code from the last 30 days. Surface the top causes and recent affected customers.

**Agent:**
> Let me query the failures grouped by code.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.decline_code AS code, count() AS cnt, uniq(distinct_id) AS users, sum(toFloat(properties.amount_cents) / 100) AS dollars_failed FROM events WHERE event = 'payment_failed' AND timestamp >= now() - INTERVAL 30 DAY GROUP BY code ORDER BY cnt DESC"
```
```text
{
  "rows": [
    { "code": "insufficient_funds",       "cnt": 412, "users": 388, "dollars_failed": 28840 },
    { "code": "do_not_honor",             "cnt": 188, "users": 142, "dollars_failed": 14200 },
    { "code": "card_velocity_exceeded",   "cnt":  96, "users":  18, "dollars_failed":  4800 },
    { "code": "incorrect_cvc",            "cnt":  78, "users":  64, "dollars_failed":  4100 },
    { "code": "expired_card",             "cnt":  44, "users":  44, "dollars_failed":  2200 },
    { "code": "card_declined",            "cnt":  31, "users":  28, "dollars_failed":  1860 }
  ]
}
```

**Agent:**
> Three patterns worth your attention:
>
> 1. **`insufficient_funds` (412)** — Customer-side, not your bug. Retry strategy should be 1d / 3d / 7d (Stripe's default Smart Retries handles this). Make sure dunning emails are firing.
> 2. **`card_velocity_exceeded` (96, only 18 users)** — This is YOUR retry logic. 18 customers got slammed 5x each in 30 days. Your retry intervals are too tight. Stripe's banks throttle when you retry too fast. Fix: bump min retry interval to 24h.
> 3. **`incorrect_cvc` (78)** — Pure UX. Your form isn't surfacing the error clearly enough; customers re-enter the same wrong CVC. Fix: better inline validation.
>
> Let me check who the velocity-exceeded customers are — these are at high churn risk.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT distinct_id, count() AS retry_attempts FROM events WHERE event = 'payment_failed' AND properties.decline_code = 'card_velocity_exceeded' AND timestamp >= now() - INTERVAL 30 DAY GROUP BY distinct_id ORDER BY retry_attempts DESC LIMIT 5"
```
```text
{
  "rows": [
    { "distinct_id": "alice@bigco.com", "retry_attempts": 12 },
    { "distinct_id": "bob@scale.io", "retry_attempts": 9 },
    { "distinct_id": "carol@enterprise.co", "retry_attempts": 8 }
  ]
}
```

**Agent:**
> Alice got 12 failed attempts. She probably opened 12 support tickets. CS should reach out today and apologize — the failure was on your side, not hers.

## The output

```
Stripe Payment Failures (30d), grouped by decline_code

CODE                         COUNT  USERS  $ EXPOSED   FIX TYPE
insufficient_funds            412    388    $28,840   CS workflow
do_not_honor                  188    142    $14,200   CS workflow
card_velocity_exceeded         96     18     $4,800   ★ YOUR BUG
incorrect_cvc                  78     64     $4,100   ★ UX FIX
expired_card                   44     44     $2,200   email reminder
card_declined (generic)        31     28     $1,860   ambiguous

★ ACTION ITEMS:

  card_velocity_exceeded (your retry logic is too aggressive)
    Affected customers (top 3):
       alice@bigco.com         12 failed retries
       bob@scale.io             9 failed retries
       carol@enterprise.co      8 failed retries
    Fix: bump retry interval to >=24h between attempts.
    Comm: CS apology email to each affected user today.

  incorrect_cvc (UX is hiding the error)
    78 customers re-entered wrong CVC; many gave up.
    Fix: inline real-time validation + clearer error message.

  All others: Stripe Smart Retries + dunning workflow handles these.
```

## Setting it up

Use the Stripe webhook's verified failure boundary to capture a
`payment_failed` event directly to the customer PostHog project with
`decline_code`:

```ts
// /api/webhooks/stripe
app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  const event = stripe.webhooks.constructEvent(
    req.body, req.headers["stripe-signature"]!, STRIPE_WEBHOOK_SECRET
  );

  if (event.type === "payment_intent.payment_failed") {
    const pi = event.data.object;
    const lastError = pi.last_payment_error;

    posthog.capture({
      distinctId: String(pi.customer),
      event: "payment_failed",
      properties: {
        decline_code: lastError?.decline_code ?? "unknown",
        error_code: lastError?.code,
        amount_cents: pi.amount,
        currency: pi.currency,
        payment_intent_id: pi.id,
      },
    });
  }

  res.json({ received: true });
});
```

This illustrates an already-initialized official PostHog Node client. Run
`agentry onboard` to review the actual SDK and stable customer identity; do not
use raw email when an internal id is available.

For richer grouping, also capture `card_country`, `card_brand`, and `processor_response_code` — useful for diagnosing fraud-vs-real declines down the line.

## Variations

- *"Same decline-code breakdown but split by checkout type (one-time vs subscription renewal). Different patterns dominate each."*
- *"Show me the % of `insufficient_funds` decisions that EVENTUALLY succeed (next retry). My Smart Retries config feels too aggressive."*
- *"For each customer with 3+ `card_velocity_exceeded` failures, draft a CS apology email offering account credit."*
- *"On demand, compare yesterday's top `decline_code` with the prior seven-day average and draft a #payments-oncall summary."*
