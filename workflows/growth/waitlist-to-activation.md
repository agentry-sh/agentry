# Track waitlist to activation

See which waitlist cohorts convert after invite, where they stall, and whether invite
timing changes activation quality.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Track waitlist to activation
description: >-
  See which waitlist cohorts convert after invite, where they stall, and whether
  invite timing changes activation quality.
category: growth
tags:
  - analytics
  - waitlist
  - activation
  - onboarding
  - acquisition
  - product
prompt: >-
  Analyze waitlist conversion: joined waitlist, invited, accepted invite, signed
  up, activated, and retained by cohort and acquisition source.
difficulty: beginner
time_to_value: 4 minutes
prereqs:
  - 'Waitlist and invite events include cohort, source, and invite_id'
applies_to:
  - b2c-saas
  - b2b-saas
  - content-media
  - games
  - mobile-app
required_events:
  - waitlist_joined
  - invite_accepted
  - activated
readiness_events:
  - invite_accepted
required_event_properties:
  waitlist_joined:
    - source
    - cohort
  invite_accepted:
    - invite_id
  activated:
    - source
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
ask_if_missing:
  - >-
    Which observed events map to waitlist_joined, invite_accepted, activated? Are the required signals
    source-verified, and do live PostHog event/property reads show
    real traffic for them?
  - >-
    Which live properties provide waitlist_joined.source,
    waitlist_joined.cohort, invite_accepted.invite_id, activated.source, and
    which stable user or account identifier joins the signals?
related:
  - signup-funnel
  - landing-page-source-quality
  - activation-moment
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

## Why this matters

Waitlists create demand, but delayed access can cool intent. This workflow shows whether your invite cadence turns demand into activation.

## What you get

- Waitlist cohort conversion
- Invite acceptance and signup rate
- Activation after invite
- Source quality and timing effects

## Walk through it

**You:**
> How well does our waitlist convert after invites?

**Agent:**
> I'll build a waitlist-to-activation funnel by cohort and source.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.cohort AS cohort, properties.source AS source, countIf(event = 'waitlist_joined') AS joined, countIf(event = 'invite_accepted') AS accepted, countIf(event = 'activated') AS activated FROM events WHERE event IN ('waitlist_joined','invite_accepted','activated') GROUP BY cohort, source ORDER BY joined DESC"
```

## The output

The agent returns cohort conversion and recommends whether to invite faster, change messaging, or segment by source.

## Setting it up

Emit waitlist and invite lifecycle events. Preserve source and cohort through signup and activation.

## Variations

- *"Compare invites sent within 7 days vs after 30 days."*
- *"Find sources with high waitlist joins but low activation."*
- *"Publish this for launch planning."*
