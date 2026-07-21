# `@agentrysh/cli`

The Agentry CLI is the local, secret-safe actuator for agent-driven onboarding.
It signs in through one read-only PostHog Cloud authorization, connects the
selected project, and exposes the server-owned onboarding state as stable
checkpoints. There is no separate Agentry account or second consent step.

```sh
npx @agentrysh/cli login
npx @agentrysh/cli status
npx @agentrysh/cli connect posthog
npx @agentrysh/cli onboard
```

`onboard` is the combined flow: it discovers or confirms the PostHog region,
resumes PostHog sign-in when needed, resolves the Agentry project, claims or
resumes project-scoped PostHog OAuth, and then
returns the server's next source-review, approval, proof,
or verification checkpoint.

When the account has no project, interactive onboarding offers to create one
using the repository directory name. Non-interactive callers make that effect
explicit:

```sh
agentry onboard --json --create-project "acme-web"
```

Creation uses a durable Idempotency-Key saved outside the repository before the
request. An ambiguous retry reuses that exact key, and the selected project ID
is persisted in the CLI credential file. Creation sends only the explicitly
confirmed project name; the selected project ID remains in secure CLI state
rather than uploading an absolute filesystem path.

Agents should add `--json`; JSON mode is always non-interactive
(`--non-interactive` remains an accepted explicit assertion). Every invocation
then returns one `agentry.cli.v1` envelope and never prompts. An
`action_required` envelope is a successful checkpoint, not an invented
continuation: perform its exact action and rerun the listed command.

## Checkpoint actuation

The coding agent supplies one bounded JSON object without constructing an
authenticated HTTP request. Use either stdin or an absolute file path that
resolves outside the repository:

```sh
agentry onboard --json --checkpoint-stdin < ~/.agentry/onboarding-start.json
agentry onboard --json --checkpoint-file /absolute/outside/repo/review.json
```

The CLI reads current state first, selects only its exact operation, attaches
the current strong ETag, validates the response state and response ETag, and
then consumes the action options from the returned resume command.

| Current state | Explicit input | CLI operation |
| --- | --- | --- |
| no state | `{ "intent": "start", "plan": { ... } }` | `POST .../onboarding` without `If-Match` |
| `planned` | `{ "decision": "approve", "plan_sha256": "..." }` plus `--approve-plan <same-sha256>` | `POST .../onboarding/review` with current `If-Match` |
| `planned` | `{ "decision": "replace", "plan_sha256": "...", "replacement_plan": { ... } }` | `POST .../onboarding/review` with current `If-Match` |
| `approved` | `{ "implementation_source_snapshot": { ... } }` | `POST .../onboarding/proof` with current `If-Match` |
| `proving` | `--verify`, with no payload | bodyless `POST .../onboarding/verify` with current `If-Match` |

Start and review input is limited to 512 KiB; proof input is limited to 4 KiB.
Input must be exactly one JSON object. A file inside the repository, a relative
path, multiple input sources, a payload-driven verify, or an approval without
the exact `--approve-plan` confirmation fails before mutation.

`--approve-plan` is an explicit actuator gate, not evidence that a human
approved the plan. The caller must show the full plan and hash to the human
before adding it. The CLI never infers approval, deploys, exercises product
paths, or verifies automatically. A stale ETag is returned once as structured
recovery; the CLI does not replay an onboarding decision.

Every checkpoint has one stable `kind`: `agent_task` for work the active coding
agent can perform, `human_checkpoint` for PostHog sign-in/OAuth consent,
or a decision, `external_action` for deployment or another provider action
outside current authority, and `complete` when onboarding has a
`source_verified` receipt. Other completed utility commands may have no
checkpoint.

Credentials are stored at `~/.agentry/credentials.json` with mode `0600` (and
the containing directory with mode `0700`). `AGENTRY_PRIVATE_API_KEY` takes
precedence when present. The interactive CLI starts an ephemeral exact
`127.0.0.1` callback, opens PostHog, receives one one-time ticket, and redeems
it with a locally held verifier. Poll tokens, tickets, and verifiers are never
persisted or printed. The one-time authorization ID is saved only until its
project claim. PostHog access and refresh tokens never cross the CLI boundary.

With no owner key, `agentry login` performs the canonical bootstrap operations
automatically:

- `POST /v1/auth/posthog` with the region, CLI attribution, exact loopback URL,
  and verifier challenge;
- browser consent followed by a 303 to that exact loopback URL;
- `POST /v1/auth/posthog/poll` with the opaque poll token, one-time ticket, and
  local verifier.

Successful redemption returns the `agentry_sk_` owner key and one-time
`authorization_id`; it does not return either PostHog token.

The loopback address belongs to whatever computer is running the CLI; no
Agentry server is installed on `localhost`. It works on third-party computers
when the browser and CLI run on the same machine. In `--json` mode the CLI does
not open a browser: it returns a human checkpoint asking the user to run
`agentry login` interactively once, then resume the JSON command.

The PostHog connection contract intentionally assumes one canonical resource:

- `GET /v1/projects/:project_id/posthog-connection`
- `POST /v1/projects/:project_id/posthog-connection`
  - `{ "intent": "claim", "authorization_id": "..." }` after first sign-in
  - `{ "intent": "connect", "region": "us" | "eu", "posthog_project_id"?: number }`

Its durable states are `detached`, `active`, and `reauth_required`. PostHog's
project-scoped consent screen is the only project selector; the optional id is
an assertion, not a second selection flow. Browser authorization is represented
by a transient `authorization_url`; no PostHog credential crosses the CLI
boundary.
