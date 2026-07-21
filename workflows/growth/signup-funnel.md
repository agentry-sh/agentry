# Measure a verified three-step signup funnel

Map three ordered lifecycle events to live project signals, run the canonical funnel
blueprint, and explain drop-offs without inventing causes or benchmarks.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Measure a verified three-step signup funnel
description: >-
  Map three ordered lifecycle events to live project signals, run the canonical
  funnel blueprint, and explain drop-offs without inventing causes or
  benchmarks.
category: growth
tags:
  - analytics
  - funnels
  - onboarding
  - activation
  - product
  - saas
prompt: >-
  Measure our signup-to-activation funnel for the last 30 days. Map three
  distinct ordered events from the saved signal map and observed event names,
  verify they have real traffic, run funnel_3_step, calculate drop-offs from its
  returned counts, and state which causes are still hypotheses.
difficulty: beginner
time_to_value: 5 minutes
prereqs:
  - Three distinct signup or onboarding events share a stable identity
  - >-
    The required signals are source-verified and live PostHog reads show real
    traffic for all three events
applies_to:
  - b2c-saas
  - b2b-saas
  - devtools-api
  - single-purchase
  - enterprise-sales
required_events:
  - signup_started
  - signup_completed
  - activation_completed
readiness_events:
  - signup_started
  - signup_completed
  - activation_completed
required_event_properties: {}
negative_fit:
  - >-
    Do not use the example event names when the project's saved signal map
    defines different lifecycle events.
  - Do not interpret missing or synthetic-only events as real user drop-off.
  - >-
    Do not claim industry benchmarks, time-to-next-step, causes, or four-step
    results from the three-count blueprint.
ask_if_missing:
  - >-
    Which three observed events define entry, completed signup, and meaningful
    activation in their required order?
  - >-
    Which stable identity links the events, and can anonymous-to-known identity
    transitions be joined without double counting?
  - What exact lookback window and audience should the funnel cover?
related:
  - activation-moment
  - experiment-analysis
  - weekly-funnel-review
execution_mode: on_demand
required_resources:
  - signal_map
  - onboarding_state
  - query_blueprints
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
featured: true
example_only: false
```

</details>

## Why this matters

A funnel is only as trustworthy as its event mapping and identity continuity.
Running a plausible query against guessed event names can turn missing
instrumentation into a false product conclusion.

Agentry's `funnel_3_step` blueprint answers a deliberately narrow question: how
many distinct identities completed step 1, then step 2 after step 1, then step 3
after step 2 during the selected lookback. It returns three counts. The agent
calculates drop-off percentages and labels explanations as hypotheses.

## What you get

- Three approved, observed events mapped to the product's actual lifecycle
- Canonical ordered-funnel counts for a disclosed lookback window
- Step-to-step and overall conversion calculated from those counts
- Instrumentation gaps, identity caveats, and hypotheses kept separate from evidence

## Walk through it

**You:**
> Where do users drop between signup and first value?

**Agent:**
> I will use the saved lifecycle definition and observed event names, not the
> example names from this page.

```http
GET /v1/projects/:project_id/signal-map
GET /v1/projects/:project_id/onboarding
# Require source-verified signals; use live PostHog reads for current evidence.
GET /v1/projects/:project_id/event-names
```

```json
{
  "server_emitted": [],
  "analytics_events": [
    { "event": "signup_started", "count": 1840, "last_seen": 1783651200 },
    { "event": "signup_email_verified", "count": 1240, "last_seen": 1783651210 },
    { "event": "first_project_created", "count": 720, "last_seen": 1783651250 }
  ],
  "wildcards": []
}
```

After confirming these events match the approved lifecycle and have real
traffic, fetch and run the current blueprint:

```http
GET /v1/query-blueprints/funnel_3_step
POST /v1/projects/:project_id/query-blueprints/funnel_3_step/run
```

```text
Params:
  step1: signup_started
  step2: signup_email_verified
  step3: first_project_created
  days: 30
```

```json
{
  "rows": [
    {
      "step1_count": 1840,
      "step2_count": 1240,
      "step3_count": 720
    }
  ]
}
```

From these counts, step 1→2 conversion is 67.4%, step 2→3 is 58.1%, and
step 1→3 is 39.1%. The data identifies where measured loss is largest; it does
not explain why.

## The output

```text
Signup funnel — last 30 days

signup_started             1,840  100.0%
  ↳ drop to step 2           600   32.6%
signup_email_verified      1,240   67.4%
  ↳ drop to step 3           520   41.9%
first_project_created        720   39.1% of entry

Evidence caveats
- <identity transition, sampling, delayed ingestion, or missing event>

Hypotheses to investigate
- <possible explanation, explicitly labelled>
```

If a public view is explicitly requested, publish only the same approved
`funnel_3_step` blueprint with the same params and use the returned
`public_url`. Publication is a separate reviewed action, not an automatic end
of funnel analysis.

## Setting it up

Capture lifecycle events directly through the existing official PostHog SDK at
each source-proven event boundary. Use one stable identity across all steps. If
signup changes an anonymous identifier into a known user identifier, implement
and verify the product's PostHog identity-linking strategy before trusting the
funnel.

Do not add events merely to satisfy this page. Start from the business question,
define what completed signup and first value mean in this product, then use
`agentry onboard` to approve, deploy, observe, and source-verify those signals.

## Variations

- *"Compare the same three-step funnel across two exact adjacent periods."*
- *"Segment the funnel by an observed plan or acquisition property."*
- *"Tell me which step is not answerable and the exact telemetry needed."*
- *"Render weekly-funnel-review@2.0.0 with these approved events in exact order, but leave it disabled."*
