# Find the bugs 5 people hit but no one reported

Surface real errors that affect multiple users but never get filed as tickets. The
biggest source of silent churn.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Find the bugs 5 people hit but no one reported
description: >-
  Surface real errors that affect multiple users but never get filed as tickets.
  The biggest source of silent churn.
category: debugging
tags:
  - errors
  - oncall
  - retention
  - saas
  - sentry-alternative
  - growth-loop
prompt: >-
  Show me errors that affected 3+ users in the last week but I've never looked
  at. Sort by users-affected.
difficulty: beginner
time_to_value: 10 seconds
prereqs:
  - Application exceptions visible in the connected PostHog project
applies_to:
  - universal
required_events:
  - $exception
required_event_properties:
  $exception:
    - fingerprint
    - users_affected
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
    Which live properties provide $exception.fingerprint,
    $exception.users_affected, and which stable user or account identifier joins
    the signals?
related:
  - deploy-regression
  - customer-investigation
  - suppress-noise
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
```

</details>

## Why this matters

For every customer who reports a bug, **8 silently leave**. That's the most well-replicated number in SaaS support research.

Your error tracker probably has dozens of unique fingerprints hitting multiple users — sorted by frequency, you see the loud ones (5,000 events from one cron loop, mostly noise). Sorted by users-affected, you see the silent killers: 14 different paying customers hit the same checkout error and not one of them filed a ticket.

Fixing the top 5 silent bugs every Friday afternoon is the highest-ROI hour of engineering you can spend. Agentry surfaces them with one prompt.

## What you get

- A ranked list of open cases by **distinct users affected**
- Filtered to cases you've never looked at (no `agent_summary` yet)
- For each: the message, file/line, when it started, last seen

## Walk through it

**You:**
> Show me errors that affected 3+ users in the last 7 days, that I haven't triaged yet.

**Agent:**
> Let me pull open cases ranked by distinct users.

```text
Endpoint: GET /v1/projects/:project_id/cases
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fcases&method=get
Use query parameters, not a JSON body.
Query/filter concept:
  status: "open",
  min_users_affected: 3,
  triaged: false,
  since: "7d"
```
```text
{
  "cases": [
    { "id": "c_f72a", "fingerprint": "f_72a", "error_type": "TypeError",
      "message": "Cannot read properties of undefined (reading 'plan')",
      "users_affected": 14, "event_count": 89, "first_seen_at": 1746748800,
      "last_seen_at": 1747353200, "agent_summary": null },
    { "id": "c_1cd9", "fingerprint": "f_1cd9", "error_type": "NetworkError",
      "message": "fetch failed: invoice.pdf download",
      "users_affected": 9, "event_count": 11, "first_seen_at": 1746834200,
      "last_seen_at": 1747291000, "agent_summary": null },
    { "id": "c_a3e1", "fingerprint": "f_a3e1", "error_type": "ValidationError",
      "message": "phone_number format invalid (NANP expected)",
      "users_affected": 7, "event_count": 14, "first_seen_at": 1746920000,
      "last_seen_at": 1747350800, "agent_summary": null }
  ]
}
```

**Agent:**
> Three silent bugs worth your attention this week:
>
> 1. **14 users · TypeError on `.plan`** — checkout / settings code reads `user.plan` without a null check. Most likely cause: free-tier users who never set a plan. Started a week ago, fires daily.
> 2. **9 users · invoice PDF download fails** — `fetch failed`. Maybe a CORS issue on the new invoice service? 11 events across 9 users suggests they each tried once and gave up.
> 3. **7 users · phone number rejected (NANP-only)** — your validation only accepts US/Canada format. 7 international customers hit this and didn't tell you.
>
> #1 is the highest-leverage fix. Want me to draft the PR?

## The output

```
🐛 3 silent bugs (3+ users, last 7d, untriaged)

  14 users · TypeError: Cannot read properties of undefined (reading 'plan')
            UserMenu.tsx — null-check missing on free-tier path
            ↗ likely fix: 4-line guard

   9 users · NetworkError: fetch failed: invoice.pdf download
            BillingPage.tsx — CORS on new invoice service?
            ↗ verify CORS headers in invoice-service deploy

   7 users · ValidationError: phone_number format invalid (NANP expected)
            SignupForm.tsx — international users blocked
            ↗ switch validator to libphonenumber or relax the check

Cumulative customers silently impacted: 30
```

## Setting it up

This workflow works the moment errors start flowing — no extra instrumentation
is needed when the existing PostHog Error Tracking setup already covers the
source-proven boundaries.

To make affected-user counts useful, identify the user consistently through the
official PostHog SDK before exception capture and include normalized environment
and release context. Prefer an internal stable id to an email address. Run
`agentry onboard` to review privacy and confirm how PostHog computes impact for
the connected project; do not assume an IP-based fallback.

## Variations

- *"Same query but for production only — staging errors don't count."*
- *"Show me silent bugs that have been around for 30+ days. We've collectively decided to ignore these — should we?"*
- *"For each silent bug, tell me roughly how much revenue is impacted (cross-reference users-affected with their plan)."*
- *"After I ship a fix for case `c_f72a`, watch for it to drop to zero and post a confirmation in #eng."*
