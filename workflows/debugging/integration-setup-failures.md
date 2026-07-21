# Find integration setup failures

Show where customers fail while connecting integrations so engineering and CS can fix
the highest-impact setup blockers.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Find integration setup failures
description: >-
  Show where customers fail while connecting integrations so engineering and CS
  can fix the highest-impact setup blockers.
category: debugging
tags:
  - analytics
  - errors
  - integrations
  - onboarding
  - customer-success
  - engineering
prompt: >-
  Find integration setup failures by integration, setup step, account, and error
  code. Prioritize blockers affecting the most accounts.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - >-
    Integration setup events include account_id, integration_type, setup_step,
    and error_code
applies_to:
  - b2b-saas
  - devtools-api
  - open-source
required_events:
  - integration_setup_started
  - integration_setup_failed
  - integration_setup_succeeded
readiness_events:
  - integration_setup_failed
required_event_properties:
  integration_setup_started:
    - account_id
    - integration_type
  integration_setup_failed:
    - account_id
    - integration_type
    - setup_step
    - error_code
  integration_setup_succeeded:
    - account_id
    - integration_type
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
ask_if_missing:
  - >-
    Which observed events map to integration_setup_started,
    integration_setup_failed, integration_setup_succeeded? Are the required signals
    source-verified, and do live PostHog event/property reads show
    real traffic for them?
  - >-
    Which live properties provide integration_setup_started.account_id,
    integration_setup_started.integration_type,
    integration_setup_failed.account_id,
    integration_setup_failed.integration_type,
    integration_setup_failed.setup_step, integration_setup_failed.error_code,
    integration_setup_succeeded.account_id,
    integration_setup_succeeded.integration_type, and which stable user or
    account identifier joins the signals?
related:
  - docs-to-api-funnel
  - customer-investigation
  - api-latency-by-route
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

## Why this matters

Integrations are often the real activation moment for B2B and devtool products. A failed setup is not just a bug; it is a stalled customer.

## What you get

- Setup failure rate by integration
- The step and error code causing the most blocked accounts
- A short list of accounts CS should help
- Engineering actions ranked by affected accounts

## Walk through it

**You:**
> Which integrations are failing during setup?

**Agent:**
> I'll compare setup starts, failures, and completions by integration and setup step.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.integration_type AS integration, properties.setup_step AS step, properties.error_code AS error_code, count() AS failures, count(DISTINCT properties.account_id) AS accounts FROM events WHERE event = 'integration_setup_failed' AND timestamp > now() - INTERVAL 30 DAY GROUP BY integration, step, error_code ORDER BY accounts DESC, failures DESC LIMIT 20"
```

```text
{
  "rows": [
    { "integration": "salesforce", "step": "oauth_callback", "error_code": "invalid_scope", "failures": 42, "accounts": 17 }
  ]
}
```

**Agent:**
> Salesforce OAuth scope failures are blocking 17 accounts. I'll check whether any open cases match this pattern.

```text
Endpoint: GET /v1/projects/:project_id/cases
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fcases&method=get
Use query parameters, not a JSON body.
Query/filter concept:
  status: "open"
```

## The output

The agent returns the integrations, setup steps, error codes, and affected-account counts that deserve action first. It should separate product-copy fixes from backend defects and CS follow-up.

## Setting it up

Emit setup lifecycle events for each integration. Include the account, integration name, setup step, and normalized error code so failures can be grouped cleanly.

## Variations

- *"Which integration setup failures affect enterprise accounts?"*
- *"Show failed setup by integration version."*
- *"Draft a CS follow-up list for blocked accounts."*
