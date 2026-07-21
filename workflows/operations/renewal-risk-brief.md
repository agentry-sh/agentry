# Generate a renewal-risk brief for each account

Combine usage decline, errors, seat utilization, and support friction into a
renewal-risk brief CS can act on before the renewal date.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Generate a renewal-risk brief for each account
description: >-
  Combine usage decline, errors, seat utilization, and support friction into a
  renewal-risk brief CS can act on before the renewal date.
category: ops
tags:
  - analytics
  - revenue
  - customer-success
  - renewals
  - account-health
  - b2b
prompt: >-
  Generate renewal-risk briefs for accounts renewing in the next 60 days.
  Include usage trend, errors, seat utilization, support friction, and
  recommended CS action.
difficulty: advanced
time_to_value: 10 minutes
prereqs:
  - >-
    Account events include account_id and renewal_date or a renewal cohort
    property
  - 'Usage, seat, and support signals are tagged by account_id'
applies_to:
  - b2b-saas
  - devtools-api
  - enterprise-sales
requires_revenue: true
requires_b2b: true
required_events:
  - renewal_upcoming
readiness_events:
  - renewal_upcoming
required_event_properties:
  renewal_upcoming:
    - account_id
    - renewal_date
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
  - >-
    Do not recommend this for products without a real revenue lifecycle or an
    equivalent paid-account signal.
  - >-
    Do not recommend this when the product has no stable account or workspace
    identity.
ask_if_missing:
  - >-
    Which observed events map to renewal_upcoming? Are the required signals
    source-verified, and do live PostHog event/property reads show real traffic
    for them?
  - >-
    Which live properties provide renewal_upcoming.account_id,
    renewal_upcoming.renewal_date, and which stable user or account identifier
    joins the signals?
related:
  - account-health-score
  - dormant-account-revival
  - csm-book-of-business-digest
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

## Why this matters

CS teams do not need another dashboard. They need a brief: what changed, why the account is at risk, and what to do before renewal.

## What you get

- Accounts renewing soon
- Usage trend and seat utilization
- Error/support friction
- Recommended CS motion for each account

## Walk through it

**You:**
> Which renewals are at risk this quarter?

**Agent:**
> I'll find renewal cohorts and join them with usage and friction signals.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.account_id AS account, argMax(properties.renewal_date, timestamp) AS renewal_date, count() AS recent_events FROM events WHERE timestamp > now() - INTERVAL 60 DAY GROUP BY account HAVING renewal_date != '' ORDER BY renewal_date ASC LIMIT 50"
```

## The output

The agent returns one brief per account: risk level, evidence, and action. It should be written for a CSM, not for an engineer.

## Setting it up

Emit `renewal_upcoming` or attach renewal date to account snapshot events. Keep account IDs consistent across usage, errors, and billing.

## Variations

- *"Only include enterprise renewals."*
- *"Draft the CSM email for the top three at-risk accounts."*
- *"Create a weekly renewal-risk digest."*
