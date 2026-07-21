# Review stale or dangerous suppressed error issues

Find suppressed PostHog-backed cases whose current impact or deploy context makes them
worth reactivating.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Review stale or dangerous suppressed error issues
description: >-
  Find suppressed PostHog-backed cases whose current impact or deploy context
  makes them worth reactivating.
category: ops
tags:
  - errors
  - suppression
  - posthog
  - oncall
  - governance
  - ops
  - sentry-alternative
prompt: >-
  Review suppressed cases and tell me which ones now affect real users, recurred
  around a recent deploy, or lack a defensible suppression reason.
difficulty: beginner
time_to_value: 2 minutes
prereqs:
  - The project has PostHog-backed cases with status suppressed
applies_to:
  - universal
required_events:
  - $exception
required_event_properties:
  $exception:
    - release
negative_fit:
  - Do not reactivate or resolve a case without human approval.
ask_if_missing:
  - Is the exception signal source-verified, and which suppressed cases are in scope?
  - What impact, deploy, or review condition should make a suppressed issue active again?
related:
  - suppress-noise
  - silent-bugs
  - high-impact-errors
updatedAt: 2026-07-15T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

Find suppressed PostHog issues whose recent impact or deploy context makes them
worth reactivating.

## Why this matters

An issue that was harmless last month can become a real regression after a
deploy. Reviewing provider-owned lifecycle state avoids inventing a second,
drifting suppression-rule system inside Agentry.

## What you get

- Suppressed issues ranked by current user impact and recurrence
- Deploy evidence for and against reactivation
- Missing or stale suppression rationale
- A reviewable recommendation for an owner to apply in PostHog

## Walk through it

```http
GET /v1/projects/:project_id/cases?status=suppressed
GET /v1/cases/:case_id
GET /v1/cases/:case_id/users
GET /v1/projects/:project_id/deploys
```

Rank cases by affected-user impact, recurrence/last-seen movement, deploy
relationship, missing or stale `agent_summary`, and whether the original review
condition has been met. Treat PostHog occurrence/user counts as provider facts;
do not infer causality from time proximity alone.

If the owner agrees, reactivating the exact issue is an external action in
PostHog. Then re-read the case to refresh Agentry's provider-backed projection:

```text
External action (owner): set this exact issue to active in PostHog.
```

```http
GET /v1/cases/:case_id
```

## The output

Return suppressed issues sorted by review priority, with the evidence for and
against reactivation. Agentry does not mutate the PostHog lifecycle; report the
new status only after the refreshed provider read confirms it.

## Setting it up

Source-verify the exception signal and deploy identity so they are joinable.
This review needs no extra suppression rules: it reads PostHog's issue state
through Agentry. A separate annotation-only case PATCH may record reviewed
agent-facing context, but cannot change provider status.

## Variations

- *"Show suppressed issues that recurred after the last deploy."*
- *"Find suppressed issues with no recorded rationale."*
- *"Turn this into a weekly on-call hygiene review."*
