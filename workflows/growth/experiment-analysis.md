# Analyze an existing product experiment

Compare verified exposure and outcome signals across variants, surface readiness and
sample problems, and prepare an evidence-first decision memo.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Analyze an existing product experiment
description: >-
  Compare verified exposure and outcome signals across variants, surface
  readiness and sample problems, and prepare an evidence-first decision memo.
category: growth
tags:
  - analytics
  - experimentation
  - product
  - revenue
  - feature-flags
prompt: >-
  Analyze an experiment that our product already assigns at runtime. Verify the
  exposure and outcome events, compare exact variant cohorts, check sample
  quality and guardrails, and prepare a decision memo without changing the
  rollout.
difficulty: intermediate
time_to_value: 10 minutes
prereqs:
  - >-
    The application or a scoped flag provider already assigns variants
    consistently
  - Exposure and outcome events share a stable user or account identifier
  - Both variants have real traffic in a complete comparison window
applies_to:
  - b2c-saas
  - b2b-saas
  - ecommerce
  - marketplace
  - content-media
  - devtools-api
  - mobile-app
requires_revenue: false
required_events:
  - experiment_exposure
  - conversion_completed
readiness_events:
  - experiment_exposure
  - conversion_completed
required_event_properties:
  experiment_exposure:
    - experiment_id
    - variant
  conversion_completed:
    - experiment_id
negative_fit:
  - >-
    Do not use Agentry as the runtime variant allocator or put a private owner
    credential in deployed application code.
  - >-
    Do not compare variants until exposure and outcome events are mapped to
    observed signals with a stable assignment unit.
  - >-
    Do not call a winner from sparse, still-running, sample-ratio-mismatched, or
    overlapping experiment data.
ask_if_missing:
  - >-
    Which observed events represent exposure and the primary outcome, and which
    property identifies the experiment and variant?
  - >-
    Is assignment per user, account, device, or session, and which stable
    identifier preserves that unit across both events?
  - >-
    What exact window, primary metric, guardrails, minimum sample, and decision
    rule were chosen before reading the result?
related:
  - feature-launch-adoption
  - signup-funnel
  - campaign-payback-by-cohort
execution_mode: on_demand
required_resources:
  - signal_map
  - onboarding_state
  - analytics
  - experiments
  - feature_flags
publishedAt: 2026-07-10T00:00:00.000Z
updatedAt: 2026-07-21T00:00:00.000Z
example_only: true
featured: false
```

</details>

## Why this matters

Experiment analysis is useful only when assignment, exposure, and outcomes are
measured consistently. A variant label on a conversion event is not enough: it
can exclude exposed users who never converted and make every variant look
better than it was.

Agentry can inspect PostHog experiment and linked feature-flag definitions as
first-class read-only resources, then verify exposure/outcome signals and
analyze the experiment your application already runs. It is not a production
feature-flag runtime and exposes no provider mutation or flag-evaluation route.

## What you get

- An answerability check for exposure, outcome, identity, and required properties
- Exposure and outcome counts for exact, disclosed time bounds
- Conversion or revenue-per-assignment comparisons with sample caveats
- A decision memo that separates observations, hypotheses, and missing proof

## Walk through it

**You:**
> Did variant B improve paid conversion in our current pricing experiment?

**Agent:**
> I will first map the experiment's real exposure and paid-outcome signals. I
> will not change the flag or rollout.

```http
GET /v1/projects/:project_id/signal-map
GET /v1/projects/:project_id/onboarding
GET /v1/projects/:project_id/experiments?limit=100
GET /v1/projects/:project_id/experiments/:experiment_id
GET /v1/projects/:project_id/feature-flags/:flag_id
# Require source-verified signals; use live PostHog reads for current evidence.
GET /v1/projects/:project_id/event-names
GET /v1/projects/:project_id/event-property-keys?events=experiment_exposure,conversion_completed
```

The experiment and flag reads establish provider configuration only. The agent
should stop if current source cannot prove assignment/exposure semantics, either
event is absent, the variant property is missing, identities cannot be joined,
or the window contains no complete traffic for one variant. It should name the
missing proof rather than substituting a plausible event.

For a custom experiment analysis, fetch the current request schema and run a
bounded owner-side aggregate query:

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Query plan:
  - bind one exact half-open exposure window
  - assign each stable unit to its first valid exposure
  - count every exposed unit, including non-converters
  - count outcomes only after exposure and within the declared horizon
  - aggregate by variant; return no raw identities
```

```json
{
  "rows": [
    { "variant": "control", "exposures": 1840, "outcomes": 91, "conversion_pct": 4.95 },
    { "variant": "candidate", "exposures": 1812, "outcomes": 97, "conversion_pct": 5.35 }
  ]
}
```

The rows above illustrate an analytics output shape, not an experiment-resource
result endpoint or proof that the difference is statistically or commercially
meaningful.

## The output

```text
Experiment review — <experiment id> — <exact UTC bounds>

Readiness
- exposure and outcome mappings: verified | blocked
- assignment unit and join key: <definition>
- sample-ratio and overlap checks: <result>

Observed
- control: <exposures>, <outcomes>, <rate>
- candidate: <exposures>, <outcomes>, <rate>
- absolute and relative difference: <values>
- revenue and guardrail movement: <values or not measured>

Interpretation
- <evidence-backed statement>
- <hypothesis, explicitly labelled>

Decision for human review
- continue | stop | ship | inconclusive
- why, plus the exact missing proof if inconclusive
```

Do not claim causality from an observational cohort, treat repeated peeking as
a fixed-horizon test, or optimize conversion while ignoring revenue, refunds,
errors, and other declared guardrails.

## Setting it up

Emit one exposure event at the point where the product actually applies the
variant through the application's existing official PostHog SDK at that
execution context. Carry the stable assignment identifier, experiment id,
variant, and assignment version. Emit the business outcome from the system that
durably confirms it, using the same stable identity.

Keep runtime assignment in PostHog's official SDK or the existing scoped flag
provider/app-owned deterministic allocator. Agentry's private owner key is for
interactive reads and management, never deployed evaluation.

Run `agentry onboard` to review exposure placement, identity, guardrails, and
source verification. Agentry's PostHog connection is read-only and cannot
assign a variant or mutate an experiment.

## Variations

- *"Compare revenue per exposed account, not only checkout conversion."*
- *"Check whether the result changes by device, plan, or acquisition source, but label this exploratory."*
- *"Review error and refund guardrails before recommending a rollout."*
- *"Tell me exactly why this experiment is not yet decision-ready."*
