# Compare error rates between staging and prod

Diff fingerprints between staging and production. Find what's already breaking in
staging that the next deploy will carry into prod.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Compare error rates between staging and prod
description: >-
  Diff fingerprints between staging and production. Find what's already breaking
  in staging that the next deploy will carry into prod.
category: debugging
tags:
  - errors
  - environments
  - pre-deploy
  - staging
  - oncall
  - sentry-alternative
prompt: >-
  Compare error rates in staging vs production over the last 24 hours. Are there
  fingerprints staging is hitting that prod hasn't seen yet?
difficulty: beginner
time_to_value: 1 minute
prereqs:
  - >-
    PostHog exceptions carry an `environment` property (`staging` vs
    `production`)
  - 'Staging actually receives traffic (synthetic load, internal users, or QA)'
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
  - staging-watcher
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
```

</details>

## Why this matters

Staging exists to catch bugs before they hit prod. In practice, nobody looks at staging error rates — staging is "where my own stuff runs," not "the canary."

Sentry treats staging and prod as separate projects, which means side-by-side comparison is a Sunday-night SQL session. Datadog can chart both, but the question "which fingerprints exist in staging that don't exist in prod yet?" needs a join nobody writes.

When both environments intentionally share the connected PostHog project, the
`environment` property lets one bounded analysis compare their issue evidence.
If they are separate PostHog projects, analyze each connection separately.

## What you get

- A list of fingerprints present in **staging only** (= queued for prod)
- A list of fingerprints **10x worse in staging than prod** (= getting worse on the new branch)
- For each, a one-line interpretation + which deploy introduced it

## Walk through it

**You:**
> Compare error rates in staging vs production over the last 24 hours. Are there fingerprints staging is hitting that prod hasn't seen yet?

**Agent:**
> Let me pull open cases per environment and diff the fingerprint sets.

```text
Endpoint: GET /v1/projects/:project_id/cases
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fcases&method=get
Use query parameters, not a JSON body.
Query/filter concept:
  status: "open",
  since: "24h",
  group_by: "environment"
```
```text
{
  "by_environment": {
    "production": [
      { "fingerprint": "f_72ac", "event_count": 412, "users_affected": 88 },
      { "fingerprint": "f_91dd", "event_count": 89,  "users_affected": 14 }
    ],
    "staging": [
      { "fingerprint": "f_72ac", "event_count": 18,  "users_affected": 3 },
      { "fingerprint": "f_91dd", "event_count": 4,   "users_affected": 2 },
      { "fingerprint": "f_b32e", "event_count": 71,  "users_affected": 6 },
      { "fingerprint": "f_5c10", "event_count": 22,  "users_affected": 4 }
    ]
  }
}
```

**Agent:**
> Two fingerprints exist in staging that prod has never seen: `f_b32e` and `f_5c10`. Both showed up in the last 24h. Let me pull the details.

```text
Endpoint: GET /v1/cases/:case_id
Exact shape: /v1/openapi.json?path=%2Fv1%2Fcases%2F%7Bcase_id%7D&method=get
Use query parameters, not a JSON body.
```
```text
{
  "id": "f_b32e",
  "error_type": "TypeError",
  "message": "Cannot read properties of null (reading 'workspaceId')",
  "stack_top": "src/api/billing/seats.ts:74",
  "environment": "staging",
  "first_seen_at": 1747280000,
  "deploy_sha_at_first_seen": "9c3a210"
}
```

**Agent:**
> `f_b32e` is a null-deref in `billing/seats.ts:74` reading `workspace.workspaceId`. First fired 14h ago, right after staging deploy `9c3a210`. That deploy isn't in prod yet — but it's queued. If you ship today's PR, this regression goes live.
>
> `f_5c10` is a 500 from `/api/integrations/slack`. Looks like a missing env var on staging only — less urgent but worth checking the deploy doc.
>
> Want me to draft a PR-comment summary so the merger sees this before they push?

## The output

```
Environment diff (staging vs production, last 24h)

In STAGING only (= riding the next deploy to prod):

   71 events / 6 users    TypeError: Cannot read properties of null
                          src/api/billing/seats.ts:74 (workspace.workspaceId)
                          ↗ introduced by staging deploy 9c3a210 — 14h ago

   22 events / 4 users    500 /api/integrations/slack
                          Missing SLACK_SIGNING_SECRET in staging env
                          ↗ probably env-only; unlikely to repro in prod

Worse in STAGING than PROD (10x+):
   (none this window)

In PROD only (= broken right now, fix separately):

  412 events / 88 users   TypeError: Cannot read properties of undefined ('id')
                          src/middleware/auth.ts:42
                          ↗ existing case, see f_72ac
```

## Setting it up

This requires comparable exceptions in the connected customer PostHog project
with an explicit normalized `environment` and `release`. Configure those
properties through each environment's existing official PostHog SDK setup; do
not give either runtime an Agentry credential.

Whether staging and production share one PostHog project is a customer taxonomy
decision. If they are separate projects, connect and analyze them separately
rather than pretending a single OAuth project query can span both. Run
`agentry onboard` to prove the actual boundary.

## Variations

- *"Same diff but for the last 7 days — anything chronic in staging that we keep forgetting to fix before promoting?"*
- *"Compare staging vs prod error rates by endpoint — which routes are flakier in staging?"*
- *"Show fingerprints that appear in staging, then 1-2 deploys later appear in prod. What's our staging-as-canary precision?"*
- *"On demand, summarize staging-only fingerprints for an engineer to review and optionally share with #eng-staging."*
