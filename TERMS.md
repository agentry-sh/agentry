# Terms of Service

Effective July 21, 2026

These terms govern the hosted Agentry control plane, including
`api.agentry.sh`, hosted authentication, billing, APIs, and related managed
infrastructure. The open-source software in this repository is licensed
separately under [Apache License 2.0](./LICENSE); these hosted-service terms do
not reduce the rights granted by that license.

By creating an account, authorizing a connection, or otherwise using Agentry
Cloud, you agree to these terms.

## 1. Who can use Agentry

You must be able to form a binding contract and comply with these terms. If you
use Agentry for a company, client, or other organization, you represent that
you have authority to bind that organization, and “you” includes it.

## 2. The service

Agentry is an agent-first control plane over a customer's existing PostHog
Cloud project. It provides read-only PostHog connection management,
source-backed telemetry review, bounded evidence, deploy attribution,
approvals, durable automation state, and draft-PR workflows for customer-owned
coding agents.

PostHog remains the customer-owned authoritative data plane for analytics,
exceptions, issue grouping and lifecycle, affected-user impact, recordings,
feature flags, surveys, experiments, retention, and source-map symbolication.
Applications and CI send telemetry and source maps directly to PostHog through
official PostHog tools. Agentry does not host PostHog, proxy application
telemetry, retain a raw event stream, or provide bundled AI inference.

Agentry is not a general-purpose security, compliance, infrastructure APM,
regulated-data, or emergency-alerting service. We do not provide SOC 2, HIPAA,
FedRAMP, PCI, or similar commitments unless a separate signed agreement says
so.

## 3. Accounts, connections, keys, and agents

You are responsible for your account, projects, OAuth authorizations,
credentials, automation settings, and actions taken with them, including
actions performed by your employees, contractors, scripts, CI jobs, coding
agents, and customer-owned runners.

The PostHog OAuth connection is read-only. It permits bounded reads of
analytics, Error Tracking, recording metadata, feature flags, surveys and
response statistics, and experiments; it permits no PostHog resource mutation.
While active, its access and refresh token material is encrypted by the hosted
control plane and is never returned to the CLI, repository, application, CI, or
runner. Detaching Agentry removes its token material and never deletes or
mutates your PostHog project.

Agentry owner, CI, and runner credentials are purpose-specific. Keep them out
of browser bundles, public repositories, logs, screenshots, prompts, and
support messages. A CI credential records deploy and provider-proof evidence
only. Each runner credential is bound to one enabled automation and cannot act
as an owner or access the PostHog OAuth token.

Draft PR is the maximum autonomous effect authorized by Agentry. Merge, direct
push, deploy, rollback, silent workflow modification, and PostHog writes remain
outside that authority. You are responsible for reviewing agent output and for
the permissions and behavior of your coding-agent and repository providers.

## 4. Customer data and provider data

“Customer Data” means account and project data, PostHog connection metadata,
bounded evidence snapshots, deploy evidence, source-backed plans and approvals,
automation state, reports, feedback, and other content you or your systems
provide to the hosted control plane. “Provider Data” means information Agentry
reads from your customer-owned PostHog project or another integration at your
direction.

You retain ownership of Customer Data and your rights in Provider Data. You
grant Agentry the limited rights needed to access, process, transmit, store,
redact, display, secure, maintain, debug, and support that information solely
to provide and protect the service. You represent that you have the rights and
authority required to connect each project and permit that processing.

Agentry stores only bounded and redacted evidence needed for the control plane;
it does not retain the raw PostHog event stream, replay snapshots/video,
unbounded survey free text, arbitrary person exports, source-map artifacts, or
a shadow analytics warehouse. Recording reads expose metadata and a PostHog
player link only.

You are responsible for the telemetry sent directly to PostHog and for the data
you make available to Agentry. Do not collect or expose secrets, private keys,
payment-card numbers, protected health information, special-category personal
data, or other regulated or highly sensitive data unless the relevant provider
and Agentry have separately agreed in writing to handle it. Minimize personal
data and redact unnecessary values at the instrumentation boundary. See
[`PRIVACY.md`](./PRIVACY.md).

## 5. Acceptable use

You may not use the hosted service to violate law, infringe rights, attack or
disrupt systems, bypass access controls, exfiltrate data, send malware or spam,
test stolen credentials, monitor people without lawful authority, access a
PostHog project you are not authorized to use, evade rate limits, or create
abusive load.

You may not resell Agentry Cloud as a standalone managed service or reverse
engineer non-public hosted components except where law permits. These
restrictions apply to the hosted service, not to rights in the Apache-licensed
source code.

## 6. Plans, billing, and taxes

Paid plans are billed through a payment processor. You authorize applicable
fees, renewals, and taxes shown at checkout. The current hosted product is
priced per Agentry account. It does not include event-storage
allowances, event overages, or hosted inference charges because telemetry
storage and coding-agent inference remain customer-owned.

The live checkout terms are authoritative for the price and billing interval.
Fees are non-refundable except where law requires or we agree otherwise in
writing. You are responsible for taxes and similar charges other than taxes on
Agentry's income. Failed payment may lead to downgrade, limits, suspension, or
termination after reasonable notice when practical.

## 7. Service limits and retention

We may enforce reasonable control-plane API rate limits, bounded PostHog query
windows and samples, automation concurrency and budget limits, payload limits
for Agentry-owned records, and abuse-prevention restrictions. These are not
quotas on your application event volume; Agentry does not receive or store that
raw event stream.

Agentry-owned evidence and control state may be retained as described in the
Privacy notice. Your PostHog project's retention is controlled by you and
PostHog, not by an Agentry plan. Neither service is a backup guarantee; keep
copies of data you need.

## 8. Third-party services

Agentry relies on third parties for infrastructure, authentication, billing,
and code hosting. PostHog operates your customer-owned telemetry data plane,
and your chosen coding-agent, scheduler, source-control, and deployment
providers operate under your accounts and configuration. Your use of those
services is governed by their terms.

Agentry is not responsible for third-party services outside its control,
including their availability, retention, model output, code changes, or use of
data. Revoking or losing a required third-party authorization may prevent the
related Agentry workflow from operating.

## 9. Availability, beta changes, and support

Agentry is an early product. We may add, remove, rename, replace, or change
hosted endpoints, fields, adapters, plans, limits, pricing, and behavior. We do
not promise uninterrupted availability, backward compatibility, or that every
workflow remains available forever.

We may suspend or limit access where use creates security, legal, operational,
billing, abuse, or reliability risk, or when law or a provider requires it.

## 10. Intellectual property and feedback

The open-source repository is governed by its licenses. The hosted service,
non-public infrastructure, Agentry names, logos, and trademarks remain owned by
Agentry or its licensors. See [`TRADEMARKS.md`](./TRADEMARKS.md).

If you send ideas, bug reports, suggestions, prompts, examples, or feedback,
you allow Agentry to use them without restriction or compensation. You retain
ownership of Customer Data. Code contributions are governed by the repository
license and contribution notice.

## 11. Confidentiality

Each party will use reasonable care to protect non-public information from the
other that is marked confidential or should reasonably be understood as
confidential, and use it only for this relationship. This does not apply to
information that is public, independently developed, lawfully received from
another source, or required to be disclosed by law.

## 12. Termination

You may stop using the service at any time. You may detach the PostHog
connection and delete Agentry-owned project or account state through the
documented operations; those actions do not delete customer-owned PostHog data.

We may suspend or terminate access for material breach, non-payment, risk,
unlawful conduct, or abuse. Provisions that by nature should survive do
survive, including payment, ownership, confidentiality, disclaimers, liability
limits, indemnity, and dispute terms.

## 13. Disclaimers

The hosted service is provided “as is” and “as available.” To the fullest
extent permitted by law, we disclaim warranties of merchantability, fitness for
a particular purpose, title, non-infringement, availability, accuracy,
security, and uninterrupted or error-free operation.

Agentry provides bounded evidence and automation controls for agents and people
to interpret. It does not guarantee that telemetry is complete, that a diagnosis
or recommendation is correct, that a draft PR fixes an issue, or that an outcome
will improve. You are responsible for code changes, deployments,
communications, compliance actions, and business decisions based on the
service.

## 14. Limitation of liability

To the fullest extent permitted by law, Agentry will not be liable for indirect,
incidental, special, consequential, exemplary, or punitive damages, lost
profits, lost revenue, lost data, business interruption, security incidents
caused by your systems, third-party model or provider output, or substitute
services. Total liability for claims relating to the hosted service will not
exceed the greater of USD 100 or the amount you paid Agentry in the 12 months
before the event giving rise to the claim.

## 15. Indemnity

You will defend, indemnify, and hold Agentry harmless from claims, losses,
liabilities, costs, and expenses arising from Customer Data, Provider Data you
make available, your use of the service, your breach of these terms, your
violation of law, or actions taken by people or systems using your credentials.

## 16. Disputes and governing law

These terms are governed by the laws of the State of California and the United
States, without regard to conflict-of-laws rules. Courts in San Francisco
County, California have exclusive jurisdiction, except either party may seek
injunctive relief in any court with jurisdiction.

## 17. Changes

We may update these terms. For material changes, we will provide reasonable
notice through repository notices, email, service messages, or another
appropriate channel. Continued use after updated terms take effect means you
accept them.

## 18. Contact

Questions: harju [at] agentry.sh.
