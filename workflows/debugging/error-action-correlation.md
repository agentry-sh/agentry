# Which user action triggers which error?

Join errors and analytics events by distinct_id and timestamp. For each top fingerprint,
surface the user action that immediately preceded it.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Which user action triggers which error?
description: >-
  Join errors and analytics events by distinct_id and timestamp. For each top
  fingerprint, surface the user action that immediately preceded it.
category: debugging
tags:
  - errors
  - analytics
  - cross-signal
  - sentry-alternative
  - posthog-alternative
prompt: >-
  For each top error fingerprint, find what user action immediately preceded it.
  Join errors and analytics events by distinct_id and timestamp.
difficulty: advanced
time_to_value: 3 minutes
prereqs:
  - Both errors and analytics events flowing to the same project
  - '`distinct_id` shared between the two signal types'
applies_to:
  - b2c-saas
  - b2b-saas
  - ecommerce
  - marketplace
  - devtools-api
  - content-media
required_events:
  - $exception
  - user_action
required_event_properties:
  $exception:
    - fingerprint
  user_action:
    - action
    - route
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
ask_if_missing:
  - >-
    Which observed events map to $exception, user_action? Are the required signals
    source-verified, and do live PostHog event/property reads show
    real traffic for them?
  - >-
    Which live properties provide $exception.fingerprint, user_action.action,
    user_action.route, and which stable user or account identifier joins the
    signals?
related:
  - customer-investigation
  - silent-bugs
  - deploy-regression
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
```

</details>

## Why this matters

A stack trace tells you the line that threw. It does not tell you what the user *did* to get there. "TypeError on line 88" — but did they click checkout? Search? Toggle a filter? Three different paths, three different fixes.

In a Sentry+Mixpanel world you have errors in one tool and behavior in another. The data lives in different databases with different user identifiers. You eyeball timestamps in two tabs and guess.

Agentry puts both in the same store with the same `distinct_id` key. One HogQL query does the asof-join: for each error event, find the most recent analytics event by the same user within the previous 60 seconds. The "what did the user just do" answer falls out in one query.

## What you get

- For each top-N error fingerprint: the most common analytics event in the 60 seconds before
- A confidence score (how concentrated is the preceding-action distribution?)
- Reproduction steps for the top error: "click X, click Y, then the bug fires"

## Walk through it

**You:**
> For each top error fingerprint, find what user action immediately preceded it.

**Agent:**
> Let me pull the top error fingerprints first.

```text
Endpoint: GET /v1/projects/:project_id/cases
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fcases&method=get
Use query parameters, not a JSON body.
Query/filter concept:
  status: "open",
  since: "7d",
  limit: 5,
  order_by: "event_count"
```
```text
{
  "cases": [
    { "id": "c_f72a", "fingerprint": "f_72a", "message": "TypeError on user.plan", "event_count": 412 },
    { "id": "c_2d8e", "fingerprint": "f_2d8e", "message": "checkout 500: stripe timeout", "event_count": 89 },
    { "id": "c_91dd", "fingerprint": "f_91dd", "message": "Failed to load /api/projects", "event_count": 64 }
  ]
}
```

**Agent:**
> Now the asof-join: for each error, what analytics event happened in the 60s before?

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "WITH errors AS (SELECT distinct_id, timestamp AS err_ts, properties.fingerprint AS fp FROM events WHERE event = '$exception' AND properties.fingerprint IN ('f_72a','f_2d8e','f_91dd') AND timestamp >= now() - INTERVAL 7 DAY), preceding AS (SELECT e.fp AS fp, a.event AS preceding_event, e.distinct_id AS did, a.timestamp AS act_ts, e.err_ts FROM errors e ASOF LEFT JOIN events a ON e.distinct_id = a.distinct_id AND a.timestamp <= e.err_ts WHERE a.event != '$exception' AND a.timestamp >= e.err_ts - INTERVAL 60 SECOND) SELECT fp, preceding_event, count() AS cnt FROM preceding GROUP BY fp, preceding_event ORDER BY fp, cnt DESC"
```
```text
{
  "rows": [
    { "fp": "f_72a", "preceding_event": "clicked_account_settings", "cnt": 388 },
    { "fp": "f_72a", "preceding_event": "page_loaded:/settings", "cnt": 16 },
    { "fp": "f_72a", "preceding_event": "$pageview", "cnt": 8 },
    { "fp": "f_2d8e", "preceding_event": "clicked_checkout_button", "cnt": 84 },
    { "fp": "f_2d8e", "preceding_event": "submitted_payment_form", "cnt": 5 },
    { "fp": "f_91dd", "preceding_event": "clicked_projects_tab", "cnt": 42 },
    { "fp": "f_91dd", "preceding_event": "$pageview", "cnt": 18 },
    { "fp": "f_91dd", "preceding_event": "applied_filter", "cnt": 4 }
  ]
}
```

**Agent:**
> Clean reproduction steps for all three:
>
> 1. **`f_72a` (TypeError on user.plan):** 94% triggered by `clicked_account_settings`. Repro: log in as a free-tier user, click account settings, bug fires. The 6% "page_loaded:/settings" is bookmark/deep-link traffic — same path.
> 2. **`f_2d8e` (checkout 500):** 94% triggered by `clicked_checkout_button`. Repro: click checkout. Not even the payment form — the failure is server-side before form render.
> 3. **`f_91dd` (Failed to load /api/projects):** 65% triggered by `clicked_projects_tab`. The 30% `$pageview` is direct navigation. The 6% `applied_filter` is interesting — there might be a filter combination that triggers a slower variant of the same bug.
>
> For `f_72a`, want me to dig into one specific user's session?

## The output

```
Reproduction steps (top 3 errors, 7d)

f_72a    TypeError on user.plan
         Trigger:  clicked_account_settings (94%)
         Repro:    [log in as free tier] → [click Account Settings]
         Confidence: HIGH

f_2d8e   checkout 500: stripe timeout
         Trigger:  clicked_checkout_button (94%)
         Repro:    [add item to cart] → [click Checkout]
         Confidence: HIGH

f_91dd   Failed to load /api/projects
         Trigger:  clicked_projects_tab (65%)
                   $pageview /projects direct (29%)
                   applied_filter (6%)  ← worth investigating
         Repro:    [click Projects tab] — usually
                   [apply a filter] — sometimes, maybe a slower variant
         Confidence: MEDIUM (multi-modal)

Next: f_91dd's filter sub-pattern is suspicious. Want me to find which
      specific filter values are over-represented in the 6%?
```

## Setting it up

The workflow requires three things:

1. **Errors and analytics in the same customer PostHog project** — use the
   application's existing official PostHog SDK setup at each source boundary.
2. **The same stable identity on both** — identify the user consistently before
   both analytics and exception capture.
3. **Useful analytics events** — `$pageview` is fine but `clicked_X` semantic events make the repro steps specific.

```ts
// Existing, initialized official PostHog web SDK.
posthog.identify(currentUser?.id ?? visitorId);

<button onClick={() => {
  posthog.capture("clicked_checkout_button");
  goToCheckout();
}}>
  Checkout
</button>
```

Enable the SDK's official exception integration so errors use that same
identity. `$pageview` alone gives you "they were on /settings" but
`clicked_account_settings` gives you "they clicked the menu item." Run
`agentry onboard` to verify the identity join and source boundaries.

## Variations

- *"For error `c_f72a`, give me the FULL pre-error session of 3 specific affected users — not just the last action."*
- *"Build the asof-join the OTHER way: for users who triggered checkout, what % went to error vs success?"*
- *"Find error fingerprints with NO preceding analytics event in the last 60s. Those are server-internal (cron, webhook)."*
- *"Find errors where the preceding action distribution is bimodal — multiple distinct repro paths."*
