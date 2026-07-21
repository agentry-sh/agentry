# Self-hosting Agentry

The Agentry public core is available under Apache License 2.0 and can be
inspected, modified, and deployed. The current repository does **not** yet claim
a polished, one-command, production-supported self-hosted distribution.

The hosted deployment currently depends on:

- Cloudflare Workers for the API and redirect worker;
- Turso/libSQL for operational project data;
- each customer's own PostHog Cloud project, connected through read-only OAuth;
- Stripe for paid-plan checkout and billing lifecycle.

The source, schemas, migrations, and deployment configuration are included so
engineers can review the real boundaries. A compatible deployment hosts only
the Agentry control plane; it does not host or provision PostHog. It requires an
HTTPS PostHog OAuth client/callback, encrypted token storage, the operational
database, billing integration, and the same credential and tenant-isolation
invariants as Agentry Cloud. PostHog is the only interactive sign-in and project
consent surface; a compatible deployment must not introduce a separate account
or identity-provider path.

Before calling a deployment production-ready, prove at least:

1. project membership and PostHog OAuth tenant isolation;
2. OAuth token, CI, runner, and owner credential separation;
3. bounded payloads, rate limits, redaction, and secret rejection;
4. webhook signature and replay handling;
5. durable database migrations and backup/restore behavior;
6. customer telemetry and source maps bypass Agentry and go directly to PostHog; and
7. the one-flow PostHog sign-in/authorization claim, invitation, billing,
   onboarding, and deletion lifecycles.

Contributions that make self-hosting reproducible without weakening the hosted
security contract are welcome. Start with an issue describing the target
topology and which external services it replaces.
