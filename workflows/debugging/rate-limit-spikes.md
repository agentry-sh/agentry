# Detect a 429-spike before customers tweet about it

Trend HTTP 429 responses week-over-week and flag spikes. Catch third-party rate-limit
tightening or a runaway customer integration.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Detect a 429-spike before customers tweet about it
description: >-
  Trend HTTP 429 responses week-over-week and flag spikes. Catch third-party
  rate-limit tightening or a runaway customer integration.
category: debugging
tags:
  - errors
  - rate-limiting
  - early-warning
  - oncall
  - datadog-alternative
prompt: >-
  Are we hitting any rate limits unusually often this week? Look for 429 errors
  trending up vs the prior week.
difficulty: intermediate
time_to_value: 1 minute
prereqs:
  - PostHog exceptions carry HTTP status codes in `http_status`
  - Or analytics events tracking API responses with status
applies_to:
  - devtools-api
  - b2c-saas
  - b2b-saas
required_events:
  - $exception
required_event_properties:
  $exception:
    - http_status
    - endpoint
    - upstream
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
    Which live properties provide $exception.http_status, $exception.endpoint,
    $exception.upstream, and which stable user or account identifier joins the
    signals?
related:
  - dependency-upgrade-regression
  - db-pool-exhaustion
  - staging-watcher
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
```

</details>

## Why this matters

429s are the most underwatched error class. They feel "non-critical" — the request just failed, retry later — so they sit at the bottom of every oncall queue. Then a customer's integration goes wild and DoSes your Stripe webhook, or a third-party tightens limits without warning, and suddenly half your jobs are silently bouncing.

Datadog can graph 429s if you remember to set it up. Sentry filters them out by default (they're "not errors"). Neither tells you *which* upstream is throttling you or *which* downstream caller is the offender.

Agentry treats them as first-class signal. One prompt compares this week's 429 rate against last week's per-endpoint and per-upstream, and surfaces what changed.

## What you get

- Week-over-week delta in 429 count, by endpoint and by upstream service
- The specific customer / API key whose calls are responsible (if it's one)
- A "this just started" timestamp so you can correlate with a third-party change

## Walk through it

**You:**
> Are we hitting any rate limits unusually often this week? Look for 429 errors trending up vs the prior week.

**Agent:**
> Let me compare 429 counts this week vs last week, bucketed by endpoint.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.endpoint AS endpoint, properties.upstream AS upstream, countIf(timestamp >= now() - INTERVAL 7 DAY) AS this_week, countIf(timestamp >= now() - INTERVAL 14 DAY AND timestamp < now() - INTERVAL 7 DAY) AS last_week FROM events WHERE event = '$exception' AND properties.http_status = 429 GROUP BY endpoint, upstream ORDER BY this_week DESC"
```
```text
{
  "rows": [
    { "endpoint": "POST /api/stripe/webhook", "upstream": "stripe", "this_week": 4218, "last_week": 142 },
    { "endpoint": "GET /api/openai/completion", "upstream": "openai", "this_week": 312, "last_week": 280 },
    { "endpoint": "POST /api/sendgrid/send", "upstream": "sendgrid", "this_week": 88, "last_week": 80 }
  ]
}
```

**Agent:**
> Stripe webhook 429s jumped 30x — 142 last week, 4218 this week. Almost certainly one customer or a regression. Let me check who's calling.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT distinct_id, count() AS calls FROM events WHERE event = '$exception' AND properties.http_status = 429 AND properties.endpoint = 'POST /api/stripe/webhook' AND timestamp >= now() - INTERVAL 7 DAY GROUP BY distinct_id ORDER BY calls DESC LIMIT 5"
```
```text
{
  "rows": [
    { "distinct_id": "acct_megacorp_prod", "calls": 4011 },
    { "distinct_id": "acct_acme_prod", "calls": 102 },
    { "distinct_id": "acct_globex_prod", "calls": 41 }
  ]
}
```

**Agent:**
> 95% of the spike is one account: `acct_megacorp_prod`. They went from ~20 webhook calls a day to ~570 — either they enabled a new integration on Monday or their retry logic has gone exponential. The Stripe webhook isn't actually the problem; your code is calling it too often.
>
> Recommended: ping that customer's CSM, check if they shipped something Monday, and consider adding circuit-breaker on your side. Want me to draft the customer message?

## The output

```
429-spike report (last 7d vs prior 7d)

ENDPOINT                          UPSTREAM    LAST   THIS    DELTA
POST /api/stripe/webhook          stripe       142  4,218  +2,872%  CRITICAL
GET  /api/openai/completion       openai       280    312     +11%  normal
POST /api/sendgrid/send           sendgrid      80     88     +10%  normal

Root cause for /api/stripe/webhook:
  acct_megacorp_prod (4,011 calls — 95% of spike)
  → Started Mon May 12 ~14:00 UTC
  → Their normal baseline: ~20 calls/day
  → Now: ~570 calls/day, mostly retry-bursts

Recommended actions:
  1. Ping megacorp's CSM today — they likely shipped something Monday
  2. Add per-account circuit-breaker (`opossum` or similar)
  3. Suppress this fingerprint for the rest if it's downstream noise (see `suppress-noise`)
```

## Setting it up

The workflow needs status codes on source-verified PostHog exceptions or
analytics. For an isolated 429 failure, use the installed official server SDK's
exception integration with `http_status`, normalized `endpoint`, `upstream`,
and stable account identity. For rate analysis across all responses, capture an
`upstream_call` analytics event only after the response is known, with `status`
and bounded `latency_ms`.

Run `agentry onboard` to choose one owner and sampling strategy. Per-request
analytics can be expensive and high-cardinality, so preserve an existing
aggregate signal when it already answers the question.

## Variations

- *"Show 429s by upstream service over the last 90 days. Anything trending up monthly?"*
- *"Which of our customers are the top 429-generators against OpenAI this week?"*
- *"Are we hitting our OWN rate limits (per-API-key) for customer X? They opened a support ticket."*
- *"On demand, compare each upstream's 429 rate with the prior day and highlight anything that doubled."*
