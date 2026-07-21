# Review customers nearing their API caps

Rank customers by monthly API quota consumption, show threshold and projection evidence,
and prepare human-reviewed account outreach without sending it.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Review customers nearing their API caps
description: >-
  Rank customers by monthly API quota consumption, show threshold and projection
  evidence, and prepare human-reviewed account outreach without sending it.
category: ops
tags:
  - analytics
  - devtools-api
  - api-quota
  - customer-success
  - human-review
prompt: >-
  Review customers at or above 80% of their monthly API quota. Show calls used,
  cap source, projected month-end usage, threshold band, and recent usage
  change. Draft account notes but do not contact customers or change limits.
difficulty: intermediate
time_to_value: 10 minutes
prereqs:
  - api_request events include customer_id and plan
  - The reviewer provides or verifies the authoritative plan-to-cap mapping
applies_to:
  - devtools-api
required_events:
  - api_request
required_event_properties:
  api_request:
    - customer_id
    - plan
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
  - >-
    Do not automatically send, publish, suppress, mutate, or contact anyone from
    this workflow.
ask_if_missing:
  - >-
    Which observed events map to api_request? Are the required signals
    source-verified, and do live PostHog event/property reads show real traffic for
    them?
  - >-
    Which live properties provide api_request.customer_id, api_request.plan, and
    which stable user or account identifier joins the signals?
related:
  - api-usage-by-customer
  - api-usage-as-upsell-signal
  - rate-limit-spikes
execution_mode: human_review
required_resources:
  - analytics
publishedAt: 2026-05-16T00:00:00.000Z
updatedAt: 2026-07-10T00:00:00.000Z
```

</details>

## Why this matters

A customer approaching a monthly cap may face an outage, a legitimate growth
event, or a runaway integration. The same number can lead to very different
decisions. Review usage, remaining quota, month-end projection, plan source,
and recent deploy context before recommending outreach or a limit change.

## Run the review

Prove `api_request.customer_id` and `api_request.plan` are answer-ready through
the source-verified signal map and live PostHog event-property metadata. Then
fetch the filtered schema for
`POST /v1/projects/:project_id/analytics/query` and, in the interactive owner
session, calculate one bounded row per customer:

```text
customer_id
plan
calls_this_month
authoritative_cap
percent_used
calls_last_24h
projected_month_end
```

The cap mapping must come from an authoritative billing or product source
provided by the reviewer. Do not infer limits from plan names. Use minimum
volume checks so a test account does not dominate the result.

Classify rows for review:

- 80–89%: verify expected growth and remaining days;
- 90–99%: identify the owning team and likely cap date;
- 100% or projected above cap: distinguish growth from a runaway loop;
- sudden step-change: compare with recent deploys and endpoint mix.

## Output format

```text
Quota review — <month and UTC as_of>

Customer | Plan | Used / cap | Projected | Change | Evidence
<id>     | <p>  | <n>/<n>    | <n>       | <n>%   | <source>

Needs account-owner review
- <customer> — <why> — <questions to answer before outreach>

Possible technical anomaly
- <customer> — <endpoint/deploy evidence> — <next investigation>

Draft account note
- <customer> — <draft only; not sent>
```

Customer IDs, plan data, and usage are owner-visible data. Keep the result in
the human-controlled session. A human chooses whether to contact an account,
change a cap, or share a summary.

## Instrumentation

Capture usage through the customer's existing official PostHog server SDK with
a stable customer ID:

```ts
posthog.capture({
  distinctId: user.id,
  event: "api_request",
  properties: {
    customer_id: account.id,
    plan: account.plan,
    endpoint: request.route,
  },
});
```

Run `agentry onboard` to review volume, route normalization, and the exact
request outcome. Keep account outreach human-reviewed.

## Unattended boundary

No current versioned automation template grants a runner raw customer usage,
generic HogQL, messaging, or quota mutation. Do not install an owner key in a
scheduler or use agent-local state for deduplication. Keep this review on
demand until a narrow server-owned source and explicit policy exist.

## Variations

- *"Compare this month with the same elapsed days last month."*
- *"Break sudden growth down by endpoint to find runaway loops."*
- *"Show accounts with no usage after a historically active period."*
- *"Draft a CS handoff for the top five accounts; do not send it."*
