# Which doc page leads to the most API adoption?

Funnel from a docs page view to first api_request by the same distinct_id within 7 days.
Per-doc-page breakdown — find the highest-leverage page in your docs.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Which doc page leads to the most API adoption?
description: >-
  Funnel from a docs page view to first api_request by the same distinct_id
  within 7 days. Per-doc-page breakdown — find the highest-leverage page in your
  docs.
category: growth
tags:
  - analytics
  - funnels
  - devtools-api
  - content-marketing
  - documentation
  - posthog-alternative
prompt: >-
  Build a funnel from docs page views (page_view on /docs/*) to first
  api_request by the same distinct_id within 7 days. Per-doc-page breakdown.
  Which docs convert?
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - >-
    `page_view` events on docs pages with `path` in properties (and
    `distinct_id` from a docs-visitor cookie)
  - >-
    `api_request` events with the same `distinct_id` (developers using their
    personal API key sign in to docs first)
  - >-
    Some bridge from docs identity to API identity (usually via the API key the
    developer copies from docs)
applies_to:
  - devtools-api
required_events:
  - page_view
  - api_request
required_event_properties:
  page_view:
    - path
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
  - >-
    Do not present illustrative custom analysis as a built-in query blueprint or
    runnable Agentry product surface.
ask_if_missing:
  - >-
    Which observed events map to page_view, api_request? Are the required signals
    source-verified, and do live PostHog event/property reads show
    real traffic for them?
  - >-
    Which live properties provide page_view.path, and which stable user or
    account identifier joins the signals?
related:
  - signup-funnel
  - onboarding-email-funnel
  - api-usage-by-customer
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
example_only: true
```

</details>

## Why this matters

Devtools live on docs. Your `/docs/quickstart` is read more than your homepage. Your `/docs/auth` decides whether someone makes their first successful call. Your `/docs/webhooks` decides whether they integrate beyond the demo.

Yet most teams treat docs analytics as "page views" — total bytes shipped, no funnel attached. The question that matters is: **which doc page drives the most first-API-calls within a week?** That's the highest-leverage page in your entire content strategy.

Agentry has both events in one table — docs page views and API requests — both keyed by `distinct_id`. The funnel takes one prompt. The answer reshapes your content roadmap.

## What you get

- Per-doc-page funnel: views → first API call within 7 days
- Ranked by conversion rate so you see what works
- The list of doc pages with high views but low conversion (= rewrite candidates)
- Dashboard rows for content/devrel weekly review

## Walk through it

**You:**
> Build a funnel from docs page views (page_view on /docs/*) to first api_request by the same distinct_id within 7 days. Per-doc-page breakdown. Which docs convert?

**Agent:**
> Joined HogQL — distinct_id of doc viewer, then check whether they made any api_request in the following 7 days.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "
    with doc_visits as (
      select
        distinct_id,
        properties.path as path,
        min(timestamp) as first_view
      from events
      where event = 'page_view'
        and properties.path like '/docs/%'
        and timestamp > now() - interval 30 day
      group by distinct_id, path
    ),
    first_api_call as (
      select distinct_id, min(timestamp) as first_call_ts
      from events
      where event = 'api_request'
      group by distinct_id
    )
    select
      dv.path,
      count(distinct dv.distinct_id) as viewers,
      countIf(fac.first_call_ts > dv.first_view
              and fac.first_call_ts < dv.first_view + interval 7 day) as converters,
      countIf(fac.first_call_ts > dv.first_view
              and fac.first_call_ts < dv.first_view + interval 7 day) * 1.0
       / count(distinct dv.distinct_id) as conv_rate
    from doc_visits dv
    left join first_api_call fac using (distinct_id)
    group by dv.path
    having viewers >= 100
    order by conv_rate desc
    limit 20
  "
```
```text
{
  "rows": [
    { "path": "/docs/quickstart",        "viewers": 12400, "converters": 4216, "conv_rate": 0.340 },
    { "path": "/docs/auth",              "viewers":  8200, "converters": 2542, "conv_rate": 0.310 },
    { "path": "/docs/sdks/javascript",   "viewers":  6800, "converters": 2040, "conv_rate": 0.300 },
    { "path": "/docs/sdks/python",       "viewers":  4200, "converters": 1218, "conv_rate": 0.290 },
    { "path": "/docs/webhooks",          "viewers":  3100, "converters":  806, "conv_rate": 0.260 },
    { "path": "/docs/api-reference",     "viewers": 18400, "converters": 4232, "conv_rate": 0.230 },
    { "path": "/docs/examples",          "viewers":  2200, "converters":  330, "conv_rate": 0.150 },
    { "path": "/docs/changelog",         "viewers": 14200, "converters":  710, "conv_rate": 0.050 },
    { "path": "/docs/pricing",           "viewers":  9800, "converters":  392, "conv_rate": 0.040 }
  ]
}
```

**Agent:**
> Picture:
>
> | Page | Viewers | 7d-to-API-call % |
> |---|---|---|
> | `/docs/quickstart` | 12,400 | **34.0%** ★ (your champion) |
> | `/docs/auth` | 8,200 | 31.0% |
> | `/docs/sdks/javascript` | 6,800 | 30.0% |
> | `/docs/sdks/python` | 4,200 | 29.0% |
> | `/docs/webhooks` | 3,100 | 26.0% |
> | `/docs/api-reference` | 18,400 | 23.0% (high traffic, lower conv) |
> | `/docs/examples` | 2,200 | 15.0% ★ (low traffic, also low conv — rewrite) |
> | `/docs/changelog` | 14,200 | 5.0% (not the goal — informational page) |
> | `/docs/pricing` | 9,800 | 4.0% (people researching, not building) |
>
> Three takeaways:
>
> 1. **Promote `/docs/quickstart` harder.** 34% conversion is your peak — every visitor who lands on it is 7× more likely to convert than someone reading `/docs/pricing`. Should be the default landing from `/docs`, not buried as a tab.
> 2. **`/docs/examples` underperforms its category.** 15% conv on a how-to page is bad — your SDK pages do 30%. Worth a rewrite or restructure (more snippets, less prose).
> 3. **`/docs/api-reference` has weird shape.** Huge traffic (18k) but lower conv (23%) — that's expected (reference is for already-integrated users), but you could check whether visitors who land there cold ever convert.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "<same query above>"
```
```text
{ "rows": [/* dashboard rows */], "row_count": 25 }
```

**Agent:**
> Dashboard data ready. Suggested follow-ups:
>
> 1. **A/B test the `/docs` landing** — half the traffic sees quickstart inline, half sees the current overview. Which converts higher?
> 2. **Rewrite `/docs/examples`** and re-measure in 30 days
> 3. **Trace by source** — which acquisition channels send the most quickstart-page visitors? Double down on those channels.

## The output

```
Docs → first API call funnel (30d, 7-day attribution window)

Path                          Viewers   Converters   Conv %    Action
─────────────────────────────────────────────────────────────────────
/docs/quickstart              12,400      4,216      34.0%    ★ promote
/docs/auth                     8,200      2,542      31.0%
/docs/sdks/javascript          6,800      2,040      30.0%
/docs/sdks/python              4,200      1,218      29.0%
/docs/webhooks                 3,100        806      26.0%
/docs/api-reference           18,400      4,232      23.0%    high vol low conv
/docs/examples                 2,200        330      15.0%    ★ rewrite
/docs/changelog               14,200        710       5.0%    informational
/docs/pricing                  9,800        392       4.0%    pre-purchase

Recommendations:
  - Default landing /docs → /docs/quickstart
  - Rewrite /docs/examples (15% conv vs sibling 30%)
  - Per-source attribution: which channels send quickstart traffic?

Public view:
  Use Agentry's returned public_url after publishing a real query blueprint.
```

## Setting it up

The trick is the `distinct_id` bridge between "docs visitor" and "API user." Three common patterns:

**Pattern A: Logged-in docs.** Your docs site requires sign-in (or has an optional sign-in for personalized examples). Use the same user id for the docs `distinct_id` and the API `customer_id`:

```html
<script>
// Existing, initialized official PostHog web SDK.
posthog.identify("{{ user.id }}");
posthog.capture("docs_page_viewed", {
  path: location.pathname,
  referrer: document.referrer,
});
</script>
```

**Pattern B: API key as the bridge.** The developer copies a key from docs to their code. Encode the docs-visitor cookie id in the metadata of the API key they create (or use the key's hash itself):

```ts
// API middleware
const apiKey = c.req.header("authorization")?.replace(/^Bearer /, "");
const customer = await resolveCustomer(apiKey);
const docsCookie = customer.metadata.docs_visitor_id;  // populated when they made the key

posthog.capture({
  distinctId: docsCookie ?? customer.id,
  event: "api_request",
  properties: { customer_id: customer.id, endpoint: c.req.routePath },
});
```

**Pattern C: Both events use a cookie set by docs.** The dev clicks "try it in the playground" on docs — that calls your API with the docs cookie attached as a header. From there both events share the cookie id.

All captures above go directly through the customer's official PostHog SDKs.
Run `agentry onboard` to review anonymous-to-known identity linking and prevent
raw API keys, authorization headers, or full URLs from entering properties.

## Variations

- *"Same funnel but conversion = `api_request_succeeded` (2xx response). 'Made any call' counts 4xx fumbles — first-success is the real signal."*
- *"Per-language: visitors of `/docs/sdks/python` who made a Python SDK call within 7 days vs visitors of `/docs/sdks/javascript` who made a JS call. Language-specific conversion."*
- *"Same funnel from search-engine referrers only. Are SEO-arriving devs converting at the same rate as direct?"*
- *"Conversion by docs-page time-on-page bucket. Do quick scanners convert at the same rate as long readers?"*
