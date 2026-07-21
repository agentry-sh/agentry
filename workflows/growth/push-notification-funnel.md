# Push notification: sent → opened → action conversion

Joined funnel from push provider's send webhook through open through in-app action.
Per-campaign breakdown — what marketing platforms refuse to show you.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: 'Push notification: sent → opened → action conversion'
description: >-
  Joined funnel from push provider's send webhook through open through in-app
  action. Per-campaign breakdown — what marketing platforms refuse to show you.
category: growth
tags:
  - analytics
  - funnels
  - push-notifications
  - mobile-app
  - retention
  - mixpanel-alternative
prompt: >-
  Build a funnel from push_sent (from our push provider webhook) → push_opened →
  next_action. Per-campaign breakdown.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - >-
    Push provider webhooks (Braze / OneSignal / FCM) capturing `push_sent`
    directly through the customer's official PostHog server SDK
  - Mobile app fires `push_opened` with the `campaign_id` from the push payload
  - Same `distinct_id` for the send-side event and the in-app event
applies_to:
  - mobile-app
required_events:
  - push_sent
  - push_opened
required_event_properties:
  push_sent:
    - campaign_id
  push_opened:
    - campaign_id
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
    Which observed events map to push_sent, push_opened? Are the required signals
    source-verified, and do live PostHog event/property reads show
    real traffic for them?
  - >-
    Which live properties provide push_sent.campaign_id,
    push_opened.campaign_id, and which stable user or account identifier joins
    the signals?
related:
  - onboarding-email-funnel
  - signup-funnel
  - app-version-distribution
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
featured: false
example_only: true
```

</details>

## Why this matters

Push marketing platforms (Braze, OneSignal, Iterable, Customer.io) grade themselves by **send rate**. They'll tell you they sent 1.2M notifications. Their dashboard shows "98% delivery rate." Nobody opened those notifications and nobody acted on them after opening.

The metrics that matter for push are:

1. **Sent → Opened**: measures delivery-to-open behavior for this product and campaign.
2. **Opened → In-app action**: measures whether the destination matches the notification promise.
3. **In-app action → conversion goal**: measures the predefined product outcome with its own denominator.

Stitching these together means joining three event streams (the provider's webhook + your app's events + your conversion events). Agentry's funnel workflow does it in one prompt because everything lives in the same event table.

## What you get

- A funnel: push_sent → push_opened → next_action with absolute counts and conversion %
- Per-campaign breakdown so you can rank the campaigns by real impact (not just send count)
- A protected metric report for the lifecycle marketing team; publish a browser-safe version later only after the user asks and a real query blueprint backs it

## Walk through it

**You:**
> Build a funnel: push_sent → push_opened → next_action. Per-campaign breakdown over the last 30 days.

**Agent:**
> Aggregate funnel first, then a per-campaign cut.

```text
Endpoint: POST /v1/projects/:project_id/query-blueprints/:blueprint_id/run
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fquery-blueprints%2F%7Bblueprint_id%7D%2Frun&method=post
Blueprint: funnel_3_step
Fetch GET /v1/query-blueprints/funnel_3_step for the allowed params before running it.
Concept fields:
  params: {
    step1: "push_sent",
    step2: "push_opened",
    step3: "in_app_action",
    days: 30
  }
```
```text
{
  "overall": {
    "push_sent":       1242000,
    "push_opened":       42180,
    "in_app_action":     16842
  },
  "per_group": [
    {
      "campaign_id": "spring_sale_v3",
      "push_sent":   180000, "push_opened": 12600, "in_app_action":  6840,
      "open_rate": 0.070, "action_rate": 0.543
    },
    {
      "campaign_id": "abandoned_cart_24h",
      "push_sent":   42000, "push_opened":  3780, "in_app_action":  2520,
      "open_rate": 0.090, "action_rate": 0.667
    },
    {
      "campaign_id": "weekly_digest",
      "push_sent":  640000, "push_opened": 12800, "in_app_action":  3200,
      "open_rate": 0.020, "action_rate": 0.250
    },
    {
      "campaign_id": "re_engagement_30d",
      "push_sent":  280000, "push_opened":  8400, "in_app_action":  2100,
      "open_rate": 0.030, "action_rate": 0.250
    }
  ]
}
```

**Agent:**
> Here's the picture:
>
> | Campaign | Sent | Open % | Action % | True conversion |
> |---|---|---|---|---|
> | `abandoned_cart_24h` | 42k | **9.0%** | **66.7%** | 6.0% |
> | `spring_sale_v3` | 180k | **7.0%** | **54.3%** | 3.8% |
> | `re_engagement_30d` | 280k | 3.0% | 25.0% | 0.75% |
> | `weekly_digest` | 640k | 2.0% | 25.0% | 0.50% |
>
> The pattern is unmistakable:
>
> - **`weekly_digest` is your worst-performing campaign by every metric** but accounts for >50% of your send volume. You're training users to ignore push.
> - **`abandoned_cart_24h` is your hero**: 9% open rate, 67% action rate — 12× more effective per send than the digest. Send more of these (within reason — increase the trigger criteria, not the frequency per user).
> - **`spring_sale_v3` is good** — keep the format for future promo pushes.
>
> Recommendation: cut `weekly_digest` send frequency from daily to weekly. The aggregate sent volume drops 80% but conversions only drop ~50% (because most of those sends weren't converting anyway). And critically, you stop training users that "this app's notifications aren't worth opening."
>
> Let me publish.

```text
Endpoint: POST /v1/projects/:project_id/public-queries
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fpublic-queries&method=post
Blueprint: funnel_3_step
Publish only real query-blueprint results; use Agentry's returned `public_url`.
Concept fields:
  blueprint_id: "funnel_3_step",
  description: "Push notification funnel (30d, per campaign)",
  params: { step1: "push_sent", step2: "push_opened", step3: "in_app_action", days: 30 }
```
```text
{ "id": "<publication_id>", "public_url": "https://api.agentry.sh/v1/public/q/<publication_id>" }
```

## The output

```
Push notification funnel (30d)

CAMPAIGN              SENT      OPEN %   ACTION %   END CONV   $/SEND
─────────────────────────────────────────────────────────────────────
abandoned_cart_24h    42,000     9.0%     66.7%      6.00%     $1.42 ★★★
spring_sale_v3       180,000     7.0%     54.3%      3.80%     $0.91 ★★
re_engagement_30d    280,000     3.0%     25.0%      0.75%     $0.18
weekly_digest        640,000     2.0%     25.0%      0.50%     $0.12 ★ training users to ignore

Total sent:        1,242,000
Total opened:         42,180  (3.4%)
Total in-app:         16,842  (1.4%)

Top recommendations:
  1. Cut weekly_digest from daily to weekly (-80% volume, -50% conv)
  2. Trigger more abandoned_cart_24h (highest ROI per send)
  3. A/B test re_engagement_30d copy — open rate is at app-floor

Public view:
  Use Agentry's returned public_url after publishing a real query blueprint.
```

## Setting it up

The trick is making sure `distinct_id` matches across the three event types.

**1. Capture `push_sent` from the verified provider webhook through the
customer's existing official PostHog server SDK:**

```ts
// Cloudflare Worker / Lambda that receives the provider's webhook
export default {
  async fetch(req: Request, env: Env) {
    const event = await req.json();  // provider's payload
    posthog.capture({
      distinctId: resolveInternalUserId(event.user_id),
      event: "push_sent",
      properties: {
        campaign_id: event.campaign,
        message_id: event.id,
        template: event.template,
      },
    });
    return new Response("ok");
  },
};
```

**2. Mobile app fires `push_opened` with the matching `campaign_id`.** Most push payloads include a `data: { campaign_id }` block — forward it:

Use the installed official PostHog mobile SDK in the notification-tap handler
to capture `push_opened` with the reviewed `campaign_id` and `message_id`, then
continue the existing deep-link behavior. Do not invent a cross-platform helper
or let telemetry alter navigation.

**3. Fire `in_app_action` on the next meaningful event.** This is usually a page view, product view, or purchase — whatever the campaign is steering toward.

Use the official PostHog mobile SDK for `push_opened` and the source-proven
in-app outcome. Run `agentry onboard` to verify the identity join and avoid
counting provider retries as separate sends.

## Variations

- *"Same funnel, but per platform — does iOS open rate beat Android?"*
- *"Just the abandoned_cart_24h campaign: open rate by hour of day. Is timing the lever?"*
- *"Per-campaign refund rate of resulting purchases — are 'free trial' pushes driving low-quality conversions that refund?"*
- *"Compare push opens vs email opens for the same campaign — when both arrive, which wins?"*
