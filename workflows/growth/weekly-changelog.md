# Draft a weekly changelog from verified product signals

Turn exact, source-backed weekly aggregates into a human-reviewed changelog draft
without exposing user identities, inventing causality, or auto-publishing.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Draft a weekly changelog from verified product signals
description: >-
  Turn exact, source-backed weekly aggregates into a human-reviewed changelog
  draft without exposing user identities, inventing causality, or
  auto-publishing.
category: growth
tags:
  - analytics
  - content-marketing
  - weekly-review
  - founder-mode
  - saas
prompt: >-
  Draft a weekly changelog from the approved events in this project's saved
  signal map. Query exact current and prior periods, label hypotheses as
  hypotheses, include readiness gaps, exclude user identities, and stop before
  publishing.
difficulty: beginner
time_to_value: 10 minutes
prereqs:
  - >-
    The saved signal map names the real product events for the metric being
    discussed
  - >-
    The required signals are source-verified and live PostHog reads show
    enough real traffic for those events
  - 'A human will review claims, tone, audience, and publication'
applies_to:
  - b2c-saas
  - b2b-saas
  - content-media
  - open-source
required_events:
  - signup_completed
  - feature_used
readiness_events:
  - signup_completed
  - feature_used
required_event_properties: {}
negative_fit:
  - >-
    Projects whose saved signal map uses different lifecycle events and has not
    mapped equivalent signals
  - Projects without two complete comparable periods of real traffic
ask_if_missing:
  - >-
    Which observed event represents entry, activation, and the primary outcome
    in this product?
  - What exact timezone and period boundary should the review use?
related:
  - signup-funnel
  - public-stats-page
  - weekly-agent-digest
execution_mode: human_review
required_resources:
  - signal_map
  - onboarding_state
  - query_blueprints
publishedAt: 2026-05-16T00:00:00.000Z
updatedAt: 2026-07-10T00:00:00.000Z
example_only: true
```

</details>

## Start with answerability, not copy

A polished post can make a weak metric look authoritative. Before drafting,
require a source-verified signal map, then inspect live PostHog event names and property keys.
Map the example events in this page to the product's actual lifecycle. If an
event is missing, ambiguous, synthetic-only, or too sparse, say
`Needs instrumentation` and name the exact gap.

Do not infer activation, retention, revenue, a bug fix, or a causal explanation
from event names alone. Do not expose a “biggest user,” email address, domain,
distinct ID, session ID, or account identity in marketing copy.

## Query exact periods

Use a deterministic aggregate blueprint whose parameters match the saved
signals. For an ordered 2–20 step conversion story, the exact-period comparison
blueprint takes:

- a fixed `scheduled_for` timestamp and timezone-aware editorial boundary;
- an exact period length;
- 2–20 distinct approved event names in order;
- a minimum real-traffic sample for both current and prior windows.

It returns two half-open windows, `prior` then `current`, with counts,
conversions, drop-offs, and explicit sample readiness. It does not use `now()`.
Fetch its current parameter schema before running it:

```text
GET /v1/query-blueprints/ordered_funnel_period_compare
POST /v1/projects/:project_id/query-blueprints/ordered_funnel_period_compare/run
```

For a different metric, choose another catalog blueprint or a bounded owner-side
HogQL query. Write down the exact time bounds and definitions. Never combine
rows from unrelated queries into fields those queries did not produce.

## Draft only what the data supports

A safe draft separates observations, interpretation, and missing proof:

```text
This week in <product>

Observed
- <entry count> people entered the measured flow during <exact bounds>.
- <completion count> reached <outcome>; conversion was <rate>.
- Compared with the immediately preceding equal window, the change was <delta>.

Hypotheses to investigate
- <possible explanation, explicitly labelled; no causal claim>

What shipped
- <human-verified release fact from trusted deploy records or release notes>

Readiness and caveats
- <sample size, delayed ingestion, missing properties, or unmapped signals>
```

“What shipped” is not the same as “what caused the metric change.” A trusted
deploy proves release attribution, not causality. An error disappearing without
post-deploy traffic does not prove a fix.

## Human publication gate

The workflow ends with a draft. A human must choose the channel, audience,
claims, customer-safe wording, and whether any chart should be published. Public
query creation is a separate explicit action and only safe aggregate blueprints
may be published.

Do not automatically post, DM, email, tweet, create an experiment, change a
feature flag, or modify code from this report. Do not store a broad owner key in
a scheduler or copy raw analytics rows into durable agent memory.

## Scheduled alternative

If a reviewed draft should be prepared every week, render
`weekly-funnel-review@2.0.0`. It uses a scoped runner credential and one
server-owned, run-bound aggregate source anchored to the trusted schedule
receipt. The runner cannot choose a new query, request generic HogQL, read raw
identifiers, publish the report, or turn its recommendations into product/code
changes. Missing approval, missing events, low samples, or ambiguous telemetry
remain blocking gates.
