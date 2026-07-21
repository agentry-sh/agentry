# Find what broke after the last npm update

Tie new error fingerprints to the deploy that bumped dependencies. Spot the silent
regression nobody intended to ship.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Find what broke after the last npm update
description: >-
  Tie new error fingerprints to the deploy that bumped dependencies. Spot the
  silent regression nobody intended to ship.
category: debugging
tags:
  - errors
  - regression
  - dependencies
  - deploys
  - post-deploy
  - oncall
prompt: >-
  Did our last deploy bump dependencies? If yes, what new error patterns
  appeared after it?
difficulty: beginner
time_to_value: 30 seconds
prereqs:
  - >-
    Deploys posted to /v1/deploys/ with AGENTRY_CI_API_KEY, a stable
    Idempotency-Key, commit message, and diff metadata
  - Errors flowing in with `release` tagged to the deploy SHA
applies_to:
  - universal
required_events:
  - $exception
required_event_properties:
  $exception:
    - fingerprint
    - release
    - dependency_name
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
    Which live properties provide $exception.fingerprint, $exception.release,
    $exception.dependency_name, and which stable user or account identifier
    joins the signals?
related:
  - deploy-regression
  - cors-misconfig
  - cdn-asset-404s
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
```

</details>

## Why this matters

Dependency bumps are the silent regression source. Each one is small — Renovate opens a PR, CI passes, someone clicks merge. Multiply by 30 deps a quarter and the combinatorics will eventually catch you: `@stripe/stripe-node` changes a default, your code didn't notice, customers stop being able to check out.

Sentry doesn't know your deploys had a `package-lock.json` change. Renovate doesn't know you're now throwing TypeErrors in prod. Neither half sees what the other half did.

Agentry's deploy events carry the commit message, and the agent reads them. One prompt: "was the last deploy a deps bump, and did anything break?" The answer takes 30 seconds.

## What you get

- The most recent deploy classified as `deps_bump | feature | fix | chore`
- New error fingerprints that started after that deploy
- For each: which dep is most likely the culprit (cross-referenced with the deploy diff)

## Walk through it

**You:**
> Did our last deploy bump dependencies? If yes, what new error patterns appeared after it?

**Agent:**
> Let me pull the latest deploys and check what they touched.

```text
Endpoint: GET /v1/projects/:project_id/deploys
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fdeploys&method=get
Use query parameters, not a JSON body.
Query/filter concept:
  limit: 3
```
```text
{
  "deploys": [
    { "sha": "9c3a210", "branch": "main", "received_at": 1747353600,
      "message": "chore(deps): bump @stripe/stripe-node 14.5.0 -> 15.0.1, drizzle-orm 0.30 -> 0.31",
      "environment": "production" },
    { "sha": "a3f29b1", "branch": "main", "received_at": 1747270000,
      "message": "feat: workspace seat management", "environment": "production" }
  ]
}
```

**Agent:**
> Latest deploy (`9c3a210`, ~3h ago) is a deps bump — Stripe SDK 14→15 (major) and drizzle-orm 0.30→0.31 (minor). Let me check what fingerprints started firing after it.

```text
Endpoint: GET /v1/projects/:project_id/cases
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fcases&method=get
Use query parameters, not a JSON body.
Query/filter concept:
  status: "open",
  first_seen_after: 1747353600,
  limit: 10
```
```text
{
  "cases": [
    { "id": "c_88a1", "error_type": "TypeError",
      "message": "Cannot read properties of undefined (reading 'data')",
      "stack_top": "src/billing/stripe.ts:127",
      "first_seen_at": 1747353900, "event_count": 64, "users_affected": 11 },
    { "id": "c_3f02", "error_type": "DrizzleQueryError",
      "message": "syntax error at or near \"RETURNING\"",
      "stack_top": "src/db/queries.ts:48",
      "first_seen_at": 1747355100, "event_count": 19, "users_affected": 6 }
  ]
}
```

**Agent:**
> Both new fingerprints map cleanly to the deps bump:
>
> 1. **`c_88a1`** fires in `src/billing/stripe.ts`. Stripe SDK v15 removed the auto-unwrapping of `lastResponse` — code reading `result.data` now gets `undefined`. 64 events / 11 users since deploy.
> 2. **`c_3f02`** fires in your Drizzle query layer. drizzle-orm 0.31 changed `RETURNING` clause behavior for SQLite/libSQL. 19 events / 6 users.
>
> Fix priority is #1 — that's the checkout path. Want me to draft the rollback PR + Stripe SDK migration guide summary?

## The output

```
Deploy: 9c3a210 — "chore(deps): bump @stripe/stripe-node 14.5 -> 15.0,
                   drizzle-orm 0.30 -> 0.31"
                   (3h ago, production)

NEW since this deploy:

   64 events / 11 users · TypeError: Cannot read properties of undefined ('data')
                          src/billing/stripe.ts:127
                          ↗ Likely cause: stripe-node 15.0 removed auto-unwrap
                          ↗ Fix: replace `result.data` with `result` (or `result.body`)

   19 events / 6 users   · DrizzleQueryError: syntax error at "RETURNING"
                          src/db/queries.ts:48
                          ↗ Likely cause: drizzle-orm 0.31 RETURNING behavior change
                          ↗ Fix: pin to 0.30 OR migrate queries per 0.31 changelog

Recommended: revert deploy 9c3a210, ship pinned-version fix in next deploy.
             Or, leave Stripe SDK upgrade and revert just drizzle.
```

## Setting it up

The agent needs two signals:

1. **Deploy events with the real commit message** — so it can spot "chore(deps): bump" patterns.
2. **Errors tagged with `release: <sha>`** — so it can window cases by deploy.

Most teams already have these from `deploy-regression`. If not:

```yaml
# .github/workflows/deploy.yml — after a successful production deploy
- name: Notify Agentry
  if: success()
  run: |
    curl -X POST https://api.agentry.sh/v1/deploys/ \
      -H "Authorization: Bearer $AGENTRY_CI_API_KEY" \
      -H "Idempotency-Key: deploy-production-$GITHUB_SHA" \
      -H "Content-Type: application/json" \
      -H "User-Agent: myapp-ci/1.0" \
      -d "{
        \"sha\": \"$GITHUB_SHA\",
        \"branch\": \"$GITHUB_REF_NAME\",
        \"environment\": \"production\",
        \"message\": \"$(git log -1 --pretty=%s)\",
        \"actor\": \"$GITHUB_ACTOR\"
      }"
```

On the error side, configure the existing official PostHog SDK to attach the
same deployed commit SHA as `release` plus the normalized environment. Client
source maps are processed and uploaded directly with the official PostHog CLI;
the Agentry CI credential above is only for deploy attribution.

Run `agentry onboard` to verify that the exception release identity and trusted
Agentry deploy identity actually join.

If you use Renovate / Dependabot, their commit messages already follow the `chore(deps): bump X N.M -> N'.M'` convention, so the agent's classifier picks them up automatically.

## Variations

- *"Show me every Renovate merge in the last month and any errors that appeared within 24h of each."*
- *"Did `@stripe/stripe-node` upgrades historically cause regressions? Pattern check."*
- *"Which deps have been bumped 3+ times this quarter without an obvious reason? Probably auto-merged."*
- *"After a dependency-bump deploy, review the next hour on demand for new fingerprints and draft a #eng-deps summary."*
