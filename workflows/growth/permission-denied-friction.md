# Find permission-denied friction in B2B apps

Surface users and accounts repeatedly hitting 403s, role gates, or missing-seat paths so
product can fix admin and permission UX.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Find permission-denied friction in B2B apps
description: >-
  Surface users and accounts repeatedly hitting 403s, role gates, or
  missing-seat paths so product can fix admin and permission UX.
category: growth
tags:
  - analytics
  - b2b
  - permissions
  - product
  - activation
  - customer-success
prompt: >-
  Show permission-denied friction for the last 14 days: users hitting role
  gates, accounts with repeated 403s, and the features they were trying to
  access.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - >-
    `permission_denied` events include account_id, feature, role, and
    required_role
applies_to:
  - b2b-saas
  - enterprise-sales
  - internal-tool
requires_b2b: true
required_events:
  - permission_denied
readiness_events:
  - permission_denied
required_event_properties:
  permission_denied:
    - account_id
    - feature
    - role
    - required_role
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
  - >-
    Do not recommend this when the product has no stable account or workspace
    identity.
ask_if_missing:
  - >-
    Which observed events map to permission_denied? Are the required signals
    source-verified, and do live PostHog event/property reads show real traffic
    for them?
  - >-
    Which live properties provide permission_denied.account_id,
    permission_denied.feature, permission_denied.role,
    permission_denied.required_role, and which stable user or account identifier
    joins the signals?
related:
  - seat-utilization
  - onboarding-checklist-dropoff
  - feature-entitlement-friction
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

## Why this matters

In B2B products, the buyer and user are often different people. Permission errors are not just security events; they are product friction, support tickets, and expansion signals.

## What you get

- Features most often blocked by permissions
- Accounts where non-admin users repeatedly hit gates
- Role gaps that suggest better invite/admin UX
- Follow-up users for CS or product research

## Walk through it

**You:**
> Where are users getting blocked by permissions?

**Agent:**
> I'll group permission-denied events by account, feature, and role.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.account_id AS account, properties.feature AS feature, properties.role AS role, properties.required_role AS required_role, count() AS denied_count, count(DISTINCT distinct_id) AS users FROM events WHERE event = 'permission_denied' AND timestamp > now() - INTERVAL 14 DAY GROUP BY account, feature, role, required_role ORDER BY denied_count DESC LIMIT 50"
```

## The output

The agent returns a ranked list and suggests whether the fix is copy, permission defaults, admin nudges, or sales/CS outreach.

## Setting it up

Emit `permission_denied` anywhere the app blocks a user for role or plan reasons. Include both current role and required role.

## Variations

- *"Show only paying accounts."*
- *"Find users who got blocked and then churned."*
- *"Draft a product issue for the top blocked workflow."*
