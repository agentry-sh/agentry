# Diagnose CORS errors after a deploy

Find CORS-blocked requests grouped by origin and endpoint. Surface the misconfigured
Access-Control-Allow-Origin from a recent service move.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Diagnose CORS errors after a deploy
description: >-
  Find CORS-blocked requests grouped by origin and endpoint. Surface the
  misconfigured Access-Control-Allow-Origin from a recent service move.
category: debugging
tags:
  - errors
  - cors
  - deploys
  - post-deploy
  - infra
  - frontend
prompt: >-
  Are we getting any CORS errors in production? If yes, group by origin + which
  endpoint is rejecting them.
difficulty: intermediate
time_to_value: 1 minute
prereqs:
  - Client-side fetch errors captured in the connected PostHog project
  - 'Multi-origin setup (your app at one subdomain, your API at another)'
applies_to:
  - b2c-saas
  - b2b-saas
  - ecommerce
  - content-media
  - devtools-api
  - marketplace
required_events:
  - $exception
required_event_properties:
  $exception:
    - cors_blocked
    - origin
    - endpoint
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
    Which live properties provide $exception.cors_blocked, $exception.origin,
    $exception.endpoint, and which stable user or account identifier joins the
    signals?
related:
  - deploy-regression
  - cdn-asset-404s
  - browser-version-errors
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
```

</details>

## Why this matters

CORS regressions are uniquely sneaky. The browser doesn't throw a normal error — it shows a console message ("blocked by CORS policy") and the fetch returns `TypeError: Failed to fetch` with no useful detail. Your server logs show nothing because the request was rejected before it got there.

You usually find out from a developer poking devtools, or from a support email saying "the dashboard won't load." By then half a day of paying customers have hit it.

The common cause: a service got moved to a new subdomain, or someone tightened the `Access-Control-Allow-Origin` list and forgot a caller. Sentry sees `TypeError: Failed to fetch` but can't distinguish a CORS rejection from a network failure. Agentry can — if your client wraps fetch and tags the failure mode, the agent groups them and points at the misconfig.

## What you get

- A list of CORS-blocked requests grouped by `(origin, endpoint)`
- The deploy SHA that most likely introduced the regression
- The exact CORS header to add to fix it

## Walk through it

**You:**
> Are we getting any CORS errors in production? Group by origin and which endpoint is rejecting them.

**Agent:**
> Let me query CORS-flagged errors and group them.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.origin AS origin, properties.endpoint AS endpoint, count() AS cnt, uniq(distinct_id) AS users, min(timestamp) AS first_seen FROM events WHERE event = '$exception' AND properties.cors_blocked = true AND timestamp >= now() - INTERVAL 7 DAY GROUP BY origin, endpoint ORDER BY cnt DESC"
```
```text
{
  "rows": [
    { "origin": "https://app.acme.io", "endpoint": "https://api.acme.io/v2/billing",
      "cnt": 412, "users": 88, "first_seen": 1747280000 },
    { "origin": "https://docs.acme.io", "endpoint": "https://api.acme.io/v2/search",
      "cnt": 19, "users": 7, "first_seen": 1747340000 }
  ]
}
```

**Agent:**
> Two CORS issues. The first one is your main app `app.acme.io` being rejected by `api.acme.io/v2/billing` — 412 blocked requests across 88 users. That endpoint was just moved or had its CORS policy changed. Let me check the deploy timeline.

```text
Endpoint: GET /v1/projects/:project_id/deploys
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fdeploys&method=get
Use query parameters, not a JSON body.
Query/filter concept:
  limit: 5
  since: 1747270000
```
```text
{
  "deploys": [
    { "sha": "9c3a210", "service": "api", "received_at": 1747278000,
      "message": "refactor: split billing into separate microservice" },
    { "sha": "a3f29b1", "service": "app", "received_at": 1747340500,
      "message": "feat: dashboard v2" }
  ]
}
```

**Agent:**
> Confirmed. Deploy `9c3a210` ~30 min before the first CORS rejection split billing into its own service. The new service is missing `app.acme.io` from its `Access-Control-Allow-Origin` allowlist.
>
> The second issue (`docs.acme.io` → `/v2/search`) is more recent and lower volume, likely a forgotten allowlist entry for the new docs subdomain.
>
> Fix is to add both to the API's CORS config:
> ```
> Access-Control-Allow-Origin: https://app.acme.io, https://docs.acme.io
> ```
> Want me to draft the config PR?

## The output

```
CORS-blocked requests (7d)

ORIGIN                  ENDPOINT                              COUNT  USERS  FIRST SEEN
app.acme.io             api.acme.io/v2/billing                  412     88  30m after 9c3a210
docs.acme.io            api.acme.io/v2/search                    19      7  not deploy-related

Diagnosis:
  Deploy 9c3a210 ("split billing into microservice") shipped 30 min before
  the first CORS block on /v2/billing. Almost certainly the new service is
  missing `app.acme.io` from Access-Control-Allow-Origin.

Fix:
  In billing service config (apps/billing/src/middleware/cors.ts):

    + const ALLOWED_ORIGINS = [
    +   "https://app.acme.io",
    +   "https://docs.acme.io",
    + ];

  Or pattern-match: `https://*.acme.io`
```

## Setting it up

CORS rejection appears in the browser as a generic failed fetch, so review the
source wrapper that can prove cross-origin context before classifying it. Use
the official PostHog web SDK's exception capture with `cors_blocked: true`, a
normalized origin, normalized endpoint, and release; never include credentials
or URL query strings.

Run `agentry onboard` to place that capture at the owning wrapper and prove it
against real PostHog exceptions. A generic `TypeError: Failed to fetch` without
the reviewed context is not enough to claim CORS.

## Variations

- *"Show CORS errors only from authenticated users — anonymous CORS rejections might be probes."*
- *"Which of our subdomains are blocked the most? Maybe we forgot one in the allowlist entirely."*
- *"For the top CORS issue, give me the exact config diff for nginx / Cloudflare Workers / Express."*
- *"After an API deploy, review the next hour's CORS rejections on demand and draft a #eng-api summary if a new pattern appears."*
