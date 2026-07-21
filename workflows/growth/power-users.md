# Identify your most engaged users and accounts

Rank pseudonymous users or accounts with a reviewed product-value definition, keep
identities private, and use the result as research evidence rather than an outreach
command.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Identify your most engaged users and accounts
description: >-
  Rank pseudonymous users or accounts with a reviewed product-value definition,
  keep identities private, and use the result as research evidence rather than
  an outreach command.
category: growth
tags:
  - analytics
  - retention
  - customer-success
  - product-research
  - privacy
  - human-review
prompt: >-
  Identify the most engaged users or accounts for a defined period using
  verified product-value events and a reviewed weighting rule. Return
  pseudonymous IDs by default, explain the formula and bias, and stop before
  outreach.
difficulty: intermediate
time_to_value: 10 minutes
prereqs:
  - >-
    A stable pseudonymous user or account identifier is present on product-value
    events
  - >-
    The team has defined which events represent meaningful value, not raw
    activity
applies_to:
  - b2c-saas
  - b2b-saas
  - devtools-api
  - content-media
  - marketplace
required_events:
  - product_value_completed
required_event_properties:
  product_value_completed:
    - value_type
    - account_id
negative_fit:
  - >-
    Do not rank people from total event volume or arbitrary revenue weights that
    were chosen after seeing the result.
  - >-
    Do not return emails or personal data when pseudonymous user or account IDs
    answer the question.
  - >-
    Do not automatically email, upsell, survey, or target anyone from the
    ranking.
ask_if_missing:
  - >-
    Which observed events represent delivered product value, and should the unit
    be user, account, workspace, or organization?
  - >-
    What exact period, minimum activity threshold, exclusions, and weighting
    rule should be reviewed before querying?
  - >-
    Who is authorized to resolve pseudonymous IDs if a later research or
    customer-success action is approved?
related:
  - activation-moment
  - account-health-score
  - feature-launch-adoption
execution_mode: human_review
required_resources:
  - signal_map
  - onboarding_state
  - analytics
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
featured: false
example_only: true
```

</details>

## Why this matters

Highly engaged users can reveal durable product value, emerging workflows, and
research candidates. Raw event count is a poor proxy: background jobs,
pageviews, API polling, large accounts, and billing events can dominate a
leaderboard without representing deeper value.

Define the unit and value events before querying. Keep identities pseudonymous
until a separately authorized human workflow genuinely needs contact details.

## What you get

- A reviewed definition of meaningful engagement
- Pseudonymous user or account rankings for an exact period
- Component counts, not just an opaque score
- Bias and coverage notes plus a human decision about any follow-up

## Walk through it

**You:**
> Which accounts used our core workflow most deeply this month?

**Agent:**
> I need the approved value events, ranking unit, and period. I will not use
> emails or treat billing events as engagement by default.

```http
GET /v1/projects/:project_id/signal-map
GET /v1/projects/:project_id/onboarding
# Require source-verified signals; use live PostHog reads for current evidence.
GET /v1/projects/:project_id/event-names
GET /v1/projects/:project_id/event-property-keys?events=product_value_completed
```

Run a bounded owner-side aggregate query after the definition is fixed:

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Query plan:
  - bind the exact period and selected product-value events
  - group by stable pseudonymous account_id or distinct_id
  - return component event counts and active days
  - apply the reviewed weighting rule, if any
  - exclude internal, test, synthetic, and automation traffic
  - return no email, name, message body, or unrelated profile property
```

```json
{
  "rows": [
    {
      "account_id": "acct_opaque_1",
      "active_days": 19,
      "value_events": 84,
      "value_types": 3,
      "reviewed_score": 112
    }
  ]
}
```

## The output

```text
Engagement review — <exact period>

Definition
- unit: account
- value events: <list>
- weighting: <formula or none>
- exclusions: <internal/test/automation>

Top evidence rows
1. <pseudonymous account> — <components and score>
2. <pseudonymous account> — <components and score>

Coverage and bias
- <missing clients, account-size effect, automation, identity gaps>

Human follow-up decision
- research candidate | customer-success review | no action
```

An account being active does not prove satisfaction, willingness to pay, or
permission to contact. Resolve identity only after a reviewer selects a valid
purpose and confirms the appropriate customer relationship and channel.

## Setting it up

Use stable pseudonymous identifiers and send only the properties needed for the
analysis. Define value events from real product logic—for example, a report
delivered, workflow completed, integration used successfully, or API outcome
returned—not generic pageviews or every request.

Record internal, test, synthetic, and automation traffic so it can be excluded.
Do not copy email addresses into every analytics event merely to make rankings
convenient.

## Variations

- *"Rank accounts by distinct value workflows, not total event count."*
- *"Compare this month's top cohort with last month's using the same frozen definition."*
- *"Show only pseudonymous accounts with activity across at least five separate days."*
- *"Prepare a research-candidate list for human review; do not resolve identities yet."*
