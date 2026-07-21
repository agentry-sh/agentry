# Track static-asset 404s per release

Group asset 404s by URL and deploy SHA. Catch stale CDN caches and missing hashed
bundles before users see a blank page.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Track static-asset 404s per release
description: >-
  Group asset 404s by URL and deploy SHA. Catch stale CDN caches and missing
  hashed bundles before users see a blank page.
category: debugging
tags:
  - errors
  - cdn
  - release
  - deploys
  - frontend
  - post-deploy
prompt: >-
  Are any static assets 404ing more than expected this week? Group by URL and by
  deploy SHA so I can see if a release broke a cache key.
difficulty: intermediate
time_to_value: 2 minutes
prereqs:
  - Your frontend captures asset fetch failures (or your CDN logs 404s)
  - Deploys posted with SHA so the agent can correlate
applies_to:
  - b2c-saas
  - b2b-saas
  - ecommerce
  - content-media
  - marketplace
required_events:
  - asset_404
required_event_properties:
  asset_404:
    - url
    - release
    - deploy_sha
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
ask_if_missing:
  - >-
    Which observed events map to asset_404? Are the required signals
    source-verified, and do live PostHog event/property reads show real traffic for
    them?
  - >-
    Which live properties provide asset_404.url, asset_404.release,
    asset_404.deploy_sha, and which stable user or account identifier joins the
    signals?
related:
  - deploy-regression
  - cors-misconfig
  - browser-version-errors
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
```

</details>

## Why this matters

Hashed-filename CDN deploys are an under-appreciated source of silent breakage. Webpack/Vite/Turbopack rename `app.js` to `app-a3f29b1.js` on every build. If a user has the OLD `index.html` cached but you've already invalidated the OLD bundle URL, they get a 404 — and most apps render a blank page with no thrown error.

Sentry catches thrown exceptions, not 404s on script tags. Cloudflare logs the 404 but you'd have to push those into a log warehouse and query them. Nobody does this until a customer complains "your site is broken on my work laptop."

Agentry logs the asset 404 as an analytics or log event, joins it with your deploy timeline, and tells you "deploy `a3f29b1` is generating 50% of the 404s for stale `app-9c3a210.js` — your CDN edge in EU has stale TTLs."

## What you get

- Top 10 asset URLs returning 404s in the last 7 days
- For each: which deploy invalidated them and how many distinct users are still requesting them
- A diagnosis (stale edge cache vs missing build vs typo in source)

## Walk through it

**You:**
> Are any static assets 404ing more than expected this week? Group by URL and deploy SHA.

**Agent:**
> Let me check recent deploys for context, then query asset 404s.

```text
Endpoint: GET /v1/projects/:project_id/deploys
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fdeploys&method=get
Use query parameters, not a JSON body.
Query/filter concept:
  limit: 5
```
```text
{
  "deploys": [
    { "sha": "9c3a210", "received_at": 1747353600, "message": "feat: dashboard v2" },
    { "sha": "a3f29b1", "received_at": 1747180000, "message": "fix: pagination" },
    { "sha": "b1e229c", "received_at": 1746920000, "message": "feat: pricing page" }
  ]
}
```

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.url AS url, count() AS cnt, uniq(distinct_id) AS users FROM events WHERE event = 'asset_404' AND timestamp >= now() - INTERVAL 7 DAY GROUP BY url ORDER BY cnt DESC LIMIT 10"
```
```text
{
  "rows": [
    { "url": "/assets/app-a3f29b1.js", "cnt": 1284, "users": 412 },
    { "url": "/assets/vendor-a3f29b1.js", "cnt": 1180, "users": 411 },
    { "url": "/assets/logo-old.png", "cnt": 87, "users": 38 },
    { "url": "/assets/app-b1e229c.js", "cnt": 22, "users": 12 }
  ]
}
```

**Agent:**
> The pattern is clear. Deploy `9c3a210` (today) invalidated the `a3f29b1` bundle, but 412 users are still requesting `app-a3f29b1.js` and getting 404s. That means either:
>
> 1. Their `index.html` is cached at the edge with stale `<script src>` references, OR
> 2. You're serving `index.html` with `Cache-Control: max-age=3600` somewhere
>
> The `logo-old.png` is a small separate issue — 38 users, probably a forgotten reference in an email template or social share image.
>
> Recommended fix: serve `index.html` with `Cache-Control: no-cache, must-revalidate` and bump CDN edge TTL on the old bundles to 24h instead of immediate purge. Want me to draft a Cloudflare Page Rules config?

## The output

```
Asset 404s (7d), grouped by URL × deploy

URL                                COUNT   USERS   DEPLOY INVALIDATED
/assets/app-a3f29b1.js             1,284     412   9c3a210 (today)
/assets/vendor-a3f29b1.js          1,180     411   9c3a210 (today)
/assets/logo-old.png                  87      38   (not a build asset)
/assets/app-b1e229c.js                22      12   a3f29b1 (2d ago)

Diagnosis:
  ~411 users hold a stale index.html pointing at the previous bundle.
  Their next page-load JS fails to download → blank screen.
  This is your top user-facing bug right now.

Suggested fix:
  1. Set `Cache-Control: no-cache, must-revalidate` on index.html (immediate)
  2. Keep old bundle URLs alive for 48h after deploy (CDN side)
  3. Add a service-worker check that auto-reloads on bundle 404
```

## Setting it up

Capture an `asset_404` event through the application's existing official
PostHog SDK when a script/resource error hook or dynamic-import wrapper proves a
missing built asset. Include a normalized asset path, route template, release,
and stable visitor id; strip query strings and fragments.

CDN log delivery is a separate customer-owned integration and may offer more
complete coverage. Run `agentry onboard` to choose the source-backed owner,
avoid double counting browser and CDN observations, and verify the signal in
the connected PostHog project.

## Variations

- *"Show me asset 404s in EU vs US — is one edge stale and the other fine?"*
- *"For the top stale bundle, draft a Cloudflare rule that aliases it to the new one for 24h."*
- *"Find image 404s — these usually point to broken email or OG-image references."*
- *"After a deploy, check on demand for any new bundle-URL pattern that started returning 404."*
