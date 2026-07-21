# Find IE/Safari/old-Chrome-only crashes

Split client-side errors by browser and version. Surface fingerprints concentrated in
one engine — usually older Safari or a stale Chromium.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Find IE/Safari/old-Chrome-only crashes
description: >-
  Split client-side errors by browser and version. Surface fingerprints
  concentrated in one engine — usually older Safari or a stale Chromium.
category: debugging
tags:
  - errors
  - browser
  - client-side
  - frontend
  - sentry-alternative
prompt: >-
  Split client-side errors by browser. Are any fingerprints concentrated in one
  browser version? Older Safari is the usual suspect.
difficulty: intermediate
time_to_value: 2 minutes
prereqs:
  - >-
    Client-side errors flowing in with browser User-Agent available (browser
    fetch sends its own header automatically; optionally include
    `navigator.userAgent` as `user_agent`)
  - Enough traffic to have >100 client-side errors in the window
applies_to:
  - b2c-saas
  - b2b-saas
  - ecommerce
  - content-media
  - devtools-api
required_events:
  - $exception
required_event_properties:
  $exception:
    - fingerprint
    - $browser
    - $browser_version
    - $lib
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
    Which live properties provide $exception.fingerprint, $exception.$browser,
    $exception.$browser_version, $exception.$lib, and which stable user or
    account identifier joins the signals?
related:
  - cors-misconfig
  - customer-investigation
  - cdn-asset-404s
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
```

</details>

## Why this matters

Browser-specific bugs are the second-loudest support category after payment failures, and the hardest to reproduce on the dev laptop running the latest Chrome. The user emails "I clicked checkout and nothing happened" — you can't repro, you close the ticket, they churn.

The actual cause is almost always: Safari 14.0 doesn't support `Array.prototype.at()`, or some random old Chromium WebView used by an in-app browser is missing `Promise.allSettled`. Sentry shows you browser as a tag; segmenting by it is a manual filter you forget to apply.

Agentry's HogQL can group errors by `properties.$browser_version` in one query. The bugs concentrated in one engine pop out instantly.

## What you get

- A per-fingerprint browser distribution (what % of events came from which browser/version)
- Top 5 errors that are **>80% concentrated in one browser version** (= polyfill / compat issue)
- A "minimum browser version to support" suggestion based on your actual user mix

## Walk through it

**You:**
> Split client-side errors by browser. Are any fingerprints concentrated in one browser version?

**Agent:**
> Let me pull the browser distribution per fingerprint.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.fingerprint AS fp, properties.$browser AS browser, properties.$browser_version AS ver, count() AS cnt FROM events WHERE event = '$exception' AND properties.$lib = 'web' AND timestamp >= now() - INTERVAL 14 DAY GROUP BY fp, browser, ver HAVING cnt > 10 ORDER BY fp, cnt DESC"
```
```text
{
  "rows": [
    { "fp": "f_c4a1", "browser": "Safari", "ver": "14.0", "cnt": 88 },
    { "fp": "f_c4a1", "browser": "Safari", "ver": "14.1", "cnt": 12 },
    { "fp": "f_c4a1", "browser": "Chrome", "ver": "120",  "cnt": 2 },
    { "fp": "f_98d2", "browser": "Chrome WebView", "ver": "90", "cnt": 64 },
    { "fp": "f_98d2", "browser": "Chrome", "ver": "121", "cnt": 1 },
    { "fp": "f_4e21", "browser": "Chrome", "ver": "121", "cnt": 410 },
    { "fp": "f_4e21", "browser": "Safari", "ver": "17.4", "cnt": 188 },
    { "fp": "f_4e21", "browser": "Firefox", "ver": "124", "cnt": 91 }
  ]
}
```

**Agent:**
> Two fingerprints are heavily browser-concentrated:
>
> 1. **`f_c4a1` — 97% Safari 14.x** (100 / 102 events). Likely a missing polyfill.
> 2. **`f_98d2` — 98% Chrome WebView 90** (64 / 65 events). In-app browser inside some mobile app.
>
> `f_4e21` is well-distributed — that's a real bug affecting everyone, separate workstream.

```text
Endpoint: GET /v1/cases/:case_id
Exact shape: /v1/openapi.json?path=%2Fv1%2Fcases%2F%7Bcase_id%7D&method=get
Use query parameters, not a JSON body.
```
```text
{
  "id": "f_c4a1",
  "error_type": "TypeError",
  "message": "undefined is not a function (evaluating 'arr.at(-1)')",
  "stack_top": "dist/app.js:bundled — fn name unknown"
}
```

**Agent:**
> Confirmed: `Array.prototype.at()` isn't supported on Safari 14 (added in 15.4). The fix is either a polyfill (`core-js/features/array/at`) or swap `arr.at(-1)` for `arr[arr.length - 1]`. Affects ~100 Safari users in 14 days.
>
> `f_98d2` is harder — Chrome WebView 90 is old enough that it might be a custom browser embedded in a partner's mobile app. Recommend checking your traffic source.
>
> Should I check overall user-mix by browser so we can decide whether to drop Safari 14 support?

## The output

```
Browser-concentrated errors (14d, client-side only)

f_c4a1   TypeError: undefined is not a function (evaluating 'arr.at(-1)')
         97% Safari 14.x   (100 events / 102 total)
         3% other          (2 events)
         ↗ Polyfill `Array.prototype.at` OR replace with `arr[arr.length - 1]`

f_98d2   ReferenceError: globalThis is not defined
         98% Chrome WebView 90  (64 events / 65 total)
         2% other               (1 event)
         ↗ Old in-app browser. Check who's embedding you (referrer logs)

User-mix context (last 14d, all events):
   Chrome 120+      62%
   Safari 16+       21%
   Safari 14-15      4%   ← f_c4a1 users
   Firefox 120+      9%
   Chrome WebView    1%   ← f_98d2 users
   Other             3%

If we drop Safari < 16, we lose ~4% of traffic but kill f_c4a1
and 3 other latent compat bugs.
```

## Setting it up

Enable the official PostHog web SDK's exception capture or framework error
integration in the customer application. PostHog supplies browser and browser-
version context; confirm `$browser` and `$browser_version` exist on real
exceptions before relying on this slice.

Run `agentry onboard` to inspect the installed SDK, review privacy-safe URL and
release properties, and prove the error boundary. Agentry reads the resulting
PostHog Error Tracking evidence through OAuth; it is not the browser's error
destination.

## Variations

- *"Same query but only for users on our paid plans — do enterprise customers have a different browser mix?"*
- *"Which OS versions are concentrating errors? iPhone 14.x = old iOS, Android 9 = old Chrome WebView."*
- *"Find errors that only happen on mobile (any browser, screen width < 768)."*
- *"Are there errors only on Cypress/Playwright user agents? Probably a flaky test, not a real bug."*
