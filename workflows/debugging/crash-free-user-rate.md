# Track crash-free user rate per app version

Distinct users who hit a crash divided by DAU, per app version. The industry-standard
mobile health metric — surface version-by-version drops fast.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Track crash-free user rate per app version
description: >-
  Distinct users who hit a crash divided by DAU, per app version. The
  industry-standard mobile health metric — surface version-by-version drops
  fast.
category: debugging
tags:
  - errors
  - mobile-app
  - crash-free-rate
  - app-version
  - sentry-alternative
prompt: >-
  What's our crash-free rate by app version? Distinct users who hit any crash ÷
  DAU. Surface any version with a sudden drop.
difficulty: intermediate
time_to_value: 2 minutes
prereqs:
  - >-
    Mobile crashes flowing to the customer PostHog project with `app_version`
    and a stable user identity in
    the payload
  - >-
    Analytics events flowing for DAU computation (at minimum `app_open` or
    `session_start`)
applies_to:
  - mobile-app
required_events:
  - app_open
  - $exception
required_event_properties:
  app_open:
    - app_version
  $exception:
    - app_version
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
ask_if_missing:
  - >-
    Which observed events map to app_open, $exception? Are the required signals
    source-verified, and do live PostHog event/property reads show real traffic
    for them?
  - >-
    Which live properties provide app_open.app_version, $exception.app_version,
    and which stable user or account identifier joins the signals?
related:
  - app-version-distribution
  - deploy-regression
  - browser-version-errors
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
featured: false
```

</details>

## Why this matters

Crash-free user rate is the single number that mobile teams live and die by. Apple and Google's stated guidance is **>99.5%** — drop under 99% and you start hemorrhaging users to uninstalls *and* see your App Store ranking get downgraded by their stability scoring.

But the rate that matters is **per app version**, not aggregate. Aggregate looks fine because 80% of your users are on the stable old version. The 20% who upgraded to v4.2 yesterday are hitting a crash on first launch — and your aggregate dashboard hides it because their misery is averaged out.

Agentry computes per-version crash-free rate as a single query. Run it on demand at rollout checkpoints so a human release owner can stop a bad version before the next rollout step.

## What you get

- Crash-free user rate per app version, sorted by version (newest first)
- DAU per version (so you can ignore versions with no traffic)
- A clear delta — which versions are below your target (typically 99.5%)

## Walk through it

**You:**
> What's our crash-free rate by app version? Distinct users who hit any crash ÷ DAU. Flag any version that's below 99% over the last 24h.

**Agent:**
> One HogQL pass: distinct users who had a crash, distinct users who used the app, grouped by version.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "
    with active as (
      select properties.app_version as ver,
        count(distinct distinct_id) as dau
      from events
      where event = 'app_open'
        and timestamp > now() - interval 24 hour
      group by ver
    ),
    crashed as (
      select properties.app_version as ver,
        count(distinct distinct_id) as crashed_users
      from events
      where event = '$exception'
        and timestamp > now() - interval 24 hour
      group by ver
    )
    select
      a.ver,
      a.dau,
      coalesce(c.crashed_users, 0) as crashed,
      1 - (coalesce(c.crashed_users, 0) / a.dau) as crash_free_rate
    from active a
    left join crashed c on c.ver = a.ver
    where a.dau > 50
    order by ver desc
  "
```
```text
{
  "rows": [
    { "ver": "4.2.0", "dau":  18420, "crashed": 442, "crash_free_rate": 0.9760 },
    { "ver": "4.1.3", "dau":  62100, "crashed":  92, "crash_free_rate": 0.9985 },
    { "ver": "4.1.2", "dau":  41880, "crashed":  61, "crash_free_rate": 0.9985 },
    { "ver": "4.1.1", "dau":  12340, "crashed":  18, "crash_free_rate": 0.9985 },
    { "ver": "4.0.5", "dau":   3420, "crashed":   5, "crash_free_rate": 0.9985 }
  ]
}
```

**Agent:**
> Found it. **v4.2.0 is at 97.6% crash-free** — that's a regression from your normal 99.85%. 442 users crashed in 24h out of 18,420 active. Let me look at what's crashing.

```text
Endpoint: GET /v1/projects/:project_id/cases
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fcases&method=get
Use query parameters, not a JSON body.
Query/filter concept:
  matching: "",
  filter: { property: "app_version", value: "4.2.0" },
  window_hours: 24
```
```text
{
  "cases": [
    {
      "case_id": "c_mob_1",
      "fingerprint": "f_42_a",
      "error_type": "NullPointerException",
      "message": "Attempt to invoke virtual method 'getString' on null PushTokenManager",
      "events_count": 380,
      "users_affected": 380,
      "introduced_in_deploy": "4.2.0"
    },
    {
      "case_id": "c_mob_2",
      "fingerprint": "f_42_b",
      "error_type": "OutOfMemoryError",
      "message": "Failed to allocate 64MB during ImageDecoder init",
      "events_count":  62,
      "users_affected":  62,
      "introduced_in_deploy": "4.2.0"
    }
  ]
}
```

**Agent:**
> Two issues, both introduced in 4.2.0:
>
> 1. **NullPointerException in `PushTokenManager`** (380 users — accounts for 86% of the crash budget). Looks like push registration runs before `Application.onCreate` finishes. Easy fix.
> 2. **OutOfMemoryError in `ImageDecoder`** (62 users). 64MB allocation — bigger images or you forgot a downsample. Affects low-RAM Androids.
>
> Recommendation: **roll back v4.2.0 from the rollout** (right now you're at 18k DAU on it; if the rollout proceeds you'll have 200k+ users crashing). Push 4.2.1 with these two fixes.
>
> I can re-run this at the next rollout checkpoint and draft an oncall summary if any new version drops below 99%; a human chooses whether to page or halt the rollout.

## The output

```
Crash-free user rate by app version (24h)

Version    DAU       Crashes   Crash-Free   Target (99.5%)
─────────────────────────────────────────────────────────────
4.2.0     18,420       442       97.60%      FAIL ★★★
4.1.3     62,100        92       99.85%      PASS
4.1.2     41,880        61       99.85%      PASS
4.1.1     12,340        18       99.85%      PASS
4.0.5      3,420         5       99.85%      PASS

★ v4.2.0 regression: -2.25 pp vs baseline

Crash budget for v4.2.0 (24h):
  Total crashes:           442
  Top contributor (86%):   NullPointerException in PushTokenManager
  Second (14%):            OutOfMemoryError in ImageDecoder

Recommended actions (urgent):
  1. HALT v4.2.0 rollout in App Store / Play Console
  2. Patch the two fingerprints
  3. Ship 4.2.1 once verified in staging
```

## Setting it up

Enable the installed official PostHog mobile SDK's crash/exception integration
and attach `app_version`, `platform`, `os_version`, environment, and the same
stable user identity used by an `app_open` or `session_start` event. Do not
replace the platform crash handler with a hand-written network request that may
lose the crash during termination.

Run `agentry onboard` to review the exact Android/iOS integration and confirm
both crash and activity evidence in the customer-owned PostHog project before
computing a crash-free rate.

## Variations

- *"Same metric but per OS version — is the crash hitting only Android 14, or all versions?"*
- *"Crash-free SESSIONS instead of users — closer to Google Play's metric definition."*
- *"At the next rollout checkpoint, recompute this and draft a #mobile-oncall summary for any active version below 99%."*
- *"Compare crash-free rates for users who came from organic vs paid installs — sometimes ad networks send bot traffic that crashes immediately."*
