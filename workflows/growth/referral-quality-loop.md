# Measure referral quality, not just invites

Track invite sent, invite accepted, activation, and retention so product teams know
whether referrals create valuable users.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: 'Measure referral quality, not just invites'
description: >-
  Track invite sent, invite accepted, activation, and retention so product teams
  know whether referrals create valuable users.
category: growth
tags:
  - analytics
  - referrals
  - activation
  - retention
  - growth-loop
  - product
prompt: >-
  Analyze referral quality: invites sent, accepted, activated, and retained
  users by inviter cohort and channel.
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - >-
    Referral events include inviter_id, invitee_id, channel, and account_id
    where relevant
applies_to:
  - b2c-saas
  - b2b-saas
  - marketplace
  - games
required_events:
  - referral_invite_sent
  - referral_invite_accepted
  - activated
readiness_events:
  - referral_invite_accepted
required_event_properties:
  referral_invite_sent:
    - inviter_id
    - channel
  referral_invite_accepted:
    - inviter_id
    - invitee_id
  activated:
    - source
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
ask_if_missing:
  - >-
    Which observed events map to referral_invite_sent, referral_invite_accepted,
    activated? Are the required signals source-verified, and do live PostHog
    event/property reads show real traffic for them?
  - >-
    Which live properties provide referral_invite_sent.inviter_id,
    referral_invite_sent.channel, referral_invite_accepted.inviter_id,
    referral_invite_accepted.invitee_id, activated.source, and which stable user
    or account identifier joins the signals?
related:
  - power-users
  - activation-moment
  - landing-page-source-quality
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

## Why this matters

Referral programs can inflate signup volume without producing retained users. Quality matters more than invite count.

## What you get

- Invite send and acceptance rates
- Activation and retention of referred users
- Best inviter cohorts and channels
- Whether referral rewards are attracting quality users

## Walk through it

**You:**
> Are referrals bringing good users?

**Agent:**
> I'll follow referred users from invite to activation.

```text
Endpoint: POST /v1/projects/:project_id/analytics/query
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fanalytics%2Fquery&method=post
Custom HogQL goes in the OpenAPI-defined `query` field.
Concept fields:
  query: "SELECT properties.channel AS channel, countIf(event = 'referral_invite_sent') AS sent, countIf(event = 'referral_invite_accepted') AS accepted, countIf(event = 'activated') AS activated FROM events WHERE event IN ('referral_invite_sent','referral_invite_accepted','activated') AND timestamp > now() - INTERVAL 60 DAY GROUP BY channel ORDER BY accepted DESC"
```

## The output

The agent returns referral channels and inviter cohorts ranked by activation quality.

## Setting it up

Emit referral lifecycle events with stable inviter and invitee identifiers. Preserve referral source onto activation.

## Variations

- *"Show referrals by power-user cohort."*
- *"Find inviters whose referrals activate above average."*
- *"Publish referral quality by channel."*
