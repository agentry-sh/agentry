# Email click to first in-app action conversion

Join UTM-tagged email opens to the in-app action they were meant to drive. Grade
onboarding emails by behavior change, not click rate.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Email click to first in-app action conversion
description: >-
  Join UTM-tagged email opens to the in-app action they were meant to drive.
  Grade onboarding emails by behavior change, not click rate.
category: growth
tags:
  - analytics
  - funnels
  - email
  - onboarding
  - content-marketing
  - mixpanel-alternative
prompt: >-
  Build a funnel from onboarding email opens (UTM-tagged) to the in-app action
  they were supposed to trigger. Per-template breakdown.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - >-
    Email opens / clicks captured as analytics events with `utm_campaign` /
    `email_template`
  - In-app events for the target actions each email is supposed to drive
applies_to:
  - b2c-saas
  - b2b-saas
  - devtools-api
  - content-media
required_events:
  - email_sent
  - email_clicked
  - onboarding_step_completed
required_event_properties:
  email_sent:
    - email_template
    - utm_campaign
  email_clicked:
    - email_template
    - utm_campaign
  onboarding_step_completed:
    - step
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
    Which observed events map to email_sent, email_clicked,
    onboarding_step_completed? Are the required signals source-verified, and do
    live PostHog event/property reads show real traffic for them?
  - >-
    Which live properties provide email_sent.email_template,
    email_sent.utm_campaign, email_clicked.email_template,
    email_clicked.utm_campaign, onboarding_step_completed.step, and which stable
    user or account identifier joins the signals?
related:
  - signup-funnel
  - activation-moment
  - weekly-changelog
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
example_only: true
```

</details>

## Why this matters

Lifecycle emails are graded by open rate, click rate, maybe unsubscribe rate. The metric that actually matters — "did they do the thing the email asked?" — requires joining your ESP data to your product data and almost no team does it.

Customer.io, Loops, Resend all give you "X people clicked." None of them say "X people clicked AND THEN created their first project within 24 hours." That join needs both sides in one database.

Agentry holds both: send every email open/click as an analytics event (one fetch from your ESP webhook), and join against your in-app events using `distinct_id`. The agent ships the funnel as a per-template scorecard.

## What you get

- A per-email-template funnel: `sent → opened → clicked → in-app target action`
- Templates ranked by **action-conversion rate** (not click rate)
- Surprise findings: the email everyone opens but no one acts on, vs the low-CTR email that drives 40% of activations

## Walk through it

**You:**
> Build a funnel from onboarding email opens (UTM-tagged) to the in-app action they were supposed to trigger. Per-template breakdown.

**Agent:**
> Let me see what email events you've got and what target actions you've defined.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.email_template AS template, count() AS sent FROM events WHERE event = 'email_sent' AND timestamp >= now() - INTERVAL 30 DAY GROUP BY template ORDER BY sent DESC"
```
```text
{
  "rows": [
    { "template": "welcome_day0",       "sent": 4200 },
    { "template": "create_first_project_day1", "sent": 4180 },
    { "template": "invite_teammate_day3",      "sent": 4100 },
    { "template": "feature_overview_day5",     "sent": 4050 },
    { "template": "trial_ending_day12",        "sent": 3800 }
  ]
}
```

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "WITH sends AS (SELECT distinct_id, properties.template AS template, timestamp AS sent_at FROM events WHERE event = 'email_sent' AND timestamp >= now() - INTERVAL 30 DAY), clicks AS (SELECT distinct_id, properties.template AS template, min(timestamp) AS clicked_at FROM events WHERE event = 'email_clicked' AND timestamp >= now() - INTERVAL 30 DAY GROUP BY distinct_id, template), actions AS (SELECT distinct_id, min(timestamp) AS acted_at FROM events WHERE event IN ('signup_completed','first_project_created','team_member_invited','integration_connected','subscription_started') AND timestamp >= now() - INTERVAL 30 DAY GROUP BY distinct_id) SELECT s.template, count() AS sent, countIf(c.clicked_at >= s.sent_at) AS clicked, countIf(a.acted_at >= s.sent_at AND a.acted_at <= s.sent_at + INTERVAL 72 HOUR) AS target_action FROM sends s LEFT JOIN clicks c ON c.distinct_id = s.distinct_id AND c.template = s.template LEFT JOIN actions a ON a.distinct_id = s.distinct_id GROUP BY s.template ORDER BY sent DESC"
```
```text
{
  "templates": [
    { "name": "welcome_day0",
      "sent": 4200, "opened": 2940, "clicked": 1188, "target_action": 1080,
      "open_rate": 0.70, "ctr": 0.40, "action_rate": 0.92 },
    { "name": "create_first_project_day1",
      "sent": 4180, "opened": 2090, "clicked": 418,  "target_action": 209,
      "open_rate": 0.50, "ctr": 0.20, "action_rate": 0.50 },
    { "name": "invite_teammate_day3",
      "sent": 4100, "opened": 2050, "clicked": 615,  "target_action": 41,
      "open_rate": 0.50, "ctr": 0.30, "action_rate": 0.067 },
    { "name": "feature_overview_day5",
      "sent": 4050, "opened": 1620, "clicked": 162,  "target_action": 162,
      "open_rate": 0.40, "ctr": 0.10, "action_rate": 1.00 },
    { "name": "trial_ending_day12",
      "sent": 3800, "opened": 2660, "clicked": 1140, "target_action": 380,
      "open_rate": 0.70, "ctr": 0.30, "action_rate": 0.33 }
  ]
}
```

**Agent:**
> Two findings worth your attention:
>
> 1. **`invite_teammate_day3` is the worst.** 615 people click, only 41 actually invite anyone. The CTA is broken — likely the click sends them to the workspace home, not to the invite modal. Fix the deep link.
> 2. **`feature_overview_day5` is the surprise.** Only 10% CTR but 100% of clickers do the target action. The email is filtering out un-interested users; those who click are pre-qualified. Don't fix the CTR, leverage it.
> 3. **`trial_ending_day12`** has good open/click but only 33% conversion to subscription. Pricing or friction at checkout. Worth a separate investigation.

```text
# This email-to-action funnel is custom HogQL, not a built-in public-query
# blueprint. Keep it server-side in a protected view, or add a real query
# blueprint for this analysis before publishing a public-query URL.
```

**Agent:**
> Analysis saved in the protected handoff. The actionable list: fix `invite_teammate_day3`'s deep link first.

## The output

```
Onboarding Email Funnel (30d) — graded by ACTION, not click

TEMPLATE                     SENT   OPEN   CTR    ACTION   ACTION-RATE
welcome_day0                4,200  70%   40%   1,080         92%   ★ excellent
create_first_project_day1   4,180  50%   20%     209         50%   ok
invite_teammate_day3        4,100  50%   30%      41        6.7%  ✗ FIX
feature_overview_day5       4,050  40%   10%     162        100%  ★ pre-qualified
trial_ending_day12          3,800  70%   30%     380         33%  ✗ pricing/friction

KEY INSIGHTS:
  invite_teammate_day3 — 615 clicks → 41 invites. Deep link is broken.
                         Probably routing to workspace home instead of invite modal.
  feature_overview_day5 — 10% CTR is fine; 100% action rate means the CTA
                         self-selects. Don't optimize for opens.
  trial_ending_day12   — Click-to-paid conversion is only 33%. Friction at
                         checkout, not in the email. Investigate separately.
```

## Setting it up

You need email events flowing into the customer PostHog project, with the same
stable identity as in-app events. Most ESPs ship webhooks; capture the reviewed
provider outcomes through the application's official PostHog server SDK.

```ts
// Webhook handler — e.g. Customer.io or Resend
app.post("/webhooks/email", async (req) => {
  const evt = req.body;
  // evt.event = "sent" | "opened" | "clicked"
  posthog.capture({
    distinctId: resolveInternalUserId(evt.recipient),
    event: `email_${evt.event}`,
    properties: {
      email_template: evt.template_name,
      campaign_id: evt.campaign_id,
    },
  });
});
```

Do not copy full clicked URLs or email addresses into event properties. Run
`agentry onboard` to review webhook authentication, identity, timestamp
semantics, and the target-action boundary.

For in-app `target_action` events, you're presumably already capturing `first_project_created`, `team_member_invited`, etc. for signup-funnel. The workflow just joins both sides on `distinct_id` within the time window.

## Variations

- *"Same funnel but only for trial users on the Enterprise pricing path."*
- *"Compare onboarding email performance across two ESPs — we A/B'd Customer.io vs Loops last quarter."*
- *"For the worst-performing template, draft 3 subject-line / CTA variants based on what the winning ones do."*
- *"For each clicker who DIDN'T do the target action within 24h, send a follow-up. List them."*
