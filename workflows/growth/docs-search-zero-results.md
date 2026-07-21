# Find docs searches with zero results

Capture failed docs searches and connect them to activation, support load, and API
adoption so docs work targets real blockers.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Find docs searches with zero results
description: >-
  Capture failed docs searches and connect them to activation, support load, and
  API adoption so docs work targets real blockers.
category: growth
tags:
  - analytics
  - documentation
  - devtools-api
  - content-marketing
  - activation
  - support
prompt: >-
  Show docs searches with zero results, the users/accounts who searched them,
  and whether those searches were followed by failed activation or support
  tickets.
difficulty: beginner
time_to_value: 3 minutes
prereqs:
  - >-
    `docs_search` events include query, result_count, path, and account_id when
    available
applies_to:
  - devtools-api
  - b2b-saas
  - open-source
  - content-media
required_events:
  - docs_search
readiness_events:
  - docs_search
required_event_properties:
  docs_search:
    - query
    - result_count
    - path
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
ask_if_missing:
  - >-
    Which observed events map to docs_search? Are the required signals
    source-verified, and do live PostHog event/property reads show real traffic for
    them?
  - >-
    Which live properties provide docs_search.query, docs_search.result_count,
    docs_search.path, and which stable user or account identifier joins the
    signals?
related:
  - docs-to-api-funnel
  - api-usage-by-customer
  - support-load-by-account
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

## Why this matters

Docs search queries are user intent in plain text. Zero-result searches tell you what users expected to find and could not.

## What you get

- Top zero-result queries
- Pages where searches happen
- Users or accounts affected
- Follow-up impact: activation failure, support tickets, or API inactivity

## Walk through it

**You:**
> What are people searching for in docs and not finding?

**Agent:**
> I'll rank docs searches with result_count = 0.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.query AS query, properties.path AS path, count() AS searches, count(DISTINCT distinct_id) AS users FROM events WHERE event = 'docs_search' AND toInt(properties.result_count) = 0 AND timestamp > now() - INTERVAL 30 DAY GROUP BY query, path ORDER BY searches DESC LIMIT 50"
```

## The output

The agent returns search gaps and suggested docs pages to create or improve.

## Setting it up

Emit `docs_search` from your docs site search component. Include result count and current path.

## Variations

- *"Only show searches from logged-in accounts."*
- *"Find zero-result searches before API inactivity."*
- *"Draft the missing docs outline for the top query."*
