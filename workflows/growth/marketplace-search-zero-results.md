# Find marketplace zero-result searches

Identify marketplace searches with no matching supply so product and ops teams can fix
demand-supply gaps faster.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Find marketplace zero-result searches
description: >-
  Identify marketplace searches with no matching supply so product and ops teams
  can fix demand-supply gaps faster.
category: growth
tags:
  - analytics
  - marketplace
  - search
  - activation
  - product
  - operations
prompt: >-
  Find marketplace searches with zero results by query, category, geography,
  buyer segment, and downstream conversion.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - 'Search events include query, category, result_count, and geography'
applies_to:
  - marketplace
requires_two_sided: true
required_events:
  - marketplace_search_performed
  - listing_viewed
  - booking_started
readiness_events:
  - marketplace_search_performed
required_event_properties:
  marketplace_search_performed:
    - query
    - category
    - result_count
    - geography
  listing_viewed:
    - listing_id
  booking_started:
    - listing_id
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
  - >-
    Do not recommend this when the product has no distinct supply and demand
    sides with stable identities.
ask_if_missing:
  - >-
    Which observed events map to marketplace_search_performed, listing_viewed,
    booking_started? Are the required signals source-verified, and do live
    PostHog event/property reads show real traffic for them?
  - >-
    Which live properties provide marketplace_search_performed.query,
    marketplace_search_performed.category,
    marketplace_search_performed.result_count,
    marketplace_search_performed.geography, listing_viewed.listing_id,
    booking_started.listing_id, and which stable user or account identifier
    joins the signals?
related:
  - liquidity-dashboard
  - supply-side-activation
  - activation-moment
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

## Why this matters

Zero-result searches are explicit demand with no available supply. They tell marketplace teams what inventory, geography, taxonomy, or search behavior needs attention.

## What you get

- Top zero-result queries by category and geography
- Result-count distribution for high-demand searches
- Whether users recover with another query
- Supply or taxonomy actions ranked by potential demand

## Walk through it

**You:**
> What are people searching for that we do not have?

**Agent:**
> I'll find searches with result_count equal to zero and group them by query, category, and geography.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.query AS query, properties.category AS category, properties.geography AS geography, count() AS searches, count(DISTINCT distinct_id) AS users FROM events WHERE event = 'marketplace_search_performed' AND toInt(properties.result_count) = 0 AND timestamp > now() - INTERVAL 30 DAY GROUP BY query, category, geography ORDER BY users DESC LIMIT 25"
```

## The output

The agent returns demand gaps ranked by user count and search volume. It should distinguish supply acquisition, category taxonomy, synonym handling, and geography coverage.

## Setting it up

Track every marketplace search with query, normalized category, geography, and result count. Include follow-up listing views or booking starts to measure recovery.

## Variations

- *"Show zero-result searches by city."*
- *"Which categories have demand but no supply?"*
- *"Publish weekly marketplace demand gaps."*
