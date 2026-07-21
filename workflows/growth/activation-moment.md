# Identify early behaviors associated with retention

Compare predefined first-window product behaviors with later retained activity, quantify
associations, and design a validation step without declaring a magic cause.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Identify early behaviors associated with retention
description: >-
  Compare predefined first-window product behaviors with later retained
  activity, quantify associations, and design a validation step without
  declaring a magic cause.
category: growth
tags:
  - analytics
  - activation
  - retention
  - onboarding
  - product
prompt: >-
  Compare predefined behaviors in the first 24 hours with a source-backed
  retained-activity event in a later window. Show cohort sizes and retention
  rates, control obvious segments, and label every result as association until
  validated.
difficulty: advanced
time_to_value: 15 minutes
prereqs:
  - >-
    Signup, candidate value events, and a later retained-activity event share
    stable identity
  - Enough complete cohort history exists for the selected retention window
applies_to:
  - b2c-saas
  - b2b-saas
  - devtools-api
  - content-media
  - marketplace
required_events:
  - signup_completed
  - product_value_completed
  - retained_activity
readiness_events:
  - signup_completed
  - product_value_completed
  - retained_activity
required_event_properties: {}
negative_fit:
  - >-
    Do not call a behavior a magic moment or causal driver from retrospective
    correlation alone.
  - >-
    Do not use incomplete cohorts, any-event retention, or events chosen only
    after inspecting the outcome.
  - >-
    Do not automatically change onboarding, create targeting cohorts, or contact
    users from exploratory results.
ask_if_missing:
  - >-
    Which observed event defines signup, which predefined early behaviors are
    candidates, and which event represents meaningful retained activity?
  - >-
    What exact early window, later retention window, cohort dates, minimum
    sample, and major segments should be used?
  - >-
    How will the strongest association be validated on a later cohort or
    prospective experiment?
related:
  - signup-funnel
  - churn-prediction
  - feature-launch-adoption
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

Teams want an early behavior that signals a user has reached value. Historical
retention differences are useful clues, but they are vulnerable to selection
bias: already-motivated users often both complete more actions and retain.

Use this workflow to identify candidate behaviors and design validation. Do not
turn the highest retrospective rate into a causal product rule.

## What you get

- Cohort sizes and later retained-activity rates for predefined early behaviors
- Baseline and major-segment comparisons
- Coverage, confounding, and identity caveats
- A frozen candidate definition and validation plan

## Walk through it

**You:**
> Which first-day behaviors are associated with meaningful activity four weeks later?

**Agent:**
> I will verify the signup, candidate, and retained-activity events, then compare
> complete historical cohorts. I will not call the strongest row causal.

```http
GET /v1/projects/:project_id/signal-map
GET /v1/projects/:project_id/onboarding
# Require source-verified signals; use live PostHog reads for current evidence.
GET /v1/projects/:project_id/event-names
```

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Query plan:
  - choose complete signup cohorts with a full later observation window
  - mark predefined candidate events completed within the first 24 hours
  - define retained activity from one approved value event in the later window
  - return cohort size and retained count by candidate and major segment
  - include the all-signup baseline; return no raw identities
```

```json
{
  "rows": [
    { "candidate": "integration_connected", "cohort_size": 142, "retained_users": 87, "retention_pct": 61.27 },
    { "candidate": "team_member_invited", "cohort_size": 98, "retained_users": 54, "retention_pct": 55.10 },
    { "candidate": "all_signups", "cohort_size": 620, "retained_users": 211, "retention_pct": 34.03 }
  ]
}
```

## The output

```text
Early-behavior association review — <cohort and observation bounds>

Observed
- <candidate>: <cohort size>, <retained count>, <rate>
- baseline: <rate>
- segment stability: <result>

Limitations
- <selection bias, identity gaps, sparse sample, instrumentation change>

Candidate to validate
- frozen behavior and window: <definition>
- validation: later holdout cohort or prospective experiment
```

## Setting it up

Define retained activity as a source-backed value event, not “any event.” Use a
stable identity across signup, early behavior, and the later window. Exclude
internal, test, synthetic, and automation traffic and preserve exact cohort
bounds so the analysis can be reproduced.

Do not instrument every conceivable action solely to search for a lucky
correlation. Start from a small set of plausible value behaviors derived from
the product's business logic.

## Variations

- *"Repeat the frozen definition on the next complete cohort."*
- *"Compare the association by plan or acquisition source without pooling unlike users."*
- *"Use eight-week retained activity and report how the result changes."*
- *"Design an experiment to test the onboarding intervention; do not launch it."*
