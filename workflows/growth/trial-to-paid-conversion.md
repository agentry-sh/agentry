# Track trial-to-paid conversion by acquisition source

Build the trial-to-paid funnel split by acquisition source. Surface the channel that
converts 8x better than the rest.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Track trial-to-paid conversion by acquisition source
description: >-
  Build the trial-to-paid funnel split by acquisition source. Surface the
  channel that converts 8x better than the rest.
category: growth
tags:
  - analytics
  - funnels
  - trial-conversion
  - saas
  - acquisition
  - mixpanel-alternative
prompt: >-
  Build the trial-to-paid funnel split by acquisition source. Which channel
  converts trials best?
difficulty: intermediate
time_to_value: 3 minutes
prereqs:
  - >-
    Events flowing for `trial_started` and `subscription_started` (or your
    equivalents)
  - Acquisition source captured on signup (UTM params or referrer)
applies_to:
  - b2c-saas
  - b2b-saas
  - devtools-api
requires_revenue: true
required_events:
  - signup_completed
  - trial_started
  - subscription_started
required_event_properties:
  signup_completed:
    - utm_source
  subscription_started:
    - plan
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
  - >-
    Do not recommend this for products without a real revenue lifecycle or an
    equivalent paid-account signal.
  - >-
    Do not present illustrative custom analysis as a built-in query blueprint or
    runnable Agentry product surface.
ask_if_missing:
  - >-
    Which observed events map to signup_completed, trial_started,
    subscription_started? Are the required signals source-verified, and do live
    PostHog event/property reads show real traffic for them?
  - >-
    Which live properties provide signup_completed.utm_source,
    subscription_started.plan, and which stable user or account identifier joins
    the signals?
related:
  - signup-funnel
  - activation-moment
  - expansion-prediction
featured: false
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
example_only: true
```

</details>

## Why this matters

Most acquisition dashboards show traffic. The metric that actually matters is conversion-by-source. Reddit might be 1% of your traffic but 8% of your paid signups; LinkedIn might be 30% of traffic and 2% of paid. Spending $5k on more LinkedIn ads is then provably wrong.

Mixpanel has this view but you set it up once per source and re-build it every quarter. GA4 has UTMs but no funnel UI. Most teams have a Notion doc with stale numbers and a Slack message asking "wait, where do our actual paying customers come from?"

Agentry first checks whether the saved signal map is source-verified and live
PostHog properties can actually support the question. Then HogQL groups the
funnel by `acquisition_source`; a public view is only a separately reviewed
follow-up.

## What you get

- A table of acquisition sources × trial-start × paid-conversion × conversion rate
- The channel with the **best conversion rate** (not just the most volume)
- Optional browser-safe output when you explicitly ask for an embeddable weekly review

## Walk through it

**You:**
> Build the trial-to-paid funnel split by acquisition source. Which channel converts trials best?

**Agent:**
> Let me check your event vocabulary first.

```text
Endpoint: GET /v1/projects/:project_id/event-names
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fevent-names&method=get
Use query parameters, not a JSON body.
Query/filter concept:
  matching: "trial|signup|subscription|paid"
```
```text
{
  "server_emitted": [],
  "analytics_events": [
    { "event": "trial_started", "count": 4280, "last_seen": 1783651200 },
    { "event": "signup_completed", "count": 4310, "last_seen": 1783651210 },
    { "event": "subscription_started", "count": 412, "last_seen": 1783651250 },
    { "event": "subscription_canceled", "count": 31, "last_seen": 1783651290 }
  ],
  "wildcards": []
}
```

**Agent:**
> Good — `trial_started` and `subscription_started` are plausible edges. I
> still need to verify that `acquisition_source` exists on the trial event and
> that both events use the same stable identity before running the comparison.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "WITH trials AS (SELECT distinct_id, properties.acquisition_source AS source, min(timestamp) AS trial_ts FROM events WHERE event = 'trial_started' AND timestamp >= now() - INTERVAL 90 DAY GROUP BY distinct_id, source), paid AS (SELECT distinct_id, min(timestamp) AS paid_ts FROM events WHERE event = 'subscription_started' AND timestamp >= now() - INTERVAL 90 DAY GROUP BY distinct_id) SELECT t.source AS source, count(DISTINCT t.distinct_id) AS trials_count, count(DISTINCT p.distinct_id) AS paid_count, round(count(DISTINCT p.distinct_id) * 100.0 / count(DISTINCT t.distinct_id), 1) AS conv_pct FROM trials t LEFT JOIN paid p ON t.distinct_id = p.distinct_id AND p.paid_ts > t.trial_ts AND p.paid_ts < t.trial_ts + INTERVAL 14 DAY GROUP BY source ORDER BY trials_count DESC"
```
```text
{
  "rows": [
    { "source": "google_organic", "trials_count": 1820, "paid_count": 142, "conv_pct": 7.8 },
    { "source": "linkedin_ads",   "trials_count": 980,  "paid_count": 41,  "conv_pct": 4.2 },
    { "source": "direct",         "trials_count": 720,  "paid_count": 71,  "conv_pct": 9.9 },
    { "source": "reddit",         "trials_count": 142,  "paid_count": 31,  "conv_pct": 21.8 },
    { "source": "twitter",        "trials_count": 312,  "paid_count": 18,  "conv_pct": 5.8 },
    { "source": "producthunt",    "trials_count": 280,  "paid_count": 88,  "conv_pct": 31.4 }
  ]
}
```

**Agent:**
> In this illustrative result, Product Hunt and Reddit have higher observed
> trial-to-paid rates. The samples differ substantially, and conversion alone
> does not establish CAC, payback, incrementality, or channel profitability.
>
> This by-source conversion query is custom HogQL, not a built-in public-query blueprint. I can keep it in a protected internal dashboard by running the `analytics/query` call server-side. If you want a browser-safe public URL, I should first add a real trial-to-paid query blueprint and then publish that blueprint.

**Agent:**
> Protected result ready. The next step is to review spend, cohort quality,
> retention, attribution, and uncertainty before changing any campaign.

## The output

```
Trial → Paid by Acquisition Source (90d, 14-day conversion window)

SOURCE             TRIALS   PAID   CONV%   SAMPLE NOTE
producthunt           280     88   31.4%   smaller cohort
reddit                142     31   21.8%   small cohort
direct                720     71    9.9%   attribution may mix sources
google_organic      1,820    142    7.8%   largest observed cohort
twitter               312     18    5.8%   smaller cohort
linkedin_ads          980     41    4.2%   spend/payback not measured

Volume vs quality split:
  Volume leaders:  google_organic, linkedin_ads
  Quality leaders: producthunt, reddit, direct

Review before action:
  - add spend and payback before judging paid-channel economics
  - compare later retention and revenue using the same identity/cohort rules
  - validate attribution and sample stability before changing budgets

Public view:
  Use Agentry's returned public_url after publishing a real query blueprint.
```

## Setting it up

You need two events plus a UTM-style source on the trial event:

```ts
// Existing, initialized official PostHog Node client after email verification.
posthog.capture({
  distinctId: user.id,
  event: "trial_started",
  properties: {
    acquisition_source: user.utm_source ?? "direct",
    acquisition_campaign: user.utm_campaign,
    referrer: user.initial_referrer,
  },
});

posthog.capture({
  distinctId: subscription.metadata.user_id,
  event: "subscription_started",
  properties: {
    plan: subscription.items.data[0].plan.nickname,
    amount: subscription.items.data[0].plan.amount,
  },
});
```

To capture `utm_source` on signup, snapshot it from the landing page into a first-party cookie (or `localStorage`) and read it on signup:

```ts
// On any landing page hit:
const params = new URLSearchParams(window.location.search);
if (params.get("utm_source")) {
  localStorage.setItem("acq_source", params.get("utm_source")!);
  localStorage.setItem("acq_campaign", params.get("utm_campaign") ?? "");
}
// On signup submission, send the values to the application server whose
// official PostHog SDK captures `trial_started`; do not put the full landing
// URL in event properties.
```

Run `agentry onboard` to review attribution privacy, stable identity, and the
durable trial/payment boundaries before adding or moving either event.

## Variations

- *"Same funnel but for the last 30 days only — has anything shifted post-launch?"*
- *"Compare trial-to-paid by GEO (country) — are non-US trials converting differently?"*
- *"For Product Hunt specifically, what's the path-to-paid? Show the average # of sessions before paying."*
- *"Build a separate dashboard for paid ad channels only (LinkedIn, Google ads, Facebook). Compare CPA × conversion %."*
