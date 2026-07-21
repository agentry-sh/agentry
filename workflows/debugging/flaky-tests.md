# Diagnose a flaky CI test from its error payloads

Group test failures across CI runs by error pattern. Get a verdict — real bug or timing
— without the manual archaeology.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Diagnose a flaky CI test from its error payloads
description: >-
  Group test failures across CI runs by error pattern. Get a verdict — real bug
  or timing — without the manual archaeology.
category: debugging
tags:
  - errors
  - ci
  - testing
  - oncall
  - flaky-tests
  - saas
prompt: >-
  The test `checkout flow > submits valid card` failed 4 times in CI this week.
  Pull the error payloads, find what's common across runs, and tell me if it's a
  real bug or just timing.
difficulty: intermediate
time_to_value: 1 minute
prereqs:
  - Structured CI failure evidence is available; optional PostHog test-failure
    events are explicitly source-reviewed (see Setting it up)
applies_to:
  - universal
required_events:
  - ci_test_failed
required_event_properties:
  ci_test_failed:
    - test_name
    - workflow
    - run_id
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
ask_if_missing:
  - >-
    Which observed events map to ci_test_failed? Are the required signals
    source-verified, and do live PostHog event/property reads show real traffic for
    them?
  - >-
    Which live properties provide ci_test_failed.test_name,
    ci_test_failed.workflow, ci_test_failed.run_id, and which stable user or
    account identifier joins the signals?
related:
  - silent-bugs
  - deploy-regression
  - suppress-noise
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
```

</details>

## Why this matters

Flaky tests are the worst kind of bug because they masquerade as not-bugs. You re-run, it passes, you merge, you forget. Two weeks later it's failing on production for a real reason and you can't tell because everyone learned to ignore that test.

The fix is to treat each CI failure as a data point and **look for patterns across runs**. If 4 failures all happen in the same `useEffect` ordering issue, it's a race condition. If they happen at random points across the test body, it's flake (network, timing, GC pauses). You can usually tell within a minute — *if* you have the failure data structured.

Most CI runners throw failure logs in a tar.gz no one reads. Agentry pulls them into a searchable event store so the agent can group them.

## What you get

- All recent failures of one test (or test pattern) grouped together
- A verdict: real bug (with root cause) vs flake (with suggested mitigation)
- An option to mark known-flaky tests so they don't page on each future failure

## Walk through it

**You:**
> The Cypress test `checkout flow > submits valid card` failed 4 times this week in CI. Pull the failure payloads, find what's common, and tell me if it's a real race or just timing.

**Agent:**
> Let me find those failures.

```text
Endpoint: GET /v1/projects/:project_id/cases
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fcases&method=get
Use query parameters, not a JSON body.
Query/filter concept:
  environment: "ci",
  query: "checkout flow > submits valid card",
  status: "open",
  since: "7d"
```
```text
{
  "cases": [
    { "id": "c_ci0", "fingerprint": "f_ci0",
      "message": "AssertionError: expected #checkout-success to be visible",
      "event_count": 4,
      "last_seen_at": 1747320000,
      "first_seen_at": 1746748800 }
  ]
}
```

**Agent:**
> Same fingerprint all 4 times — that's a clean signal, all failures hit the same assertion. Let me pull the individual events to compare timing.

```text
Endpoint: GET /v1/cases/:case_id
Exact shape: /v1/openapi.json?path=%2Fv1%2Fcases%2F%7Bcase_id%7D&method=get
Use query parameters, not a JSON body.
Query/filter concept:
  include_recent_events: 4
```
```text
{
  "events": [
    { "received_at": 1746748800,
      "stack": "AssertionError at cy.get(#checkout-success) timeout 4000ms",
      "extra": { "ci_run_id": "abc1", "duration_ms": 4012, "retry": 0 } },
    { "received_at": 1747001200,
      "stack": "AssertionError at cy.get(#checkout-success) timeout 4000ms",
      "extra": { "ci_run_id": "abc2", "duration_ms": 4008, "retry": 0 } },
    { "received_at": 1747186400,
      "stack": "AssertionError at cy.get(#checkout-success) timeout 4000ms",
      "extra": { "ci_run_id": "abc3", "duration_ms": 4015, "retry": 0 } },
    { "received_at": 1747320000,
      "stack": "AssertionError at cy.get(#checkout-success) timeout 4000ms",
      "extra": { "ci_run_id": "abc4", "duration_ms": 4011, "retry": 0 } }
  ]
}
```

**Agent:**
> Verdict: **likely timing, not a bug**.
>
> Evidence:
> - All 4 failures hit the same assertion (`#checkout-success` not visible)
> - All 4 hit the 4000ms timeout exactly (4008–4015ms — that's the test's `defaultCommandTimeout`)
> - Stripe's test-mode latency is typically 200-3000ms but spikes occasionally to 5-8s
>
> The success page renders *after* Stripe returns. Your timeout is just a bit too tight for the long tail of Stripe responses.
>
> **Two fixes, depending on intent:**
>
> 1. **Increase timeout** (5 min effort, no risk):
>    `cy.get('#checkout-success', { timeout: 10000 }).should('be.visible')`
> 2. **Stub Stripe in CI** (1h effort, removes flake entirely + makes test 5x faster):
>    Use `cy.intercept('POST', '**/charges', { fixture: 'stripe-success.json' })`
>
> Want me to draft the PR for option 1?

## The output

```
🧪 Flaky test analysis: "checkout flow > submits valid card"

4 failures in 7 days · Same fingerprint each time · Same assertion

VERDICT: Timing (Stripe latency spike), not a code bug
  Evidence: all failures hit defaultCommandTimeout (4000ms) exactly
            Stripe test-mode p99 latency ≈ 6s

FIXES:
  Quick:  cy.get('#checkout-success', { timeout: 10000 })…
  Right:  cy.intercept('POST', '**/charges', { fixture: ... })

NEXT: ask your agent to open a PR ("increase checkout test timeout")
   OR ask your agent to open a PR ("stub Stripe in cypress checkout tests")
   OR, after human review, suppress the exact issue in PostHog and refresh the case
```

## Setting it up

Prefer the test runner's structured JSON/JUnit artifact and repository/CI API
for flake analysis. If the customer intentionally keeps CI failures in PostHog,
capture them through an existing official server SDK with `environment: "ci"`,
`ci_run_id`, and a normalized `test_file`; never include source secrets or full
test fixtures.

That optional telemetry goes directly to the customer PostHog project. The
Agentry CI credential remains limited to trusted deploy and provider-observed
PR proof. Run `agentry onboard` before adding this signal because many projects
should keep CI failures out of production product analytics entirely.

## Variations

- *"Across all my CI failures this week, which test is the most flaky? Rank by failure count."*
- *"Compare CI failures on `main` vs `feature/*` branches — is something broken on main that we're masking with re-runs?"*
- *"Mark `checkout flow > submits valid card` as known-flaky for the next 7 days. If it's still failing then, escalate."*
- *"Find tests that are slow but not flaky — taking 30s+ on average."*
