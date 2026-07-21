# Agentry Cloud pricing

Agentry does not sell event storage or bundled inference. Product analytics and
errors remain in the customer's PostHog Cloud project, and repository work runs
in the customer's coding-agent environment.

| Plan | Price | Included | Intended use |
| --- | ---: | --- | --- |
| Open source | $0 | CLI onboarding, source/telemetry audit, manual closed-loop workflows, and a self-hostable control plane | Trying Agentry on a real repository or operating the infrastructure yourself |
| Nerve | $19/month per account | Hosted continuous read-only PostHog connections for the account's projects, error and analytics schedules, deploy correlation, bounded evidence, approvals, leases, budgets, kill switches, and receipts | A small team operating its production apps with its own agent runners |

The initial paid contract is intentionally one-dimensional and account-wide.
There is no per-project entitlement, event allowance, retention tier, seat
count, or per-PR inference charge. A future team
plan should add organization controls and higher automation concurrency only
after real usage proves those are valuable; it should not repackage PostHog
storage or customer-paid inference.

The live checkout response is authoritative for taxes, billing interval, and
any later price change. An authenticated owner creates checkout through
`POST /v1/billing/checkout`.

Questions: harju [at] agentry.sh.
