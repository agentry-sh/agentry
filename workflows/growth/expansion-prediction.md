# What behaviors predict an account will upgrade?

Compare upgraders vs flat users from last quarter. Find the pre-upgrade behaviors that
most strongly predict expansion.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: What behaviors predict an account will upgrade?
description: >-
  Compare upgraders vs flat users from last quarter. Find the pre-upgrade
  behaviors that most strongly predict expansion.
category: growth
tags:
  - analytics
  - expansion
  - cohorts
  - growth-loop
  - b2b
  - saas
prompt: >-
  Compare users who upgraded last quarter vs users who stayed flat. What
  pre-upgrade behaviors are highest signal?
difficulty: advanced
time_to_value: 10 minutes
prereqs:
  - >-
    Events for `plan_changed` (upgrade direction) and `account_id` on every
    event
  - At least one quarter of data with clean upgrade signal
applies_to:
  - b2b-saas
  - b2c-saas
  - devtools-api
requires_revenue: true
required_events:
  - subscription_upgraded
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
  - >-
    Do not recommend this for products without a real revenue lifecycle or an
    equivalent paid-account signal.
ask_if_missing:
  - >-
    Which observed events map to subscription_upgraded? Are the required signals
    source-verified, and do live PostHog event/property reads show
    real traffic for them?
related:
  - activation-moment
  - account-health-score
  - api-usage-as-upsell-signal
updatedAt: 2026-07-20T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
```

</details>

## Why this matters

Every PLG team wants the inverse of activation: "what behaviors predict an account will UPGRADE?" The activation-moment workflow asks "what makes them stick;" this asks "what makes them spend more."

The mechanics are similar. Define two analytic populations (upgraders vs
flat-stayers from last quarter), compute behavior in an equal pre-outcome
window, and find events with the largest observed lift in the upgrader group.
The result is an association leaderboard, not a causal model or a list of
people to contact.

The agent can compare a bounded set of observed PostHog events without creating
or changing a PostHog cohort. It must still control for sample size, window
selection, account identity, and obvious segment differences before proposing
an experiment.

## What you get

- A bounded list of events ranked by observed **upgrade-lift score**
  (P(event | upgraded) / P(event | flat))
- Population sizes and support counts for the highest-lift associations
- A reviewed experiment hypothesis, with confounding and holdout-validation
  requirements

## Walk through it

**You:**
> Compare users who upgraded last quarter vs users who stayed flat. What pre-upgrade behaviors are highest signal?

**Agent:**
> I will first verify the approved signal map and live property evidence. Then I
> will define upgraders and flat-stayers inside one bounded PostHog read; this
> does not create or mutate a PostHog cohort.

```http
GET /v1/projects/:project_id/signal-map
GET /v1/projects/:project_id/onboarding
GET /v1/projects/:project_id/event-property-keys?events=plan_changed,subscription_started
```

If the upgrade boundary or join properties are only `historically_observed`,
stop and name the source, deploy, property, or traffic proof still needed. Do
not treat matching historical rows as proof that current billing code owns the
event.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Query plan:
  - bind the exact 90-day outcome window and stable account identifier
  - define upgraders by the source-verified upward plan transition
  - define paid flat-stayers with no upward transition in the same window
  - count accounts performing each observed event in equal 30-day comparison windows
  - calculate both denominators from the query; never hard-code sample counts
  - exclude outcome events, exceptions, sparse rows, and post-upgrade behavior
  - return at most 20 aggregate event rows with both population sizes
```
```text
{
  "rows": [
    { "event": "api_key_rotated",            "upgrader_n": 28, "flat_n": 18,  "upgrade_lift": 7.7 },
    { "event": "webhook_created",            "upgrader_n": 41, "flat_n": 42,  "upgrade_lift": 4.8 },
    { "event": "team_member_invited",        "upgrader_n": 52, "flat_n": 78,  "upgrade_lift": 3.3 },
    { "event": "report_exported",            "upgrader_n": 38, "flat_n": 88,  "upgrade_lift": 2.1 },
    { "event": "integration_slack_connected","upgrader_n": 32, "flat_n": 88,  "upgrade_lift": 1.8 },
    { "event": "dashboard_view",             "upgrader_n": 64, "flat_n": 318, "upgrade_lift": 1.0 }
  ]
}
```

**Agent:**
> In this bounded historical window, accounts that rotated an API key before
> the outcome were represented 7.7x more often among upgraders than among the
> selected flat comparison population. That is an association, not proof that
> key rotation causes an upgrade or that a current account will upgrade.
>
> Other associations to validate:
> - `webhook_created` (4.8x) — may proxy for operational adoption
> - `team_member_invited` (3.3x) — may proxy for collaboration or account size
>
> Before changing onboarding, freeze the hypothesis and test a reviewed nudge
> on a later holdout population. Check plan mix, account size, tenure, and
> release changes as plausible confounders.

## The output

```
Upgrade Lift Analysis (last 90d)

EVENT                          UPGRADER  FLAT   LIFT
api_key_rotated                     28    18   7.7x   ★ surprising winner
webhook_created                     41    42   4.8x   ★ operationalizing
team_member_invited                 52    78   3.3x
report_exported                     38    88   2.1x
integration_slack_connected         32    88   1.8x
dashboard_view (baseline)           64   318   1.0x

INTERPRETATION:
  API-key rotation is associated with upgrade in this selected window.
  It may proxy for account maturity, production use, or plan mix.

REVIEWED EXPERIMENT CANDIDATES:
  1. Test a production checklist after first api_key_rotated
  2. Test whether webhook guidance helps accounts complete a verified value event
  3. Test making team-invite easier to discover

CAVEATS:
  - n=64 upgraders is small. Re-run quarterly as the cohort grows.
  - Lift != causation. Could be that mature teams do BOTH "rotate keys"
    AND "upgrade" naturally. Treat as signal, not proof.
  - Validate a frozen rule on a later holdout window before operational use.
```

## Setting it up

If you already have the source-verified account-identity pattern described in
`account-health-score` / `tier-downgrade`, the workflow can define both analytic
populations inside the read. It joins `plan_changed` events back to the bounded
per-account event history without creating a PostHog cohort.

If you don't yet have `plan_changed` with rank metadata:

```ts
// In your Stripe webhook for `customer.subscription.updated`:
const PLAN_RANK: Record<string, number> = {
  free: 0, starter: 1, pro: 2, scale: 3, enterprise: 4,
};

posthog.capture({
  distinctId: subscription.metadata.account_id,
  event: "plan_changed",
  properties: {
    account_id: subscription.metadata.account_id,
    from_plan: oldPlanName,
    to_plan: newPlanName,
    from_plan_rank: PLAN_RANK[oldPlanName],
    to_plan_rank: PLAN_RANK[newPlanName],
  },
});
```

This is an illustrative initialized official PostHog Node client. Run
`agentry onboard` to prove the billing-webhook boundary and preserve any
correct existing plan taxonomy.

The 90-day default window is reasonable for SaaS; if your sales cycle is shorter (PLG with weekly upgrades), drop it to 30d for faster signal.

## Variations

- *"Same analysis but for SELF-SERVE upgrades only. Sales-led deals confound the signal."*
- *"For the highest-lift associated event (`api_key_rotated`), show when users first do it relative to signup."*
- *"Build the inverse — what behaviors predict DOWNGRADE? Should I worry about cohorts doing X?"*
- *"Compare upgrade-lift across plan tiers — different signal for free→starter vs pro→scale?"*
