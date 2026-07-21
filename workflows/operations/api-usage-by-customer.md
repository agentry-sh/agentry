# Per-customer API call analytics

Group api_request events by customer_id over 30 days with daily breakdown. The view
usage-based pricing needs but most teams cobble together from logs.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Per-customer API call analytics
description: >-
  Group api_request events by customer_id over 30 days with daily breakdown. The
  view usage-based pricing needs but most teams cobble together from logs.
category: ops
tags:
  - analytics
  - devtools-api
  - api-quota
  - dashboards
  - b2b
prompt: >-
  Group api_request events by customer_id in the last 30 days. Show me top 20
  customers by call volume, with daily breakdown for each.
difficulty: intermediate
time_to_value: 3 minutes
prereqs:
  - >-
    Every API request emitting an `api_request` analytics event with
    `customer_id` (or `api_key_prefix`)
  - 30+ days of data so the daily series is meaningful
applies_to:
  - devtools-api
required_events:
  - api_request
required_event_properties:
  api_request:
    - customer_id
    - endpoint
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
    Which observed events map to api_request? Are the required signals
    source-verified, and do live PostHog event/property reads show real traffic for
    them?
  - >-
    Which live properties provide api_request.customer_id, api_request.endpoint,
    and which stable user or account identifier joins the signals?
related:
  - api-usage-as-upsell-signal
  - rate-limit-alert-routing
  - sdk-adoption-after-release
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
example_only: true
```

</details>

## Why this matters

If you sell a usage-based API, the per-customer usage table is your second-most-important dashboard (after MRR). Yet most teams build it badly:

- The data lives in CloudFlare logs or application logs that aren't queryable per-customer
- The "dashboard" is a quarterly SQL someone ran by hand
- CS can't pull "how much did Acme use last week?" without pinging engineering
- Sales has no idea who's growing usage (= ready to upsell) vs flatlining (= about to churn)

Agentry treats API requests as just-another-analytics-event. One HogQL pass gives you top customers, daily series, growth rate — the lot. Then render the rows in a CS-visible server-side dashboard so the team doesn't have to ping engineering for every account check.

## What you get

- Top 20 customers by 30-day call volume
- Daily breakdown per customer (sparkline data)
- Dashboard rows that CS and sales can both pull up from a server-side panel

## Walk through it

**You:**
> Group api_request events by customer_id in the last 30 days. Show me top 20 customers by call volume, with daily breakdown for each.

**Agent:**
> Two passes — first the ranked top 20, then daily series for each.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "
    select
      properties.customer_id as customer_id,
      count() as total_calls,
      count(distinct toDate(timestamp)) as active_days,
      max(timestamp) as last_call_at
    from events
    where event = 'api_request' and timestamp > now() - interval 30 day
    group by customer_id
    order by total_calls desc
    limit 20
  "
```
```text
{
  "rows": [
    { "customer_id": "acme_corp",     "total_calls": 18420000, "active_days": 30, "last_call_at": "2026-05-16T13:42:00Z" },
    { "customer_id": "wayne_ent",     "total_calls":  9842000, "active_days": 30, "last_call_at": "2026-05-16T13:41:00Z" },
    { "customer_id": "stark_ind",     "total_calls":  6210000, "active_days": 28, "last_call_at": "2026-05-15T22:18:00Z" },
    { "customer_id": "umbrella_co",   "total_calls":  4810000, "active_days": 30, "last_call_at": "2026-05-16T13:30:00Z" },
    { "customer_id": "initech_llc",   "total_calls":   180000, "active_days":  8, "last_call_at": "2026-05-04T10:00:00Z" }
  ]
}
```

**Agent:**
> Now the daily series for the top customers so you can see the shape.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "
    select
      properties.customer_id as customer_id,
      toDate(timestamp) as day,
      count() as calls
    from events
    where event = 'api_request'
      and timestamp > now() - interval 30 day
      and properties.customer_id in ('acme_corp', 'wayne_ent', 'stark_ind', 'umbrella_co', 'initech_llc')
    group by customer_id, day
    order by customer_id, day
  "
```
```text
{
  "rows": [
    { "customer_id": "acme_corp",   "day": "2026-04-16", "calls":  580000 },
    { "customer_id": "acme_corp",   "day": "2026-04-17", "calls":  604000 },
    { "customer_id": "acme_corp",   "day": "2026-04-18", "calls":  590000 },
    "...",
    { "customer_id": "initech_llc", "day": "2026-04-29", "calls":   12000 },
    { "customer_id": "initech_llc", "day": "2026-05-04", "calls":  168000 },
    { "customer_id": "initech_llc", "day": "2026-05-05", "calls":       0 }
  ]
}
```

**Agent:**
> Two interesting cases worth flagging to CS/Sales right now:
>
> - **`stark_ind`**: 6.2M calls / month, but `active_days = 28` and last call 2 days ago. They've gone quiet. Either weekend lull or churn risk. Worth a CS check-in.
> - **`initech_llc`**: 180k total but only 8 active days, last call 12 days ago. Classic dormant API customer — they integrated, hit it once big, then ghosted. A "did we miss anything?" email here is high-leverage.
>
> Let me prepare the rolling top-20 for a dashboard panel.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "<first query above>"
```
```text
{ "rows": [/* dashboard rows */], "row_count": 20 }
```

**Agent:**
> Dashboard data ready. Recommended follow-ups:
>
> 1. `api-usage-as-upsell-signal` — find the customers whose calls grew >30% MoM (= ready to upsell)
> 2. `rate-limit-alert-routing` — review customers crossing 80% of their cap
> 3. Draft a weekly-window delta summary for CS to review and share

## The output

```
Top 20 API customers (30d)

Customer        Calls (30d)    Active days   Last call         Trend
─────────────────────────────────────────────────────────────────────
acme_corp       18,420,000          30        2 min ago        steady █████
wayne_ent        9,842,000          30        3 min ago        growing ███▟
stark_ind        6,210,000          28        2 days ago       ★ check in
umbrella_co      4,810,000          30        15 min ago       steady ████
initech_llc        180,000           8        12 days ago      ★★ dormant

Public view:
  Use Agentry's returned public_url after publishing a real query blueprint.

Suggested next investigations:
  - api-usage-as-upsell-signal (who's growing?)
  - rate-limit-alert-routing (who's hitting caps?)
  - on-demand weekly-window delta summary for a human to share with CS
```

## Setting it up

Capture an `api_request` event through the customer's existing official PostHog
server SDK only when per-request telemetry is justified. The key design choice
is what to put in `customer_id`:

- For API-key auth: the customer (org/project) the key belongs to, NOT the raw key
- For OAuth: the OAuth client id
- For Bearer JWT: a sub-claim you control

Tag a few useful properties for downstream segmentation:

```ts
// Hono / Express middleware after auth
app.use(async (c, next) => {
  const customer = await resolveCustomer(c.req.header("authorization"));
  c.set("customer", customer);

  posthog.capture({
    distinctId: customer.id,
    event: "api_request",
    properties: {
      customer_id: customer.id,
      plan: customer.plan,
      endpoint: c.req.routePath,
      method: c.req.method,
      sdk_version: c.req.header("x-sdk-version"),
      ip_country: c.req.header("cf-ipcountry"),
    },
  });
  await next();
});
```

**Per-request volume warning:** prefer an aggregate or explicit sampling plan at
high RPS. Run `agentry onboard` to review volume, cardinality, privacy, and the
request-completion boundary; Agentry neither ingests nor bills these events.

## Variations

- *"Same top-20 but split by API endpoint — which endpoints are the heavy hitters?"*
- *"Hour-of-day distribution for the top 5 customers. Are they bursty or steady-state?"*
- *"Per-customer error rate (4xx + 5xx ÷ total). Sometimes a top customer's usage is mostly failing requests."*
- *"Show me customers whose usage dropped >50% in the last 7 days vs prior 7. Early churn signals."*
