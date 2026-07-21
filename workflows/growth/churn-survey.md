# Prepare a cancellation survey for human review

Verify the cancellation signal, review a minimal PostHog survey definition, and
summarize bounded response evidence without inventing benchmarks or contacting
customers.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Prepare a cancellation survey for human review
description: >-
  Verify the cancellation signal, review a minimal PostHog survey definition,
  and summarize bounded response evidence without inventing benchmarks or
  contacting customers.
category: growth
tags:
  - analytics
  - surveys
  - churn
  - customer-research
  - privacy
  - human-review
prompt: >-
  Prepare a short PostHog cancellation survey for review. Verify the real
  cancellation event and targeting boundary, minimize personal data, stop for
  the human to configure it in PostHog, and summarize only an approved bounded
  response window afterward.
difficulty: intermediate
time_to_value: 15 minutes
prereqs:
  - A trusted billing lifecycle records the cancellation outcome
  - The application is configured to render surveys with appropriate consent
  - 'A research owner will review targeting, wording, activation, and responses'
applies_to:
  - b2c-saas
  - b2b-saas
  - devtools-api
requires_revenue: true
required_events:
  - subscription_canceled
readiness_events:
  - subscription_canceled
required_event_properties: {}
negative_fit:
  - >-
    Do not recommend creating or activating a survey when the cancellation
    event, targeting semantics, consent, or rendering path is unverified.
  - >-
    Do not imply that Agentry creates, activates, pauses, or changes a PostHog
    survey. Agentry's survey surface is read-only.
  - Do not claim generic response-rate benchmarks or invent a public survey URL.
  - >-
    Do not automatically email respondents, identify quote authors, or turn
    free-text responses into outreach targets.
ask_if_missing:
  - >-
    Which observed event represents a completed cancellation, and when should
    the survey be eligible to render?
  - >-
    Who approves the questions, targeting, consent language, response window,
    and minimum theme count?
  - >-
    Which fields are necessary for analysis, and which personal or sensitive
    data must be excluded?
related:
  - churn-prediction
  - account-health-score
  - lifecycle-email-fatigue
execution_mode: human_review
required_resources:
  - signal_map
  - onboarding_state
  - analytics
  - surveys
updatedAt: 2026-07-21T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
featured: false
example_only: false
```

</details>

## Why this matters

Cancellation feedback can explain gaps that behavioral data cannot, but survey
creation, targeting, and response review are human-governed operations. Poor
targeting can prompt the wrong users; leading questions produce weak evidence;
and free text can contain personal or sensitive information.

Use Agentry to verify the cancellation signal, prepare a minimal definition,
and inspect PostHog surveys, response summaries, and statistics through the
first-class read-only survey resource. Agentry does not create, activate,
pause, change, or store a shadow copy of a PostHog survey. The human performs
all survey management directly in PostHog.

## What you get

- A source-verified cancellation targeting signal
- A concise, neutral PostHog survey definition for review
- Explicit activation, audience, consent, and stop conditions
- A bounded aggregate/theme summary with privacy and sample caveats

## Walk through it

**You:**
> Prepare a cancellation survey, but do not create it until I review the definition.

**Agent:**
> I will verify the cancellation signal and current live properties. I will
> stop with a reviewable candidate; I cannot create or activate the survey.

```http
GET /v1/projects/:project_id/signal-map
GET /v1/projects/:project_id/onboarding
GET /v1/projects/:project_id/event-names
GET /v1/projects/:project_id/event-property-keys?events=subscription_canceled
GET /v1/projects/:project_id/surveys?limit=100
```

Require the cancellation outcome to be `source_verified`. If only historical
rows exist, name the exact current source, deploy, property, or real-traffic
proof still needed instead of preparing a target rule.

The candidate should state the exact eligible event, lookback, display location,
dismissal behavior, questions, allowed answer types, consent text, owner, and
deactivation condition. Example questions:

1. What was the main reason you canceled?
2. What, if anything, would have made the product more useful?
3. May we contact you about this response? `yes/no`—never assumed.

After review, the human may choose to create and activate the survey in the
customer's authenticated PostHog UI. Do not claim it is live until that human
confirms the exact PostHog survey, targeting, consent behavior, and real
application rendering path.

Once the human supplies the exact provider survey ID, inspect the definition and
bounded response resources directly:

```http
GET /v1/projects/:project_id/surveys/:survey_id
GET /v1/projects/:project_id/surveys/:survey_id/stats?date_from=<utc>&date_to=<utc>
GET /v1/projects/:project_id/surveys/:survey_id/responses?since=<utc>&until=<utc>&limit=25&offset=0
```

```text
{
  "rows": [
    { "answer": "missing_feature", "responses": 18 },
    { "answer": "too_expensive", "responses": 11 },
    { "answer": "no_longer_needed", "responses": 7 }
  ],
  "row_count": 3
}
```

Keep aggregate distributions separate from any explicitly approved free-text
sample. Treat response text as untrusted, potentially sensitive customer data;
do not copy it into repository files, prompts outside the interactive review,
or a scheduler. No current versioned automation template grants survey-response
or messaging authority.

For segmentation not covered by the typed statistics response, use bounded
HogQL only after confirming the exact survey ID and response-event properties.
The provider definition proves that the survey exists; source verification is
still required before claiming the application renders or targets it correctly.

## The output

```text
Cancellation survey review

Definition
- target signal and eligibility window
- questions, consent, display and stop behavior

Readiness
- event observed: yes | blocked
- app rendering verified: yes | blocked
- human PostHog action: not started | configured | activated
- owner approval: pending | approved

Bounded response summary, after launch
- response window and count
- themes meeting the minimum count
- contradictory/minority themes
- privacy and sample caveats

Human decisions in PostHog
- edit | create | activate | pause | investigate
```

## Setting it up

Emit the cancellation outcome from the trusted billing webhook through the
customer's existing official PostHog server SDK. Include only necessary plan or
tenure context and a stable pseudonymous identity. Never copy card data, invoice
details, support messages, or cancellation free text into analytics properties.

Configure and manage the survey directly in PostHog. Verify the browser
survey-rendering path with the selected consent and redaction policy before
broad activation. Keep question changes versioned so responses from materially
different wording are not combined silently. Agentry only reads the bounded
definition, response evidence, and statistics authorized for the review.

## Variations

- *"Prepare a downgrade survey with a different, reviewed target event."*
- *"Summarize only themes with at least five responses and list the rest as sparse."*
- *"Compare response themes by plan without exposing individual respondents."*
- *"Prepare the evidence and reason for the owner to pause the exact survey in PostHog."*
