# Review a sudden spike in negative reviews

Compare a bounded low-rating window with a verified baseline, identify concentrated
sellers or listings, and return evidence for a human incident decision.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Review a sudden spike in negative reviews
description: >-
  Compare a bounded low-rating window with a verified baseline, identify
  concentrated sellers or listings, and return evidence for a human incident
  decision.
category: ops
tags:
  - analytics
  - marketplace
  - trust
  - incident-review
  - human-review
prompt: >-
  Review low-rating review_submitted events from the last 15 minutes against the
  prior seven-day baseline. Show the sample size, multiplier, affected sellers
  or listings, and recent deploy context. Do not message anyone or change
  listing state.
difficulty: intermediate
time_to_value: 10 minutes
prereqs:
  - >-
    review_submitted events flow with rating and stable seller_id or listing_id
    properties
  - 'An owner opens an authenticated, interactive analytics session'
applies_to:
  - marketplace
  - ecommerce
  - content-media
required_events:
  - review_submitted
required_event_properties:
  review_submitted:
    - rating
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
  - >-
    Do not automatically send, publish, suppress, mutate, or contact anyone from
    this workflow.
ask_if_missing:
  - >-
    Which observed events map to review_submitted? Are the required signals
    source-verified, and do live PostHog event/property reads show real traffic
    for them?
  - >-
    Which live properties provide review_submitted.rating, and which stable user
    or account identifier joins the signals?
related:
  - staging-watcher
  - dispute-rate-monitoring
  - audit-log-monitoring
execution_mode: human_review
required_resources:
  - analytics
  - deploys
publishedAt: 2026-05-16T00:00:00.000Z
updatedAt: 2026-07-10T00:00:00.000Z
```

</details>

## Why this matters

A burst of one- and two-star reviews can indicate coordinated abuse, a seller
quality problem, or a product regression. The multiplier alone is not enough:
a change from one review to three looks dramatic but may be noise. A useful
review includes the absolute count, historical baseline, concentration, sample
window, and nearby deploys.

## Run the review

First prove the telemetry exists:

```text
GET /v1/projects/:project_id/event-names
GET /v1/projects/:project_id/event-property-keys?events=review_submitted
GET /v1/projects/:project_id/onboarding
# Require source-verified signals; use live PostHog reads for current evidence.
```

If `review_submitted.rating` is missing or partial, report that gap instead of
calculating a rate. Otherwise, in the interactive owner session, fetch the
filtered schema for `POST /v1/projects/:project_id/analytics/query` and run a
bounded custom analysis that returns:

- low-rating count for the current 15-minute window;
- comparable 15-minute buckets across the prior seven days;
- median and upper-percentile baseline, not only an average;
- counts by `seller_id` and `listing_id` with minimum sample sizes;
- recent deploys that overlap the start of the spike.

Do not include full review text by default. If text is needed to distinguish
abuse from a fulfillment failure, sample the minimum necessary rows and keep
them in the owner-controlled session.

## Output format

```text
Negative-review review — <UTC window>

Current low ratings: <count>
Historical median per 15m: <count>
Historical p95 per 15m: <count>
Multiplier vs median: <value>
Evidence quality: <answerable | partial | missing>

Concentration
- <seller/listing> — <count> — <share> — <minimum sample met?>

Possible explanations
- <hypothesis> — <supporting evidence> — <contradicting evidence>

Human decisions
- investigate abuse / fulfillment / deploy regression / keep observing
```

A human decides whether to contact support, pause a listing, roll back a
release, or share the report. This workflow grants none of those actions.

## Instrumentation

Capture review creation through the customer's existing official PostHog
server SDK after the review is durably accepted:

```ts
posthog.capture({
  distinctId: reviewer.id,
  event: "review_submitted",
  properties: {
    rating: review.rating,
    seller_id: review.seller_id,
    listing_id: review.listing_id,
  },
});
```

Run `agentry onboard` to verify the durable boundary and privacy properties.

## Unattended boundary

No current versioned automation template grants generic HogQL, raw review
access, messaging, or listing mutation. Keep this analysis on demand until a
narrow immutable server-owned source and matching policy exist.

## Variations

- *"Compare low-rating concentration by seller tenure."*
- *"Cross-reference the spike with disputes and fulfillment failures."*
- *"Compare the first hour after the latest deploy with its prior-period baseline."*
- *"Draft an incident summary for a trust lead to review; do not send it."*
