# Review bounded PostHog session-recording metadata

Bind structured evidence to one authorized recording, inspect its bounded metadata, and
give the human the exact PostHog player handoff.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Review bounded PostHog session-recording metadata
description: >-
  Bind structured evidence to one authorized recording, inspect its bounded
  metadata, and give the human the exact PostHog player handoff.
category: debugging
tags:
  - analytics
  - replay
  - customer-support
  - privacy
  - debugging
  - human-review
prompt: >-
  Prepare one authorized session-replay review for this reported problem.
  Confirm consent and redaction, bind the exact identity and time window from
  structured evidence, read only bounded recording metadata, and stop for me to
  decide whether to open the PostHog player. Do not fetch snapshots, change
  code, or contact the customer.
difficulty: advanced
time_to_value: 10 minutes
prereqs:
  - 'Replay is enabled with appropriate consent, sampling, and redaction'
  - The requester is authorized to inspect this customer's recording
  - 'The report includes an exact project, stable identity, and time window'
applies_to:
  - b2c-saas
  - b2b-saas
  - ecommerce
  - marketplace
  - content-media
required_events:
  - page_view
  - outcome_failed
readiness_events:
  - page_view
required_event_properties:
  page_view:
    - $session_id
  outcome_failed:
    - $session_id
negative_fit:
  - >-
    Do not inspect replay without authorization, consent, redaction, and a
    specific support or debugging purpose.
  - >-
    Do not ask Agentry to fetch rrweb snapshots or infer clicks, form contents,
    network failures, or root cause from metadata or event timestamps alone.
  - >-
    Do not expose raw identities, form values, tokens, payment data, or
    unrelated parts of the session.
ask_if_missing:
  - >-
    Which exact project, authorized distinct_id, reported timestamp, and
    expected outcome identify the relevant recording?
  - 'Which consent, sampling, and redaction policy applies to this user and page?'
  - >-
    Will the authorized human open the returned PostHog player link, and how
    will any relevant visible observations be reported without sensitive data?
related:
  - customer-investigation
  - deploy-regression
  - frontend-performance-regression
execution_mode: human_review
required_resources:
  - signal_map
  - onboarding_state
  - analytics
  - cases
  - session_recordings
updatedAt: 2026-07-21T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
featured: false
example_only: false
```

</details>

Bind structured evidence to one authorized recording, inspect its bounded
metadata, and give the human the exact PostHog player handoff.

## Why this matters

A stack can show where code failed; a replay can show visible interaction around
the failure. Neither proves root cause by itself. Replays are also high-risk
customer data and should be inspected only for a specific authorized purpose.

Agentry exposes session recordings as a first-class read-only resource. It can
list and inspect bounded metadata, correlate a recording with structured events
and a case, and return the authenticated PostHog player URL. It never fetches,
proxies, renders, or stores rrweb snapshots or replay video. An authorized human
decides whether to open the player in PostHog.

## What you get

- A bounded candidate recording selected by exact identity and time bounds
- Provider metadata and the exact PostHog player URL
- Structured outcome, case, and release evidence for that session
- An explicit human checkpoint before any recording is opened in PostHog
- Human-reported visible observations kept separate from technical evidence and
  hypotheses

## Walk through it

**You:**
> Review the consented replay for the checkout problem reported at 14:20 UTC.

**Agent:**
> I will confirm the authorized identity and policy, read bounded candidate
> metadata, and correlate it with structured evidence. I will not fetch replay
> snapshots or render the recording.

```http
GET /v1/projects/:project_id/signal-map
GET /v1/projects/:project_id/onboarding
GET /v1/projects/:project_id/event-property-keys?events=page_view,outcome_failed
GET /v1/projects/:project_id/session-recordings?limit=50&offset=0
GET /v1/projects/:project_id/session-recordings/:recording_id
```

Require the outcome and session join to be `source_verified`. If only historical
rows match, name the exact source, deploy, `$session_id` property, or real-traffic
proof still needed. Do not copy an email address into documentation or logs; use
the approved stable project identity only at call time.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Query plan:
  - bind the authorized stable identity and a narrow window around 14:20 UTC
  - select only the verified page-view and failure events needed for the review
  - return candidate $session_id values, first/last timestamps, and event counts
  - omit form values, URLs with queries/fragments, and unrelated event properties
  - limit the result to the few sessions nearest the reported timestamp
```

```text
{
  "rows": [
    {
      "session_id": "01J-session-redacted",
      "first_seen": "2026-07-20T14:18:42.000Z",
      "last_seen": "2026-07-20T14:22:07.000Z",
      "failure_events": 1
    }
  ],
  "row_count": 1
}
```

If a real case ID or fingerprint is available, inspect it separately:

```http
GET /v1/cases/:case_id
```

Correlate by time, session/release identifiers, and observed evidence. A nearby
case is not automatically caused by the recording. The detail response's
`player_url` is a handoff to PostHog, not replay content returned by Agentry.

At this point Agentry stops. If the human chooses to inspect the recording,
they open `player_url` in the customer's PostHog UI under its existing access,
consent, retention, and redaction controls. Agentry receives metadata, never the
replay or its snapshots. The human may provide a minimal redacted observation, such as
“the page displayed an error state after submit,” for separate correlation.

## The output

```text
Replay review preparation — <session id> — <bounded interval>

Authorization and privacy
- purpose, consent/redaction policy, reviewer

Structured PostHog evidence
- <verified event fact with timestamp>

Recording resource
- <recording id, bounded metadata, PostHog player URL>

Human PostHog checkpoint
- recording not opened | human chose to inspect in PostHog

Optional human-reported observation
- <minimal redacted visible fact, kept separate from Agentry evidence>

Separate technical evidence
- <case/network/deploy fact from its own source>

Hypothesis
- <possible explanation, explicitly labelled>

Next verification
- <reproduction, code inspection, or additional telemetry>
```

## Setting it up

Configure replay directly in the customer's PostHog project and application,
using PostHog's official SDK guidance. Load the required browser recorder only
after consent, sampling, and redaction decisions are implemented. Mask inputs by
default and exclude authentication, payment, health, secret, and other sensitive
surfaces. Agentry has metadata reads but no replay configuration, snapshot, or
video endpoint.

Use stable pseudonymous identities and session IDs across the relevant product
events. Replays do not replace structured success/failure events or runtime error
capture.

## Variations

- *"Prepare only the 90-second session window around the reported failure."*
- *"Compare visible behavior with the selected real case without claiming causality."*
- *"Explain why this recording is not safe or sufficient for a human to inspect."*
- *"Prepare a minimal reproduction checklist from verified observations."*
