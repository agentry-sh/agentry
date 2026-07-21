# Measure seller activation from profile to first sale

Run a verified three-step supply-side funnel and separate measured seller progression
from unproven assumptions about listing friction or marketplace demand.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Measure seller activation from profile to first sale
description: >-
  Run a verified three-step supply-side funnel and separate measured seller
  progression from unproven assumptions about listing friction or marketplace
  demand.
category: growth
tags:
  - analytics
  - funnels
  - marketplace
  - supply-side
  - activation
prompt: >-
  Measure seller-profile-completed → listing-published → first-sale for the last
  60 days. Verify three distinct ordered events and seller identity, run
  funnel_3_step, calculate drop-offs, and keep listing-friction and demand
  explanations as hypotheses.
difficulty: intermediate
time_to_value: 10 minutes
prereqs:
  - The marketplace has distinct seller and buyer identities
  - >-
    Profile, published-listing, and first-sale events share a stable seller
    identity
applies_to:
  - marketplace
requires_two_sided: true
required_events:
  - seller_profile_completed
  - listing_published
  - seller_first_sale
readiness_events:
  - seller_profile_completed
  - listing_published
  - seller_first_sale
required_event_properties:
  listing_published:
    - seller_id
  seller_first_sale:
    - seller_id
negative_fit:
  - >-
    Do not recommend this when the product has no distinct supply and demand
    sides with stable identities.
  - >-
    Do not substitute listing drafts for published supply or payment attempts
    for a confirmed first sale.
  - >-
    Do not infer listing friction, seller intent, or demand quality from funnel
    counts alone.
ask_if_missing:
  - >-
    Which observed events represent completed seller profile, published listing,
    and trusted first sale in order?
  - >-
    Which stable seller ID joins all three events, and what 60-day cohort or
    lookback definition is intended?
  - >-
    Which separate evidence would distinguish seller-side friction from
    insufficient buyer demand?
related:
  - marketplace-search-zero-results
  - liquidity-dashboard
  - signup-funnel
execution_mode: on_demand
required_resources:
  - signal_map
  - onboarding_state
  - query_blueprints
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
example_only: false
featured: false
```

</details>

## Why this matters

Marketplaces need sellers to publish usable supply and reach a first successful
transaction. A seller-signup count hides whether the product loses supply at
profile completion, listing publication, or the path to a first sale.

The ordered funnel locates measured loss. It cannot determine whether the cause
is onboarding friction, inventory quality, price, moderation, or buyer demand.

## What you get

- Three verified seller lifecycle events
- Ordered seller counts and conversion for the selected lookback
- Clear distinction between published supply and draft activity
- Follow-up questions for seller experience and marketplace demand

## Walk through it

**You:**
> Where do sellers stop before their first successful sale?

**Agent:**
> I will map the actual seller events and confirm that first sale comes from the
> trusted transaction path.

```http
GET /v1/projects/:project_id/signal-map
GET /v1/projects/:project_id/onboarding
# Require source-verified signals; use live PostHog reads for current evidence.
GET /v1/projects/:project_id/event-names
GET /v1/query-blueprints/funnel_3_step
```

```json
{
  "server_emitted": [],
  "analytics_events": [
    { "event": "seller_profile_saved", "count": 5240, "last_seen": 1783651200 },
    { "event": "listing_published", "count": 1840, "last_seen": 1783651210 },
    { "event": "listing_first_sale", "count": 420, "last_seen": 1783651250 }
  ],
  "wildcards": []
}
```

```http
POST /v1/projects/:project_id/query-blueprints/funnel_3_step/run
```

```text
Params:
  step1: seller_profile_saved
  step2: listing_published
  step3: listing_first_sale
  days: 60
```

```json
{
  "rows": [
    { "step1_count": 5240, "step2_count": 1840, "step3_count": 420 }
  ]
}
```

The measured conversions are 35.1% profile-to-published-listing, 22.8%
published-listing-to-first-sale, and 8.0% overall from the selected entry step.
The query does not return seller signup counts or time-to-next-step.

## The output

```text
Seller activation funnel — last 60 days

seller_profile_saved   5,240  100.0%
listing_published      1,840   35.1%  drop: 64.9%
listing_first_sale       420    8.0%  step conversion: 22.8%

What the data establishes
- measured progression through the three verified events

What remains a hypothesis
- listing-creation friction
- moderation or inventory quality
- insufficient buyer demand or pricing mismatch
```

## Setting it up

Capture profile and listing events through the official PostHog server SDK at
the source path that durably confirms each transition. Capture first sale only
after the payment/order system confirms it. Carry a stable pseudonymous seller
ID and avoid copying listing descriptions, addresses, payment details, or buyer
identities into analytics.

Verify the real seller flow and transaction outcome during installation; do not
use synthetic transport checks as proof that the funnel is answerable.

## Variations

- *"Segment the funnel by a verified listing category or seller acquisition source."*
- *"Compare marketplace regions without exposing individual sellers."*
- *"Run a separate buyer-demand analysis for published listings with no sale."*
- *"Explain which missing signal prevents first-sale attribution."*
