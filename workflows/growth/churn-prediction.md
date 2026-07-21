# Identify behavioral churn-risk signals

Compare pre-renewal behavior for retained and canceled customers, quantify associations,
and prepare a reviewed risk hypothesis without claiming prediction.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Identify behavioral churn-risk signals
description: >-
  Compare pre-renewal behavior for retained and canceled customers, quantify
  associations, and prepare a reviewed risk hypothesis without claiming
  prediction.
category: growth
tags:
  - analytics
  - retention
  - churn
  - revenue
  - customer-success
  - human-review
prompt: >-
  Compare behavior before cancellation and renewal in exact historical cohorts.
  Quantify which verified product-value signals differ, disclose sample and
  confounding limits, and prepare a churn-risk hypothesis for human review
  without contacting customers.
difficulty: advanced
time_to_value: 15 minutes
prereqs:
  - >-
    Cancellation and renewal outcomes are recorded from the trusted billing
    lifecycle
  - >-
    At least two complete historical outcome cohorts share stable customer
    identity
  - Product-value events have enough real traffic before the outcome window
applies_to:
  - b2c-saas
  - b2b-saas
  - devtools-api
requires_revenue: true
required_events:
  - subscription_canceled
  - subscription_renewed
  - product_value_completed
readiness_events:
  - subscription_canceled
  - subscription_renewed
  - product_value_completed
required_event_properties:
  subscription_canceled:
    - plan
  subscription_renewed:
    - plan
negative_fit:
  - >-
    Do not describe retrospective behavioral associations as a predictive model
    or a promise that churn will occur.
  - >-
    Do not use this for products without a verified paid lifecycle and enough
    complete retained and canceled cohorts.
  - >-
    Do not automatically create outreach lists, send messages, change pricing,
    or target users from exploratory signals.
ask_if_missing:
  - >-
    Which trusted events define cancellation and renewal, and what stable user
    or account identity joins them to prior behavior?
  - >-
    What exact pre-outcome window, historical cohort window, plan segments, and
    minimum sample should be compared?
  - >-
    Which product-value events were defined before looking at the outcome, and
    who reviews any resulting risk hypothesis?
related:
  - activation-moment
  - churn-survey
  - account-health-score
execution_mode: human_review
required_resources:
  - signal_map
  - onboarding_state
  - analytics
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
featured: false
example_only: true
```

</details>

## Why this matters

Customers often reduce meaningful product activity before cancellation, but a
behavioral difference is not automatically a prediction. Plan changes,
seasonality, account size, contract timing, product changes, and support issues
can all explain the same pattern.

Use this workflow to discover and quantify historical associations. Treat the
result as a hypothesis to validate on a later holdout period, not as a label to
act on immediately.

## What you get

- Exact retained and canceled historical cohorts
- Pre-outcome behavior comparisons for predefined product-value events
- Sample sizes, effect sizes, segment differences, and missing evidence
- A reviewed validation plan before any customer-level use

## Walk through it

**You:**
> Which product behaviors were different before cancellation versus renewal?

**Agent:**
> I will bind complete historical outcome windows and compare only verified
> pre-outcome signals. The result will be association evidence, not a prediction.

```http
GET /v1/projects/:project_id/signal-map
GET /v1/projects/:project_id/onboarding
# Require source-verified signals; use live PostHog reads for current evidence.
GET /v1/projects/:project_id/event-property-keys?events=subscription_canceled,subscription_renewed,product_value_completed
```

Then run a bounded owner-side aggregate query using the current OpenAPI schema:

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Query plan:
  - select one exact historical cancellation/renewal outcome window
  - bind one equal pre-outcome behavior window per identity
  - exclude behavior after the outcome
  - aggregate predefined value-event counts by outcome and plan segment
  - return cohort sizes, distributions, and effect sizes; no raw identities
```

```json
{
  "rows": [
    {
      "signal": "product_value_completed",
      "plan": "pro",
      "canceled_accounts": 84,
      "renewed_accounts": 391,
      "canceled_median": 2,
      "renewed_median": 11
    }
  ]
}
```

This supports a statement that the measured value event was less frequent in
the canceled historical cohort. It does not prove that low activity causes
churn or that every currently quiet account will cancel.

## The output

```text
Historical churn-signal review — <exact bounds>

Observed associations
- <signal>: <canceled distribution> vs <renewed distribution>
- sample: <cohort sizes and plan segments>

Limitations
- <confounding, sparse outcomes, missing identity, seasonality, instrumentation change>

Hypothesis
- <explicitly labelled risk hypothesis>

Validation before operational use
- freeze the rule
- test it on a later untouched cohort
- measure false positives and segment stability
- obtain CS/privacy review before inspecting customer-level matches
```

Do not produce a “31 users will churn” claim from this analysis. If a later
validated rule is used to prepare a private review queue, a human must decide
whether and how to contact any customer.

## Setting it up

Record billing outcomes from the trusted billing webhook through the customer's
existing official PostHog server SDK, with a stable account or user identifier
and only the necessary plan context. Define value events from the product's real
business logic and source-verify them with deployment and live traffic.

Avoid copying cancellation notes, message bodies, or sensitive payment details
into analytics properties. Re-run validation after material product,
instrumentation, pricing, or customer-mix changes.

## Variations

- *"Compare the association by plan without pooling enterprise and self-serve customers."*
- *"Use a later historical period as a holdout for the frozen hypothesis."*
- *"Identify which required signal is too sparse to support this analysis."*
- *"Compare expansion outcomes instead of cancellation, with the same caveats."*
