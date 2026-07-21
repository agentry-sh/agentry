# Review release health after a deploy

Assemble trusted deploy, error-case, and product-event evidence into a human release
review without collapsing unlike signals into a misleading score.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Review release health after a deploy
description: >-
  Assemble trusted deploy, error-case, and product-event evidence into a human
  release review without collapsing unlike signals into a misleading score.
category: ops
tags:
  - analytics
  - errors
  - deploys
  - releases
  - oncall
  - human-review
prompt: >-
  Review the latest trusted production deploy. Show SHA-attributed and
  timing-only error cases separately, check whether real post-deploy traffic
  exists, compare only approved product signals, and prepare a release decision
  brief for human review.
difficulty: intermediate
time_to_value: 10 minutes
prereqs:
  - Successful production deploys are recorded from CI or the provider
  - >-
    The required signals are source-verified and live case/event reads cover the
    selected signals
  - The release has enough real traffic to interpret post-deploy evidence
applies_to:
  - universal
required_events:
  - $exception
  - product_value_completed
readiness_events:
  - product_value_completed
required_event_properties:
  $exception:
    - fingerprint
    - deploy_sha
  product_value_completed:
    - deploy_sha
negative_fit:
  - >-
    Do not calculate a single release-health score that hides separate error,
    traffic, and product-signal evidence.
  - >-
    Do not interpret zero errors or lower event volume without proving the
    release received comparable real traffic.
  - >-
    Do not automatically roll back, hotfix, deploy, message, or resolve cases
    from this review.
ask_if_missing:
  - >-
    Which trusted production deploy, rollout window, environment, and approved
    traffic event bound the review?
  - >-
    Which product-value event or funnel is the release expected to affect, and
    what comparison is valid for it?
  - 'Who owns the keep-watching, investigate, rollback, or hotfix decision?'
related:
  - deploy-regression
  - high-impact-errors
  - staging-watcher
execution_mode: human_review
required_resources:
  - cases
  - deploys
  - query_blueprints
  - onboarding_state
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
example_only: false
featured: false
```

</details>

## Why this matters

Post-deploy review combines unlike evidence: trusted release facts, error cases,
traffic, and product outcomes. Turning those into one opaque score can make an
unexercised release look healthy or a normal traffic dip look like a product
regression.

Keep each source visible. A trusted deploy establishes what shipped. A matching
SHA strengthens error attribution. Product-event volume shows activity, not
conversion or causality by itself.

## What you get

- The latest trusted deploy and rollout boundary
- Post-deploy cases separated by attribution quality
- Real traffic evidence for the exact release
- Selected product-signal movement with the right denominator and caveats
- A reviewed decision brief, not an automatic operational action

## Walk through it

**You:**
> Is the latest production release healthy enough to keep rolling out?

**Agent:**
> I will keep release facts, errors, traffic, and product outcomes separate and
> will stop at a human decision brief.

```http
GET /v1/projects/:project_id/deploys?limit=3
POST /v1/projects/:project_id/query-blueprints/errors_after_last_deploy/run
POST /v1/projects/:project_id/query-blueprints/errors_by_deploy/run
POST /v1/projects/:project_id/query-blueprints/analytics_events_by_deploy/run
```

Fetch each blueprint's current params and response schema first. Use
`errors_after_last_deploy` for case rows and attribution labels;
`errors_by_deploy` for aggregate error volume; and
`analytics_events_by_deploy` only as traffic context.

If a particular product outcome matters, run its approved blueprint or a
bounded custom query with an explicit numerator, denominator, exact periods,
and rollout caveats. Do not infer funnel conversion from total analytics event
volume.

## The output

```text
Release review — <sha> — <environment> — <rollout bounds>

Trusted release fact
- <deploy record and proof source>

Error evidence
- SHA-matched cases: <rows>
- timing-only cases: <rows and uncertainty>
- aggregate error volume: <value>

Traffic evidence
- approved real-traffic sample: <value/readiness>
- rollout/comparability caveat: <note>

Product evidence
- <approved metric with numerator, denominator, periods, sample>

Human decision
- keep watching | pause rollout | investigate | consider rollback/hotfix
- owner and evidence required for the choice
```

No single row grants rollback or deploy authority. If a case dominates, inspect
`GET /v1/cases/:case_id` before proposing a code change.

## Setting it up

Record deploys only from successful CI/provider post-deploy automation using
`AGENTRY_CI_API_KEY` and a stable `Idempotency-Key`. Runtime errors and analytics
go directly through the application's official PostHog SDKs. Include the release
SHA on runtime signals when the app can prove it.

Select one real product event as a traffic sample and separately define any
business outcome expected to move. Source-verify both through the saved signal
map, deploy, and live PostHog evidence. During a gradual rollout, compare like
traffic and disclose the rollout fraction.

## Variations

- *"Compare this release with the previous three trusted deploys."*
- *"Review checkout conversion with an explicit denominator and exact periods."*
- *"Show why the release is not yet decision-ready."*
- *"Prepare an oncall handoff for the top SHA-matched case."*
