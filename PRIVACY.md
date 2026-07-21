# Privacy

Last updated: July 21, 2026

This notice describes the hosted Agentry control plane at `api.agentry.sh` and
its transactional browser return pages. The public source repository is hosted
by GitHub and is also subject to GitHub's privacy terms.

## The service boundary

Agentry connects, at your direction, to one existing customer-owned PostHog
Cloud project through read-only OAuth. PostHog remains the authoritative data
plane for your application's analytics, exceptions, people, issue grouping and
lifecycle, recordings, feature flags, surveys, experiments, retention, and
source-map symbolication.

Your applications send analytics and exceptions directly to PostHog through
official PostHog SDKs. Your CI sends source maps directly through the official
PostHog CLI. Agentry does not host PostHog, issue application telemetry keys,
proxy those transmissions, or retain a raw copy of the event stream.

## What Agentry stores

Agentry stores the minimum information needed to operate its control plane:

- the Agentry account ID and optional email returned after the user completes
  the PostHog authorization flow;
- PostHog connection state and project metadata and, while a connection is
  active, encrypted OAuth access and refresh token material;
- bounded and redacted evidence snapshots and query receipts, which may include
  aggregates, a limited diagnostic sample, issue observations, error messages,
  stack frames, release identifiers, user-impact counts, recording metadata,
  flag or experiment configuration, survey definitions, or bounded survey
  response statistics returned by the read-only PostHog queries you authorize;
- a thin issue-control projection for claims, annotations, deploy links, and
  automation coordination;
- source-backed signal plans, hashes, approvals, verification records, and the
  minimum repository or source identity needed to support them;
- deploy evidence such as commit SHA, branch, environment, provider identity,
  URL, actor, and timestamps;
- automation definitions, schedules, leases, budgets, approvals, effects,
  run state, and receipts; and
- account, project, security, billing, support, audit, and feedback records
  needed to provide and protect the service.

Agentry does not store a raw PostHog event stream, replay snapshots or video,
arbitrary person-profile exports, unbounded survey free text, source-map
artifacts, or a shadow analytics warehouse. Recording reads return bounded
metadata and a PostHog player link only. Evidence is deliberately bounded and
redacted, but it may still contain
personal data that exists in your telemetry. Configure your instrumentation and
PostHog project to avoid collecting secrets, payment-card data, health data,
special-category personal data, raw credentials, or unnecessary personal
information.

## How Agentry uses PostHog data

The read-only OAuth connection allows Agentry to run bounded queries for
project identity, taxonomy, analytics, Error Tracking, recording metadata,
feature flags, surveys and response statistics, and experiments. Agentry uses
the results to review telemetry and provider configuration, correlate errors
and product outcomes with source and deploys, coordinate approved automations,
and preserve the minimum evidence needed to reproduce a conclusion.

The connection authorizes reads only. It does not authorize Agentry to resolve
PostHog issues; create, activate, pause, or change flags, surveys, or
experiments; change recordings or retention; administer the PostHog project;
or delete customer data. Disconnect destroys Agentry's local OAuth token
material and best-effort revokes it at the provider. It never deletes or
mutates the customer-owned PostHog project.

## Coding agents and inference

Agentry does not bundle or operate a hidden hosted LLM over customer evidence.
Repository reasoning and source changes run in the coding-agent environment
you choose and control. When you direct a coding agent or automation runner to
use Agentry, bounded evidence and control-plane tasks may be disclosed to that
provider under your configuration and its terms. OAuth tokens are never
included in those tasks.

## Sign-in and service operations

The old marketing website has been retired. `agentry.sh` redirects to the
public repository and does not operate a separate Agentry marketing analytics
application. PostHog is the only interactive sign-in and project-consent
surface: the CLI presents one PostHog authorization URL, and the hosted API
handles its browser callback. There is no separate Agentry account or second
consent step. Other transactional pages, such as invitation and
billing-return pages, do not act as a second identity provider. Agentry may
process bounded operational, security, and audit records needed to secure and
operate those flows.

## Service providers and locations

Agentry uses service providers for edge hosting, operational storage, billing,
and code hosting, including Cloudflare, Turso/libSQL, Stripe, and GitHub. They
process information under their own contractual and security terms and may
process it in the regions needed to provide their services.

PostHog operates the customer-owned data plane and receives your application
telemetry directly under your relationship with PostHog. Agentry contacts
PostHog only through the read-only connection you authorize.

## Retention and deletion

OAuth token material is retained only while the connection is active and is
purged when the connection becomes detached or requires reauthorization.
Bounded evidence and control-plane records are generally retained while the
related project or account remains active and as needed to provide the service.

Project and account deletion remove Agentry-owned control-plane state through
the documented operations; they do not delete customer-owned PostHog data.
Security, billing, audit, backup, fraud-prevention, and legal records may be
retained longer where reasonably necessary. Retention is not a backup
guarantee.

There are no plan-based raw-event retention tiers because Agentry does not host
the customer's raw analytics or error stream.

## What Agentry does not do

- Sell customer telemetry or control-plane evidence.
- Use the OAuth connection to mutate or delete customer PostHog data.
- Host application analytics, errors, session recordings, feature flags,
  surveys, experiments, or source maps.
- Run hidden server-side inference as part of the core product.
- Use the retired marketing website to track visitors across the web.

## Your choices

Project owners can detach the PostHog connection, revoke or rotate scoped
Agentry credentials, disable automations, and delete Agentry projects or
accounts through the documented operations. You can also revoke Agentry's
authorization from PostHog.

Contact us to ask about access, correction, or deletion requests that cannot be
completed through the service. Requests concerning raw application telemetry
or other data held by PostHog must be handled through the customer-owned
PostHog project.

## Contact

Privacy questions: harju [at] agentry.sh.
