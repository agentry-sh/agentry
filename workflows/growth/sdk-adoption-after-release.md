# Track SDK adoption after release

Measure whether developers upgrade to a new customer-facing SDK version after launch and
which accounts remain behind.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Track SDK adoption after release
description: >-
  Measure whether developers upgrade to a new customer-facing SDK version after
  launch and which accounts remain behind.
category: growth
tags:
  - analytics
  - deploys
  - sdk
  - releases
  - devtools
  - product
prompt: >-
  After the latest SDK release, show adoption by version, language, account, and
  API usage. Identify accounts still on old versions.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - >-
    Customer SDK usage events include sdk_version, language, account_id, and
    endpoint
applies_to:
  - devtools-api
  - open-source
  - b2b-saas
required_events:
  - sdk_initialized
  - sdk_method_called
readiness_events:
  - sdk_initialized
required_event_properties:
  sdk_initialized:
    - sdk_version
    - language
    - account_id
  sdk_method_called:
    - sdk_version
    - language
    - account_id
    - endpoint
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
ask_if_missing:
  - >-
    Which observed events map to sdk_initialized, sdk_method_called? Are the required signals
    source-verified, and do live PostHog event/property reads show
    real traffic for them?
  - >-
    Which live properties provide sdk_initialized.sdk_version,
    sdk_initialized.language, sdk_initialized.account_id,
    sdk_method_called.sdk_version, sdk_method_called.language,
    sdk_method_called.account_id, sdk_method_called.endpoint, and which stable
    user or account identifier joins the signals?
related:
  - app-version-distribution
  - api-usage-by-customer
  - docs-to-api-funnel
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

## Why this matters

SDK launches do not create value until customers actually upgrade. Product and developer relations teams need to know whether a release is spreading or sitting unread in a changelog.

## What you get

- Adoption curve by SDK version and language
- Accounts still using deprecated versions
- API usage volume by version
- Upgrade targets for CS or developer relations

## Walk through it

**You:**
> Did customers adopt the SDK version we released last week?

**Agent:**
> I'll find the latest release, then group SDK initialization and method calls by version.

```text
Endpoint: GET /v1/projects/:project_id/deploys
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fdeploys&method=get
Use query parameters, not a JSON body.
Query/filter concept:
  limit: 5
```

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.sdk_version AS version, properties.language AS language, count(DISTINCT properties.account_id) AS accounts, count() AS events FROM events WHERE event IN ('sdk_initialized','sdk_method_called') AND timestamp > now() - INTERVAL 30 DAY GROUP BY version, language ORDER BY accounts DESC"
```

## The output

The agent returns adoption by version and language, then calls out large customers still on old versions. It should recommend docs, outreach, or compatibility fixes depending on the pattern.

## Setting it up

Emit SDK usage events from the customer's application or API edge when requests include SDK metadata. Do not imply Agentry has an SDK; this workflow is about your product's customer-facing SDKs.

## Variations

- *"Show Python SDK adoption after the release."*
- *"Which enterprise accounts are still on deprecated versions?"*
- *"Compare error rate by SDK version."*
