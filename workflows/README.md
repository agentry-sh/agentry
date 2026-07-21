# Agentry workflows

This directory contains 86 GitHub-native examples for using coding agents with error monitoring, product analytics, and deploy attribution. Each workflow is reviewable Markdown and links to the exact Agentry HTTP concepts it uses.

> [!IMPORTANT]
> Workflows are adaptation material, not executable API recipes. Before running one, verify the project's onboarding receipt, signal map, live event names, and property keys. Fetch the filtered OpenAPI operation before making a call.

## Collections

| Collection | Workflows | Focus |
| --- | ---: | --- |
| [Debugging and reliability](./debugging) | 24 | Error monitoring, deploy regressions, source maps, incidents, latency, and release health. |
| [Growth and product analytics](./growth) | 40 | Funnels, activation, adoption, conversion, retention, revenue, and experiments. |
| [Operations and recurring reviews](./operations) | 22 | Alerts, audit, account reviews, automations, webhooks, queues, and scheduled evidence. |

## Featured starting points

- [Investigate errors after the latest deploy](./debugging/deploy-regression.md) — Review cases first seen after a trusted deploy, distinguish SHA attribution from timing correlation, and inspect the highest-impact evidence before proposing a fix.
- [Investigate one customer-reported problem](./debugging/customer-investigation.md) — Review the minimum identity-linked product evidence for an authorized support case, corroborate any real error case, and prepare a reply that preserves uncertainty.
- [Measure a verified three-step signup funnel](./growth/signup-funnel.md) — Map three ordered lifecycle events to live project signals, run the canonical funnel blueprint, and explain drop-offs without inventing causes or benchmarks.
- [Review account-health evidence before outreach](./operations/account-health-score.md) — Combine verified account usage, revenue context, and support-friction signals into a review queue without pretending a universal score proves churn or intent.
- [Safely turn a production error into a draft PR](./operations/auto-fix-routine.md) — A bounded self-healing workflow that claims one trusted production case, prepares one reviewable draft PR, and waits for CI, deploy, and real-traffic verification.
- [Schedule a private weekly funnel review](./operations/weekly-funnel-review.md) — Render the bounded weekly-funnel-review template so a scoped runner records an exact-period aggregate report without raw users or mutation authority.

## Find the right workflow

Use GitHub repository search with `path:workflows` and the question or technology you care about. Examples:

```text
path:workflows deploy regression
path:workflows signup funnel
path:workflows stripe payment
path:workflows webhook reliability
```

To add or revise a workflow, read [the authoring guide](./CONTRIBUTING.md) and the scoped [agent instructions](./AGENTS.md).
