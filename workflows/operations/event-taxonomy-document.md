# Auto-document your captured event taxonomy

Every event captured in the last 30 days with count, first-seen, last-seen, sample
property keys. Markdown table for Notion — your event taxonomy doc that never goes
stale.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Auto-document your captured event taxonomy
description: >-
  Every event captured in the last 30 days with count, first-seen, last-seen,
  sample property keys. Markdown table for Notion — your event taxonomy doc that
  never goes stale.
category: ops
tags:
  - analytics
  - documentation
  - event-taxonomy
  - ops
  - onboarding
prompt: >-
  List every event we've captured in the last 30 days with its count,
  first-seen, last-seen, and sample property keys. Format as a Markdown table
  for review or publication.
difficulty: beginner
time_to_value: 1 minute
prereqs:
  - Analytics events flowing for at least 30 days
applies_to:
  - universal
required_events:
  - page_view
  - signup_completed
  - feature_used
required_event_properties:
  page_view:
    - path
  signup_completed:
    - source
  feature_used:
    - feature
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
ask_if_missing:
  - >-
    Which observed events map to page_view, signup_completed, feature_used? Are the required signals
    source-verified, and do live PostHog event/property reads show
    real traffic for them?
  - >-
    Which live properties provide page_view.path, signup_completed.source,
    feature_used.feature, and which stable user or account identifier joins the
    signals?
related:
  - signup-funnel
  - activation-moment
  - weekly-changelog
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
```

</details>

## Why this matters

Event taxonomies always drift. The team agrees on `signup_completed` in week 1. Someone on the mobile team ships `signup_complete` (no `d`) in month 3. The web team renames to `user_signed_up` in month 6. By month 12 you have three names for the same conceptual event, four schemas of properties, and the only person who knows which one to query has left.

The fix: a living event-taxonomy document. The trouble: nobody writes one because it goes stale by next quarter. The fix to the fix: auto-generate it from the actual event stream.

Agentry exposes every captured event plus count, first-seen, last-seen, and sample properties. A starter request produces a clean Markdown table ready for review. When a human reruns it for a new window, the delta shows what changed; saving or sharing remains an explicit reviewer choice.

## What you get

- A Markdown table of every event name with count, first-seen, last-seen, and sample properties
- Sorted by volume (so you see the heavy hitters first)
- A "deprecation candidates" section flagging events with zero activity in the last 7 days
- Quick spot for typos (`signup_completed` vs `signup_complete`)

## Walk through it

**You:**
> List every event we've captured in the last 30 days with its count, first-seen, last-seen, and sample property keys. Format as a Markdown table I can paste into Notion.

**Agent:**
> Two passes — `GET /v1/projects/:project_id/event-names` for the inventory, then per-event property keys via HogQL.

```text
Endpoint: GET /v1/projects/:project_id/event-names
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fevent-names&method=get
Use query parameters, not a JSON body.
```
```text
{
  "server_emitted": [
    { "name": "case.created" }, { "name": "case.resolved" }, { "name": "deploy.recorded" }
  ],
  "analytics_events": [
    { "name": "page_view",          "count": 1240000, "first_seen": "2024-08-12", "last_seen": "2026-05-16" },
    { "name": "signup_completed",   "count":    8400, "first_seen": "2024-08-15", "last_seen": "2026-05-16" },
    { "name": "checkout_started",   "count":   42000, "first_seen": "2024-08-20", "last_seen": "2026-05-16" },
    { "name": "order_completed",    "count":   18400, "first_seen": "2024-08-20", "last_seen": "2026-05-16" },
    { "name": "product_viewed",     "count":  410000, "first_seen": "2024-08-20", "last_seen": "2026-05-16" },
    { "name": "signup_complete",    "count":      62, "first_seen": "2025-12-01", "last_seen": "2026-05-15" },
    { "name": "ab_assigned",        "count":  118000, "first_seen": "2025-04-12", "last_seen": "2026-05-16" },
    { "name": "video_uploaded_v2",  "count":     180, "first_seen": "2024-11-01", "last_seen": "2025-09-12" }
  ]
}
```

**Agent:**
> Note: I spotted `signup_complete` (no `d`) with only 62 events — looks like a typo'd version of `signup_completed` (8,400). Also `video_uploaded_v2` hasn't fired since September — deprecation candidate.
>
> Let me fetch sample property keys per event.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "
    select
      event,
      arrayDistinct(arrayFlatten(groupArray(JSONExtractKeys(properties)))) as sample_keys
    from events
    where timestamp > now() - interval 30 day
    group by event
  "
```
```text
{
  "rows": [
    { "event": "page_view",        "sample_keys": ["path", "referrer", "user_agent"] },
    { "event": "signup_completed", "sample_keys": ["source", "plan", "country"] },
    { "event": "checkout_started", "sample_keys": ["cart_value", "item_count", "shipping_method"] },
    { "event": "order_completed",  "sample_keys": ["order_id", "total", "items", "coupon_code"] },
    { "event": "product_viewed",   "sample_keys": ["sku", "category", "price"] },
    { "event": "signup_complete",  "sample_keys": ["source", "plan"] },
    { "event": "ab_assigned",      "sample_keys": ["flag_key", "variant"] },
    { "event": "video_uploaded_v2","sample_keys": ["video_id", "size_bytes", "format"] }
  ]
}
```

**Agent:**
> Here's the Markdown — ready to save or publish in your wiki of choice.

```markdown
# Event taxonomy (auto-generated 2026-05-16)

| Event | 30d count | First seen | Last seen | Sample properties |
|---|---:|---|---|---|
| `page_view` | 1,240,000 | 2024-08-12 | 2026-05-16 | path, referrer, user_agent |
| `product_viewed` | 410,000 | 2024-08-20 | 2026-05-16 | sku, category, price |
| `ab_assigned` | 118,000 | 2025-04-12 | 2026-05-16 | flag_key, variant |
| `checkout_started` | 42,000 | 2024-08-20 | 2026-05-16 | cart_value, item_count, shipping_method |
| `order_completed` | 18,400 | 2024-08-20 | 2026-05-16 | order_id, total, items, coupon_code |
| `signup_completed` | 8,400 | 2024-08-15 | 2026-05-16 | source, plan, country |
| `signup_complete` ⚠ | 62 | 2025-12-01 | 2026-05-15 | source, plan |

## Deprecation candidates (0 activity in last 7 days)

- `video_uploaded_v2` — last seen 2025-09-12 (180 lifetime events)

## Typo / duplicate candidates

- `signup_complete` (62 events) vs `signup_completed` (8,400 events)
  → recommended fix: drop the `signup_complete` callsite, all callers should be on `signup_completed`
```

> I can regenerate this on demand, show the exact delta, and prepare Markdown for you to review before saving or sharing it.

## The output

```
Event taxonomy auto-doc — 2026-05-16

Top events (by 30d volume):
  page_view              1,240,000     props: path, referrer, user_agent
  product_viewed           410,000     props: sku, category, price
  ab_assigned              118,000     props: flag_key, variant
  checkout_started          42,000     props: cart_value, item_count, shipping_method
  order_completed           18,400     props: order_id, total, items, coupon_code
  signup_completed           8,400     props: source, plan, country
  signup_complete ⚠             62     props: source, plan         ← TYPO

Deprecation candidates (no activity in 7d):
  video_uploaded_v2   last: 2025-09-12   (180 lifetime)

Typo / duplicate candidates:
  signup_complete (62)    vs signup_completed (8,400)
    → kill the misnamed callsite

Output saved as Markdown — publish or save to:
  Notion: agentry/events
  Linear doc: agentry-event-taxonomy
  Slack: #data
```

## Setting it up

No setup is required when the connected PostHog project already has useful
history. If there are no events, run `agentry onboard` to distinguish a real
traffic gap from missing or misplaced source instrumentation. Do not manufacture
a synthetic signup merely to populate a taxonomy table.

Once events flow, re-run the prompt. Keep the result as a protected, human-reviewed artifact. This taxonomy uses custom owner-authenticated analysis; do not place that credential or generic HogQL in a scheduler. Save or share the Markdown only after a human reviews the event names, sample properties, and intended audience. Public-query publication is valid only when a real reviewed query blueprint backs the exact bounded result.

## Variations

- *"Same table but include sample event values (top 5 values per property), not just keys. Helps spot bad data."*
- *"Just the typo / duplicate candidates — I want a clean cleanup list."*
- *"For each event, show me how many unique distinct_ids fire it — events with low cardinality are often background-job spam."*
- *"Regenerate for the latest seven-day window, diff it against the prior window, and draft the deltas for #data to review."*
