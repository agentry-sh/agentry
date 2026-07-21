# Review genuinely new staging errors

Compare a bounded staging case window with prior fingerprints, inspect only genuinely
new failure modes, and prepare a human-reviewed oncall handoff.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Review genuinely new staging errors
description: >-
  Compare a bounded staging case window with prior fingerprints, inspect only
  genuinely new failure modes, and prepare a human-reviewed oncall handoff.
category: ops
tags:
  - errors
  - staging
  - post-deploy
  - oncall
  - human-review
  - datadog-alternative
prompt: >-
  Review staging errors first seen in the last hour and compare them with the
  prior day. For each genuinely new fingerprint, summarize impact, suspect
  deploy, and next investigation. Do not message oncall or mutate cases.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - Errors flow with environment and stable fingerprint context
  - 'An owner or member opens an authenticated, interactive review session'
applies_to:
  - universal
required_events:
  - $exception
required_event_properties:
  $exception:
    - environment
    - fingerprint
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
    Which observed events map to $exception? Are the required signals
    source-verified, and do live PostHog event/property reads show real traffic for
    them?
  - >-
    Which live properties provide $exception.environment,
    $exception.fingerprint, and which stable user or account identifier joins
    the signals?
related:
  - deploy-regression
  - silent-bugs
  - suppress-noise
execution_mode: human_review
required_resources:
  - cases
  - deploys
publishedAt: 2026-05-16T00:00:00.000Z
updatedAt: 2026-07-10T00:00:00.000Z
```

</details>

## Why this matters

Volume thresholds create noise in staging. The higher-value question is
whether a fingerprint is genuinely new, reappeared after resolution, or began
immediately after a deploy. That determination needs bounded case and deploy
evidence, not an unrestricted agent with a webhook.

## Run the review

Fetch the filtered OpenAPI schema for the cases and deploy reads, then use only
their documented query parameters:

```text
GET /v1/projects/:project_id/cases
GET /v1/cases/:case_id
GET /v1/projects/:project_id/deploys
```

Within the interactive session:

1. Select staging cases first seen in the review window.
2. Compare each fingerprint with the prior-day case window.
3. Fetch details only for genuinely new or reappearing fingerprints.
4. Correlate `last_deploy_sha` and recent deploy evidence.
5. Separate proven facts from a suspected code cause.

Raw case details may contain user and request data. Minimize what enters the
summary and do not copy secrets, tokens, or unnecessary identifiers.

## Output format

```text
New staging fingerprints — <UTC window>

<fingerprint>
- first seen / last seen / event count / affected users
- suspect deploy and evidence strength
- top in-app frame and likely owner
- recommended next investigation
- missing evidence
```

Return the handoff to the reviewer. A human decides whether to notify oncall,
suppress noise, change case state, or start a code-fix workflow.

## Instrumentation

Use the staging application's existing official PostHog SDK exception
integration with explicit `environment: "staging"` and the deployed `release`.
The telemetry goes directly to the customer's PostHog project; the runtime gets
no Agentry credential. Run `agentry onboard` to prove the owning failure
boundary and whether staging is in the connected project.

## Unattended boundary

There is no versioned staging-notification template. A runner cannot receive an
owner key, raw case browsing, generic queries, or messaging authority. If a
reviewed case should enter the supported code-fix path, use the exact
`error-to-draft-pr@2.0.0` template and its policy gates; it may create a draft
PR but still cannot message, merge, deploy, or declare production verification
without the required trusted evidence.

## Variations

- *"Review only fingerprints reappearing after a resolved state."*
- *"Compare the hour after a selected deploy with the hour before it."*
- *"Limit the review to fingerprints affecting at least five distinct users."*
- *"Draft an oncall handoff for a human to review; do not send it."*
