# Compare self-serve vs sales-led user lifecycles

Split your funnel by how the user arrived — pricing-page vs demo. Compare activation,
retention, expansion side by side.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Compare self-serve vs sales-led user lifecycles
description: >-
  Split your funnel by how the user arrived — pricing-page vs demo. Compare
  activation, retention, expansion side by side.
category: growth
tags:
  - analytics
  - cohorts
  - segmentation
  - b2b
  - sales
  - saas
prompt: >-
  Split signups into self-serve (signed up via /pricing) vs sales-led (signed up
  after a demo). Compare their 30/60/90-day activation, retention, expansion.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - Signup event with a path/source property indicating origin
  - (Optional) A `demo_completed` event for sales-led path detection
applies_to:
  - b2b-saas
  - enterprise-sales
requires_b2b: true
required_events:
  - signup_completed
  - demo_completed
  - first_project_created
  - subscription_started
  - plan_changed
required_event_properties:
  signup_completed:
    - signup_path
  demo_completed:
    - account_id
  plan_changed:
    - from_plan_rank
    - to_plan_rank
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
    Which observed events map to signup_completed, demo_completed,
    first_project_created, subscription_started, plan_changed? Are the required signals
    source-verified, and do live PostHog event/property reads show
    real traffic for them?
  - >-
    Which live properties provide signup_completed.signup_path,
    demo_completed.account_id, plan_changed.from_plan_rank,
    plan_changed.to_plan_rank, and which stable user or account identifier joins
    the signals?
related:
  - trial-to-paid-conversion
  - activation-moment
  - demo-poc-tracking
updatedAt: 2026-07-20T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
```

</details>

## Why this matters

Averaging across go-to-market motions can hide material differences. Teams
often expect patterns like these, but the project's evidence must establish
whether they are true:

- Self-serve may activate sooner, carry lower ACV, and rely more on product-led
  onboarding.
- Sales-led may activate later, carry higher ACV, and depend more on a managed
  handoff.

A blended "30-day activation rate" tells you nothing useful about either. The PM looks at the number, sees 25%, doesn't know whether to ship a self-serve onboarding fix or hire another CSM. Most analytics views never split the cohorts because nobody wired up the source signal at signup.

A bounded PostHog HogQL read through Agentry can define both analytic
populations in one query and show the two motions side by side. It does not
create or modify a PostHog cohort.

## What you get

- Two analytic populations (self-serve, sales-led) with their 30/60/90-day
  rates for activation, retention, and upgrade
- The metric where the gap is largest (= where the GTM workflow should differ most)
- A protected metric report you can share with the leadership team after the source signal is verified

## Walk through it

**You:**
> Split signups into self-serve (signed up via /pricing) vs sales-led (signed up after a demo). Compare their 30/60/90-day activation, retention, expansion.

**Agent:**
> I will verify the source-backed events, join identity, and live properties
> before comparing the two populations. Matching historical rows alone do not
> prove that the current signup or demo boundary emits them.

```http
GET /v1/projects/:project_id/signal-map
GET /v1/projects/:project_id/onboarding
GET /v1/projects/:project_id/event-property-keys?events=signup_completed,demo_completed,first_project_created,subscription_started,plan_changed
```

Only continue when the required signals are `source_verified` and the live read
shows the approved join and segment properties. Otherwise report the exact
missing property, source boundary, deploy, or traffic evidence.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Query plan:
  - bind one exact signup window and the approved stable identity
  - classify self-serve from the verified signup-origin property
  - classify sales-led only when a verified demo precedes signup within the approved window
  - make the populations mutually exclusive and report unclassified signups
  - count verified activation, paid, and upward-plan outcomes within 30/60/90 days
  - return aggregate population counts and rates, not raw identities
```
```text
{
  "rows": [
    { "cohort": "self_serve", "n": 1840, "activated_30d": 920, "paid_60d": 184, "expanded_90d": 22 },
    { "cohort": "sales_led",  "n": 168,  "activated_30d": 134, "paid_60d": 134, "expanded_90d": 41 }
  ]
}
```

**Agent:**
> In this bounded historical window, the observed contrast is:
>
> |              | self-serve | sales-led |
> |--------------|-----------:|----------:|
> | n            | 1,840      | 168       |
> | activated 30d| 50%        | 80%       |
> | paid 60d     | 10%        | 80%       |
> | expanded 90d | 1.2%       | 24%       |
>
> Volume is 11x on self-serve. Observed paid conversion is 8x higher and
> observed expansion is 20x higher for the selected sales-led population.
>
> **Strategic read:** the motions are different enough to justify testing
> separate onboarding and handoff hypotheses. The query does not establish
> causality, unit economics, or whether either motion is funded correctly.
>
> Before changing staffing or product, segment by account size and signup
> period, verify complete outcome windows, and compare a later holdout period.

## The output

```
Self-Serve vs Sales-Led — last 90d analytic populations

METRIC              SELF-SERVE    SALES-LED   RATIO   COMMENTARY
n (signups)              1,840          168    11.0x  Volume lives in self-serve
activated 30d              50%          80%   0.62x  Sales-led activates better
paid 60d                   10%          80%   0.13x  Sales-led converts 8x better
expanded 90d              1.2%          24%   0.05x  Sales-led expands 20x better

WHERE THE WORKFLOWS DIVERGE:
  Self-serve activation:  50% → candidate for a reviewed onboarding test
  Self-serve conversion:  10% → inspect trial and pricing-path evidence
  Sales-led activation:   80% → inspect demo-to-handoff consistency
  Sales-led conversion:   80% → preserve as a comparison metric

CAVEATS:
  - Segment assignment depends on the verified origin and demo identity bridge.
  - Recent signups without a complete 90-day window must be excluded or marked partial.
  - The rates do not include ACV, gross margin, acquisition cost, or sales cost.

Strategic question: which motion has the largest verified, addressable gap?
```

## Setting it up

The only new requirement is **knowing how each signup arrived**. Capture it on the signup event:

```ts
// Existing, initialized official PostHog Node client.
posthog.capture({
  distinctId: user.id,
  event: "signup_completed",
  properties: {
    signup_path: user.signup_path,
    had_demo: user.last_demo_at != null,
    utm_source: user.utm_source,
  },
});

posthog.capture({
  distinctId: resolveInternalUserId(bookingAttendeeId),
  event: "demo_completed",
  properties: { ae_id: bookingAssigneeId, demo_outcome: "qualified" },
});
```

If you cannot source-verify `demo_completed`, label the signup-path split as a
heuristic rather than silently treating it as fact. Run `agentry onboard` to
review the identity bridge and the two durable outcomes.

## Variations

- *"Same split but for last quarter only — has the ratio changed since we added the AE team?"*
- *"Build the same comparison for 3 sub-cohorts: low ACV self-serve, mid-market sales-led, enterprise sales-led."*
- *"For sales-led only, compare activation rate by AE. Which reps are best at handoff?"*
- *"For self-serve only, find users who didn't activate in 30d but came back at 60d and DID activate. What did they do differently?"*
