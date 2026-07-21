# Publish verified aggregate metrics safely

Approve a bounded aggregate query, publish only its reviewed blueprint, and embed the
returned public URL without exposing owner credentials or identities.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Publish verified aggregate metrics safely
description: >-
  Approve a bounded aggregate query, publish only its reviewed blueprint, and
  embed the returned public URL without exposing owner credentials or
  identities.
category: ops
tags:
  - analytics
  - public-queries
  - content-marketing
  - privacy
  - dashboards
  - human-review
prompt: >-
  Prepare one public aggregate metric from a verified signal. Confirm the exact
  definition, privacy threshold, and safe query blueprint, show the rows before
  publication, and wait for human approval before creating or embedding the
  public query.
difficulty: intermediate
time_to_value: 10 minutes
prereqs:
  - The metric's source events and properties are verified with real traffic
  - A safe aggregate query blueprint already exists or will be reviewed in code
  - A human is authorized to publish the exact metric and audience
applies_to:
  - universal
required_events:
  - product_value_completed
readiness_events:
  - product_value_completed
required_event_properties: {}
negative_fit:
  - >-
    Do not publish raw users, accounts, sessions, cases, messages, rare
    segments, or other re-identifiable rows.
  - >-
    Do not publish custom HogQL directly or put a private owner credential in a
    page, worker, build, or scheduler.
  - >-
    Do not create a public query until the metric definition, blueprint safety,
    sample threshold, and audience are reviewed.
ask_if_missing:
  - >-
    Which observed event and exact aggregate define the metric, including
    timezone, period, and denominator?
  - >-
    Which reviewed query blueprint produces it, and what privacy or
    minimum-sample threshold applies?
  - >-
    Who approves publication, where will the returned URL appear, and when
    should it be revoked?
related:
  - signup-funnel
  - weekly-changelog
  - event-taxonomy-document
execution_mode: human_review
required_resources:
  - signal_map
  - onboarding_state
  - query_blueprints
  - public_queries
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
example_only: false
featured: false
```

</details>

## Why this matters

A public metric is a disclosure boundary, not merely a chart. The wrong query
can expose identities, small cohorts, internal operations, or a number whose
definition changes silently.

Agentry public queries are safe when they publish a reviewed aggregate query
blueprint with fixed, validated parameters. Custom owner-side HogQL is not
directly publishable. If no suitable blueprint exists, the workflow ends with a
code-review task for a new safe aggregate blueprint.

## What you get

- A precise metric definition and answerability check
- A preview from the same reviewed blueprint that would be published
- Human approval of audience, privacy threshold, wording, and lifetime
- The returned revocable `public_url`, with no deployed owner credential

## Walk through it

**You:**
> Publish our verified three-step signup funnel on the marketing site.

**Agent:**
> I will verify the exact events and preview the approved aggregate blueprint.
> Publication remains a separate human-approved action.

```http
GET /v1/projects/:project_id/signal-map
GET /v1/projects/:project_id/onboarding
# Require source-verified signals; use live PostHog reads for current evidence.
GET /v1/query-blueprints/funnel_3_step
POST /v1/projects/:project_id/query-blueprints/funnel_3_step/run
```

After the reviewer confirms the rows, time window, sample, audience, and wording:

```text
Endpoint: POST /v1/projects/:project_id/public-queries
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fpublic-queries&method=post
Concept fields:
  blueprint_id: funnel_3_step
  params: <the exact reviewed params>
  description: <public definition and period>
```

Use the actual `public_url` returned by Agentry. Do not invent publication IDs
or reconstruct the URL from an assumed pattern.

## The output

```text
Public metric review

Definition
- source events, ordered logic, exact period, denominator, timezone

Preview
- aggregate rows and sample size from the reviewed blueprint

Privacy
- no identities or rare segments
- minimum sample and disclosure notes

Publication
- approval owner: <human>
- destination: <site/page>
- returned public_url: <only after approval and creation>
- revoke/review date: <date>
```

## Setting it up

Embed or fetch the returned URL exactly as documented by its response. Do not
append undocumented query parameters or place `AGENTRY_PRIVATE_API_KEY` in
browser code, static-site builds, edge workers, or unattended schedulers.

Review existing publications with the project public-query list and revoke any
URL whose purpose has ended. A publication should fail closed when its blueprint
or parameters are no longer safe or valid.

## Variations

- *"Preview a verified retention aggregate, but do not publish it."*
- *"Explain why this requested metric needs a new safe blueprint."*
- *"Review all current public-query URLs and their stated purpose."*
- *"Revoke a selected publication after the owner confirms the exact ID."*
