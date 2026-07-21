# Workflows — author and agent guide

Read this before editing Markdown below `workflows/`. These pages are adaptable
examples, not executable recipes or a second API contract. For page structure,
metadata rules, and validation commands, also read
[`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Product boundary

The customer's application sends analytics and exceptions directly to its own
PostHog Cloud project through official PostHog SDKs. Client source maps go
directly through the official PostHog CLI. Agentry connects to that project with
read-only OAuth and adds source-backed plans, bounded evidence, deploy
correlation, approvals, and automation control.

Workflow pages must never teach any of the following:

- posting application telemetry to an Agentry runtime endpoint;
- an Agentry browser, mobile, or application-server telemetry credential;
- Agentry-hosted PostHog or PostHog project provisioning;
- a provider-neutral analytics or error SDK that does not exist;
- source-map upload through Agentry or use of an Agentry deploy credential as a
  PostHog credential;
- copying a PostHog OAuth token into code, a prompt, CI, or a runner.

Agentry reads the connected customer project through OAuth. Disconnecting
detaches or revokes that read connection; it never mutates or deletes PostHog
data.

## Instrumentation examples

Prefer `agentry onboard` for setup. It inspects the repository's installed
official PostHog SDK, compares current source with PostHog taxonomy and history,
and proposes the exact source-backed change for human approval.

If a page benefits from code, use syntax for the specific official PostHog SDK
already named by the example. Do not invent a generic cross-language helper.
For example, browser JavaScript may illustrate an already-initialized client:

```ts
posthog.capture("signup_completed", {
  plan: currentUser.plan,
});
```

An illustrative Node.js server example may use the official Node client shape:

```ts
posthog.capture({
  distinctId: account.id,
  event: "subscription_started",
  properties: { plan: account.plan },
});
```

For exceptions, prefer the installed SDK's official exception-capture or
framework integration and describe the properties it must attach. SDK method
signatures vary by language and version, so do not fabricate a universal
`captureException` call. Never hand-roll a raw PostHog HTTP request merely to
make a workflow example look concrete.

Every event example must preserve these semantic rules:

- capture a milestone only after the source-proven outcome succeeds;
- capture an exception at the owning failure boundary;
- use stable, privacy-reviewed join identifiers;
- include only properties needed to join, measure, or segment the question;
- preserve correct existing telemetry rather than duplicating it;
- keep secrets, raw headers, cookies, URL queries/fragments, and unnecessary
  personal data out of telemetry.

## Evidence language

Never collapse these two claims:

- `historically_observed`: bounded PostHog history contains matching evidence;
- `source_verified`: approved current source owns the exact signal boundary,
  required properties are present, deployed identity is known, and any changed
  telemetry has been observed through the shipped path.

A historical event does not prove current source placement. A code patch does
not prove production behavior before deployment and observation. Workflow
output must name the level reached and the exact missing source, deploy, traffic,
or property evidence.

## Agentry control-plane operations

The Agentry HTTP API is used for owner/agent reads, source-backed onboarding,
deploy evidence, cases, approvals, and automation control. Use concrete routes
or stable OpenAPI operation IDs in conversation mockups; do not invent tool-like
names.

Common operations include:

- `GET /` and `GET /v1/openapi.json`
- `POST /v1/auth/posthog` and `POST /v1/auth/posthog/poll` for the single
  PostHog sign-in/read-only consent handoff
- PostHog authorization claim, reauthorization, status, and detach operations
  from the filtered connection flow in OpenAPI
- `GET /v1/projects/:project_id/cases` and
  `GET /v1/cases/:case_id`
- `GET /v1/projects/:project_id/deploys` and trusted post-deploy evidence writes
- `POST /v1/projects/:project_id/analytics/query`
- `GET /v1/query-blueprints` and blueprint execution routes
- onboarding and signal-map routes from
  `GET /v1/openapi.json?flow=onboarding`
- automation routes from `GET /v1/openapi.json?flow=automation`

Fetch the filtered live OpenAPI document when a workflow needs an exact request
or response shape. Do not reconstruct one from older prose.

## Credential boundaries

Only these Agentry credentials belong in workflow guidance:

| Credential | Boundary |
| --- | --- |
| `AGENTRY_PRIVATE_API_KEY` (`agentry_sk_…`) | Interactive owner/member or coding-agent management access; stored outside the repository. |
| `AGENTRY_CI_API_KEY` (`agentry_ci_…`) | Agentry deploy evidence and provider-observed PR proof after provider success. |
| `AGENTRY_RUNNER_API_KEY` (`agentry_runner_…`) | Exactly one enabled automation in one customer scheduler. |

The OAuth access and refresh tokens are encrypted in the hosted control plane
and never exposed to the CLI, coding agent, application, CI, or runner. Customer PostHog
SDK and CLI credentials remain in the customer's existing secret boundaries.
Never put the owner key in an application, routine CI job, or unattended
scheduler.

Deploy evidence is emitted only from the real post-deploy/provider success
boundary. Do not emit it from application startup, request handlers, browser
code, or cron routes. PostHog source-map upload remains a separate direct
customer-to-PostHog operation.

## CLI and chat onboarding

`agentry onboard` is the interactive interface. `agentry onboard --json` is the
agent/chat interface over the same state machine. JSON checkpoint kinds are
exactly:

- `agent_task`
- `human_checkpoint`
- `external_action`
- `complete`

The human consents to PostHog OAuth, approves the exact source-backed plan hash,
and explicitly enables unattended automation. The agent may inspect source and
perform an approved telemetry diff. Deployment and real traffic remain external
actions when they exceed current authority.

Detect the agent harness, scheduler, and secret store when possible. Show what
was found and one exact proposal. Detection is not authorization: require
explicit approval before creating a runner credential or installing/enabling a
scheduler.

## Install handoff

Do not end pages with connector-specific install commands. Link to
[`INSTALL.md`](../INSTALL.md) or say to run `agentry onboard`. The CLI owns
PostHog sign-in, OAuth handoff, project selection, plan hashes, ETags, resumption,
and machine-readable checkpoints.

## Workflow metadata rules

- `category` is exactly `debugging`, `growth`, or `ops`.
  - `debugging`: errors, deploy regressions, on-call investigation, source maps,
    CI flakes, and customer-issue diagnosis.
  - `growth`: funnels, activation, retention, churn, experiments, adoption, and
    expansion.
  - `ops`: human-reviewed operations, webhooks, audit, public aggregates, and
    versioned bounded automation templates.
- `tags` must include at least one of `errors`, `analytics`, or `deploys`.
- Do not add the legacy tool-list metadata to new workflows.
- `prereqs` describe required PostHog evidence or Agentry control-plane state,
  not a retired SDK or readiness artifact.
- Treat the legacy `prompt` field as the user-facing `starter_prompt` that an
  agent adapts to the approved signal map and actual event names.
- `example_only: true` means adaptable source material, not permission to use a
  fake API or blueprint ID.
- Every shown `blueprint_id` must exist in the runtime catalog. Use a bounded
  analytics query or explain that a reviewed blueprint is required otherwise.
- `negative_fit` and `ask_if_missing` are required and must stop unsupported or
  under-evidenced recommendations.

Customer-domain words such as plan, quota, pro, or billing are valid when they
describe the customer's product. Do not mechanically rewrite them as Agentry
commercial terms.

## Conversation mockup convention

Use this pattern in `## Walk through it` so the renderer can convert it to chat
bubbles:

```markdown
**You:**
> Did my last deploy break anything?

**Agent:**
> I’ll compare the trusted deploy with bounded PostHog error evidence.

```http
GET /v1/projects/:project_id/deploys?limit=3
```

```text
{ "deploys": [...] }
```

**Agent:**
> One issue first appeared after the deploy; timing alone does not prove cause.
```

Use `http` for real HTTP examples and `text` for mocked results. Do not use
`tool` or `tool-result` fences.

## Frequent mistakes

1. Sending application telemetry to Agentry instead of the customer-owned
   PostHog project.
2. Inventing a generic SDK or copying the OAuth token into application code.
3. Claiming historical evidence proves current source ownership.
4. Treating source changes as verified before deploy and real observation.
5. Uploading source maps through Agentry rather than the official PostHog CLI.
6. Giving a runner an owner or PostHog credential.
7. Asking the user to choose a runner that repository/environment discovery can
   prove.
8. Inventing an HTTP route, operation name, or blueprint instead of checking
   filtered OpenAPI.
9. Ending an example with a prescriptive connector install rather than the CLI
   handoff.

## Validation

Run the workflow-reference checks named in [`CONTRIBUTING.md`](./CONTRIBUTING.md)
and scan the whole workflow tree for retired runtime-ingest credentials and
paths. Source of truth wins in this order: root [`AGENTS.md`](../AGENTS.md),
[`PLAN.md`](../PLAN.md), [`docs/agent-product-guide.md`](../docs/agent-product-guide.md),
canonical install/operating guides, live OpenAPI, this guide, then an individual
workflow page.
