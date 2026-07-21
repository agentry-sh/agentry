# Weekly CSM book-of-business digest

Create a weekly account digest for each CSM with risks, expansion signals, product
adoption, and customers needing outreach.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Weekly CSM book-of-business digest
description: >-
  Create a weekly account digest for each CSM with risks, expansion signals,
  product adoption, and customers needing outreach.
category: ops
tags:
  - analytics
  - customer-success
  - digest
  - human-review
  - b2b
  - revenue
prompt: >-
  Create a weekly CSM book-of-business digest: at-risk accounts, expansion
  signals, product adoption changes, and suggested outreach for each CSM.
difficulty: intermediate
time_to_value: 10 minutes
prereqs:
  - Account events include account_id and csm_owner or territory
  - Usage and revenue signals are tagged by account_id
applies_to:
  - b2b-saas
  - devtools-api
  - enterprise-sales
requires_b2b: true
required_events:
  - account_snapshot
readiness_events:
  - account_snapshot
required_event_properties:
  account_snapshot:
    - account_id
    - csm_owner
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
  - >-
    Do not recommend this when the product has no stable account or workspace
    identity.
  - >-
    Do not automatically send, publish, suppress, mutate, or contact anyone from
    this workflow.
ask_if_missing:
  - >-
    Which observed events map to account_snapshot? Are the required signals
    source-verified, and do live PostHog event/property reads show real traffic
    for them?
  - >-
    Which live properties provide account_snapshot.account_id,
    account_snapshot.csm_owner, and which stable user or account identifier
    joins the signals?
related:
  - account-health-score
  - renewal-risk-brief
  - weekly-agent-digest
execution_mode: human_review
required_resources:
  - analytics
publishedAt: 2026-05-26T00:00:00.000Z
updatedAt: 2026-07-10T00:00:00.000Z
```

</details>

## Why this matters

CSMs operate from notes, Slack, and stale dashboards. A book-of-business digest gives them a prioritized list every week without a BI analyst.

## What you get

- Accounts needing outreach
- Expansion and champion signals
- Usage drops and support friction
- Suggested next action per account

## Walk through it

**You:**
> Build this week's digest for each CSM.

**Agent:**
> I'll group account signals by CSM owner and write short action briefs.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.csm_owner AS csm, properties.account_id AS account, count() AS events_7d, max(timestamp) AS last_seen FROM events WHERE timestamp > now() - INTERVAL 7 DAY AND properties.account_id IS NOT NULL GROUP BY csm, account ORDER BY csm, events_7d DESC"
```

## The output

The agent returns one digest per CSM with high-signal bullets. It should avoid flooding the CSM with healthy accounts unless there is an expansion opportunity.

## Setting it up

Emit account snapshot or usage events with `account_id` and `csm_owner`. Provide each CSM's preferred brief format in the interactive prompt or keep it in your team's existing reviewed configuration; do not rely on undocumented agent-local state.

This query exposes account-level activity and uses owner-authenticated custom analytics, so run it in a human-controlled session. A runner cannot receive raw accounts or generic HogQL, and this page does not grant authority to contact customers. The reviewer chooses what to share and with whom.

## Variations

- *"Only show accounts with a health score drop."*
- *"Create a version for the VP CS."*
- *"Prepare this for the latest seven-day window and let the CSM review it before choosing any recipients."*
