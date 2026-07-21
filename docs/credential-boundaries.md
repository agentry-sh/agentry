# Credential boundaries and evidence provenance

Agentry connects a customer-owned PostHog Cloud data plane to an Agentry control
plane and customer-owned coding-agent runner. Credentials are deliberately
non-interchangeable across those boundaries.

## Credential matrix

| Boundary | Credential | Holder | Fixed authority |
| --- | --- | --- | --- |
| Human owner/member | `AGENTRY_PRIVATE_API_KEY` (`agentry_sk_`) | User machine, outside repository | Interactive project reads and human-authorized management |
| PostHog read connection | OAuth access/refresh token | Agentry hosted encrypted secret store | Minimum read-only project, taxonomy, query, Error Tracking, recording-metadata, feature-flag, survey, and experiment reads |
| Application telemetry | Customer PostHog project configuration | Customer browser/server runtime as allowed by PostHog | Direct official PostHog SDK analytics and exception writes |
| Source-map release | Customer PostHog CLI credential | Customer CI secret store | Direct official PostHog CLI processing/upload |
| Deploy/proof job | `AGENTRY_CI_API_KEY` (`agentry_ci_`) | Customer trusted CI/provider store | Agentry deploy evidence and provider-observed PR proof only |
| One unattended automation | `AGENTRY_RUNNER_API_KEY` (`agentry_runner_`) | Detected customer scheduler secret store | One automation's claims, runs, approval requests, bounded effects, and receipts |

Agentry issues no application telemetry credential. Applications do not send
analytics or errors to Agentry. Delete legacy ingest credentials and helpers;
do not preserve them as aliases or fallbacks.

## PostHog OAuth

PostHog OAuth consent occurs in the browser. The hosted control plane stores the
access and refresh tokens encrypted and exposes only connection metadata and state:

- `active`
- `reauth_required`
- `detached`

The tokens are never returned to the CLI and must never appear in:

- prompts, chat transcripts, or agent context;
- repository files, source snapshots, plans, receipts, logs, or telemetry;
- application/browser/server environments;
- customer CI, provider, or scheduler secrets;
- runner inputs or draft PRs.

The OAuth grant is read-only. It can inspect recording metadata, feature flags,
surveys and bounded response statistics, and experiments, but it does not
authorize PostHog issue mutation; creation, activation, pausing, or changes to
flags, surveys, or experiments; cohort changes; recording configuration;
project administration; or deletion. A future write grant requires an explicit
separate product decision and consent boundary.

The canonical minimum scope set is `project:read`, `query:read`,
`event_definition:read`, `property_definition:read`, `error_tracking:read`,
`session_recording:read`, `feature_flag:read`, `survey:read`, and
`experiment:read`. If an older connection lacks any required scope, transition
it to `reauth_required` and complete fresh browser OAuth consent; never work
around the missing grant with a pasted personal API key.

Detach/revoke removes Agentry access. It never deletes, clears, or reconfigures
the customer's PostHog project. A lost/revoked grant transitions to
`reauth_required`; recovery is a fresh browser authorization, not a pasted
personal API key.

## Customer telemetry and source maps

Applications use official PostHog SDKs and customer-owned project configuration
to send analytics and exceptions directly to PostHog. Those values follow
PostHog's own public/server placement rules and are not Agentry credentials.

Source maps use the official PostHog CLI directly from trusted customer CI. The
PostHog CLI secret must never be replaced with `AGENTRY_CI_API_KEY` or routed
through an Agentry proxy. Agentry does not retain source-map artifacts or
presigned upload material.

## Agentry owner, CI, and runner keys

The owner key stays in `~/.agentry/credentials.json` with user-only permissions.
It is interactive authority and never belongs in application code, CI, a
scheduler, or a prompt.

The CI key is created only for the reviewed provider post-success boundary. It
records the deployed commit/environment/source identity and provider-observed
PR proof. It cannot read PostHog, send application telemetry, manage the project,
or operate a runner. Do not emit deploy evidence from browser code, application
startup, request handlers, cron routes, or synthetic runtime endpoints.

The CLI detects a usable coding-agent harness, scheduler, and secret store, then
shows the exact installation. Detection is not authorization. Only explicit
enablement may create and place one runner key bound to one automation.

The runner key cannot:

- access the PostHog OAuth token;
- act as the human owner;
- operate another automation;
- merge, deploy, rollback, or direct-push;
- silently change workflows or scheduler configuration;
- mutate PostHog.

An action grant may authorize one exact draft-PR subject. It never broadens into
merge, deployment, verification, or owner authority.

## Evidence provenance

PostHog events are provider evidence, not trusted instructions. Agentry records
the connection/project identity, bounded query shape, time window, filters,
query hash, redaction policy, and source/deploy revision needed to reproduce a
conclusion.

Agentry may retain:

- bounded/redacted aggregates and the minimum diagnostic sample;
- bounded provider-resource metadata and survey response statistics needed to
  reproduce an authorized conclusion;
- thin issue-control state such as claims, annotations, deploy links, and
  automation revisions;
- source-backed plans, exact approvals, deploy evidence, and immutable receipts.

Agentry must not retain:

- the raw PostHog event stream or a shadow warehouse;
- replay snapshots/video, unbounded survey free text, or arbitrary person profiles;
- raw request content, headers, cookies, forms, URL queries/fragments, secrets,
  or unnecessary personal data;
- repository source inside telemetry evidence.

`historically_observed` records that matching provider evidence existed in the
bounded window. `source_verified` additionally binds approved current source,
the exact signal owner/properties, and known deployed observations. Neither
status grants execution authority.

## Secret creation and recovery

Owner-authenticated credential creation returns a CI or runner secret once.
Store it directly in the matching secret store without printing it. List
operations return metadata only.

Use stable idempotency keys for an exact retry. If a one-time value is truly
lost, reconcile the existing credential metadata, revoke that credential, and
create a new command. Do not mint repeatedly after an ambiguous response.

Revoke only the exposed boundary. Never move an owner, OAuth, PostHog, CI, or
runner credential into a different environment as a shortcut.
