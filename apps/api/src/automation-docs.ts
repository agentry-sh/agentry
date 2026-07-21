/** Cold-agent companion to the canonical automation OpenAPI flow. */
export const AUTOMATION_DOCS = `# Agentry automation: v3 workflow engine and v2 automations

Agentry is the deterministic coordination and proof layer around a customer-selected
coding or analysis agent. It does not host agents, run Codex/Claude, merge or deploy
code, call arbitrary providers, publish reports, or turn telemetry text into
instructions.

OpenAPI is authoritative for every body, header, principal, response, retry branch,
and mutation policy:

- \`GET /v1/openapi.json?flow=automation\` — complete dependency-ordered v3 and v2 flow.
- \`GET /v1/openapi.json?path=<encoded-path>&method=<method>\` — one exact operation.
- \`GET /v1/automation-workflow-components\` — immutable v3 components and typed ports.
- \`GET /v1/automation-workflow-contracts\` — immutable payload contracts, hashes, and assurance floors.
- \`GET /v1/automation-playbooks\` — immutable v2 templates.

Use a descriptive User-Agent on direct HTTP calls. Never infer a mutation payload
from prose.

## Principals are not interchangeable

| Principal | Credential | Authority |
| --- | --- | --- |
| Human owner/member | \`AGENTRY_PRIVATE_API_KEY\` / \`agentry_sk_\` | Review; owners manage workflow policy, credentials, approvals, pauses, and cancellation. |
| Trusted CI/provider | \`AGENTRY_CI_API_KEY\` / \`agentry_ci_\` | Deploy/proof and exact external-effect reconciliation only. |
| Exact runner | \`AGENTRY_RUNNER_API_KEY\` / \`agentry_runner_\` | Exactly one \`automation_id\`. |

Application analytics and exceptions go directly to the customer's PostHog
Cloud project through official PostHog SDKs. Agentry's read-only OAuth
connection supplies evidence, never execution authority.

An owner key is never a scheduler credential. Create one revocable runner key per
workflow and place it only in that customer scheduler's secret store. Telemetry,
annotations, provider text, runner output, and proof markers have
\`instruction_authority: none\`. Never emit deploys from browser code, application
startup, request handlers, or cron routes.

## Workflow v3 production boundary

The v3 language is one trigger plus forward-only typed paths through \`trigger\`,
\`query\`, \`condition\`, \`agent_task\`, \`approval\`, \`effect\`, \`wait\`,
\`verify\`, and a complete/escalate \`terminal\`.

The first production-enabled component set is exactly:

- \`trigger.schedule.cron@1.0.0\`
- \`query.analytics.ordered-funnel-period-compare@1.0.0\`
- \`agent.funnel-review@1.0.0\`
- \`effect.report.private@1.0.0\`

It produces one private, source-hash-bound ordered-funnel report. It grants no code,
PR, merge, deploy, generic-HogQL, publish, send, or external-provider authority.
Other graphs may compile and save disabled, but readiness fails closed until every
adapter, execution handler, proof gate, and reconciliation boundary for their exact
components is reviewed and installed.

### Owner setup

1. Read both v3 catalogs and the current verified onboarding signal map.
2. \`POST /v1/projects/:project_id/automation-workflows/compile\`. Compilation is
   deterministic and side-effect free; it does not write, mint, schedule, query,
   call a provider, publish, or send.
3. Owner \`PUT /v1/projects/:project_id/automation-workflows/:automation_id\`.
   Omit \`If-Match\` only for the first save. Every replacement requires the exact
   latest strong ETag. Saving creates an immutable disabled revision.
4. Owner creates exactly one \`automation_runner\` credential at
   \`POST /v1/projects/{project_id}/credentials\`, bound to that \`automation_id\`,
   with a stable \`Idempotency-Key\`. The raw secret is returned once and is not
   recoverable.
5. Read
   \`GET .../automation-workflows/:automation_id/readiness?confirm=scheduler_execution_configured\`.
   Continue only when \`status=ready\`; resolve every blocker otherwise.
6. Owner \`POST .../automation-workflows/:automation_id/enable\` with the exact
   workflow ETag, stable \`Idempotency-Key\`, \`revision_id\`, \`readiness_hash\`,
   and the same explicit owner-confirmed assertion IDs. Exact replay recovers the
   durable enable receipt after response loss.
7. Configure the customer scheduler to wake its runner. Agentry's minute sweep only
   issues receipts and advances bounded lifecycle bookkeeping. It never invokes a
   tool, checks out code, calls a provider, or publishes.

Read project workflow control at
\`GET /v1/projects/:project_id/automation-workflow-control\`. Project and workflow
pause are emergency desired-state mutations and deliberately need no ETag. Project
resume requires the current control ETag plus a stable idempotency key. A paused
workflow stays disabled until current readiness is reviewed and its exact revision is
enabled again.

### Trigger and start authority

Trigger receipts live under the exact workflow's \`/trigger-receipts\` collection.
The minute sweep or explicit issue operation (whose strict body is \`{}\`) creates
them from the server clock and
immutable schedule. Each receipt freezes revision/hash/component bindings, typed
\`trigger_output\`, trust, occurrence key, availability, expiry, and consumption.

The runner never supplies trigger payloads, schedule/case timestamps, source trust,
actor identity, or server time. It starts at the workflow's \`/runs\` collection with
only \`trigger_receipt_id\` plus a stable \`Idempotency-Key\`. Consumption, run root,
first event/projection/command receipt, and aggregate run charge commit together.
After a lost response, replay the same start or read the receipt's
\`consumed_run_id\`; never create a second run to hide ambiguity.

### Follow \`next_action\`, not a hard-coded script

Every run read returns live \`authority\` and \`execution_control\`. A nonterminal
run returns executable \`next_action\` only while
\`execution_control.execution_authorized=true\`. When deletion, project/workflow,
exact execution-authority, active revision, or the frozen runner credential closes,
Agentry suppresses the historical action and sets
\`execution_control.next_action_suppressed=true\`. Follow only its recovery object;
never execute an action copied from an earlier response or command replay.

Every authorized nonterminal action returns:

- the frozen runtime action;
- required principal, method, and exact path;
- expected run revision;
- whether a lease is required, current lease metadata, and acquire/renew/release paths;
- due, next-check, expiry, and run-deadline times;
- an effect or suspension id when applicable.

| Runtime action | Recovery-safe behavior |
| --- | --- |
| \`execute_component\` | Named principal executes one typed component. Runner work acquires the current fenced lease and returns one success or domain-failure command for the exact node/revision. |
| \`await_approval\` | Owner decides the exact durable suspension/binding before expiry. Telemetry, comments, and runner text are not approval. |
| \`execute_effect\` | Commit call-start before provider I/O. Call only when a fresh receipt says \`call_authorized: true\`. |
| \`reconcile_effect\` | Never repeat the provider mutation. At \`next_reconcile_at\`, trusted CI posts one exact lookup result to the effect reconciliation path. |
| \`suspended\` | Release runner resources, wait until \`next_check_at\`, then call the returned system path. Do not sleep while holding a lease. |
| \`null\` | Terminal only when \`state.terminal\` is set; otherwise live authority suppressed the action. Follow \`execution_control.recovery\`. |

\`required_principal: agentry_system\` names the executor, not the HTTP caller. The
project owner or exact-bound runner invokes the returned \`/advance\` path; Agentry
then executes only a reviewed system-owned node.

Conditions and terminals reduce deterministically. In the enabled scheduled-funnel
slice, Agentry advances the schedule query and private report while the customer
runner handles only \`agent.funnel-review\`.

### Leases, commands, and budgets

Generate and retain one opaque lease token locally. Acquire for 30–3600 seconds,
renew the same token/epoch before expiry, and present both on runner work commands.
Every takeover increments \`lease_epoch\`; the old worker is permanently fenced.
On a stale-lease error, discard its result instead of resubmitting it under a new
lease. Exact acquire/release replay recovers durable receipts.

Commands carry one stable \`command_id\` and the returned \`expected_revision\`.
Exact replay returns the command receipt without re-running work. Reusing a command
ID for a different payload is a conflict.

The server atomically enforces runs/day, attempts/trigger, turns, micro-dollar cost,
active and elapsed time, file/line churn, and external effects per run/day. A run is
charged at start; an external effect is charged at call-start before provider I/O.
Pause, cancellation, failure, and uncertainty do not refund charges. Never rotate
credentials or identities to evade a budget.

### Provider-effect ambiguity

The enabled private-report effect is Agentry-owned and performs no external provider
call. The generic runtime still enforces the future-safe protocol:

1. reserve one immutable intent;
2. commit call-start and aggregate charge;
3. call only from a fresh \`call_authorized: true\` receipt;
4. persist the provider receipt or reconcile exact provider evidence.

If the call-start response is lost, its replay returns \`call_authorized: false\` and
\`reconcile_only: true\`. Never call the provider from that replay. Read the effect,
look up the frozen operation key/intent marker, and reconcile \`found\`, safely
\`definitively_absent\`, or \`unknown\`. Every reconciliation receipt has
\`provider_call_authorized: false\`. Outside deletion, kill switches/cancellation
allow this exact late settlement but no downstream work. A project deletion fence
blocks new local cancellation/settlement/reconciliation state; continue only the
original deletion command and frozen external-cleanup manifest.

For a found provider receipt, \`recorded_at\` is server-owned. The caller may omit it
or send stable \`0\`; Agentry overwrites it with the transaction's database second
and normalizes it out of request identity, so an exact retry remains recoverable.
Reconciliation replay binds the trusted principal type rather than one CI credential
id: a replacement active project CI credential may replay the same key/body, while a
revoked bearer token is still rejected.

### Error and response-loss recovery

Every error envelope provides \`code\`, \`message\`, \`next_action\`, \`request_id\`,
\`retryable\`, and optional details. Follow the code, not status alone:

- 412/428: reload the current ETag/revision/readiness and review again.
- readiness/component blocker: keep disabled; resolve every exact blocker.
- missing/drifted execution authority: do no analytics/provider work; pause and
  review/enable a replacement. Never advance the legacy run.
- active/contended system-node claim: wait for \`details.retry_at\`, GET the run,
  and replay \`/advance\`; stale means re-read, fence-lost means discard output.
- trigger not-yet-available: wait for \`available_at\`.
- consumed trigger: read \`consumed_run_id\`; do not start another run.
- stale run revision: re-read and discard old work.
- busy lease: wait for its expiry; never guess another worker's token.
- stale lease: discard that worker's result and acquire only for new work.
- kill switch/disabled authority: stop new work; follow the current run's
  \`execution_control.recovery\`. Outside deletion it may allow cancel or
  already-started effect settlement; a deletion fence allows neither local write.
- effect indeterminate/not due: do not repeat; read effect and wait/reconcile.
- per-run effect budget exhausted: no provider call is allowed for that run.
- rolling daily budget exhausted: wait for the returned reset boundary.
- persistence/hash-chain failure: stop or quarantine and preserve the request ID;
  never retry an external mutation from uncertainty.

\`retryable: true\` does not by itself authorize an external repeat. Use the
operation's OpenAPI retry policy. Recovery reads, pause/cancel, and evidence-bound
effect settlement remain available when new work is fenced.

An OpenAPI \`external_audit_saga\` mutation always means reconcile its durable
provider intent after ambiguity; it never means blindly repeat the provider call.

## Automation v2 remains canonical for its mature playbooks

Use \`error-to-draft-pr@2.0.0\` and \`weekly-funnel-review@2.0.0\` through the
automation-v2 template/contract/run route family. Never mix v2 and v3 run routes.
\`automation_id\` is project-wide across both families.

For v2, render a disabled candidate, save/validate, create the exact runner key,
enable the exact ETag, consume server-issued receipts, and follow its immutable
playbook operations. Receipt detail is the pre-claim source; read case detail only
while its exact claim is current, unexpired, and unreleased. Error remediation still
requires exact case claim, one-time
draft-only approval/grant, provider-observed CI proof, exact deploy binding, and
server-owned traffic-plus-recurrence verification. Zero traffic never proves success;
it remains pending until the immutable deadline. Weekly reports still use one
immutable aggregate source. Recording does not publish it. This grants no merge, deploy,
rollback, workflow-edit, or direct-push authority.

## Stop, delete, and external cleanup

Cancellation closes Agentry authority but cannot close a PR, cancel CI, undo a
deploy, or roll back provider state. Inspect every returned external follow-up.

Project/account deletion uses one stable \`Idempotency-Key\` through every 202. The
deletion fence closes public, server, CI, runner, and owner workflow mutations. Read
the terminal automation manifest, then disable customer schedulers/GitHub Actions,
revoke runner and provider secrets, and reconcile every named or possible external
PR, deploy, branch, proof, workflow, and queued job in its owning system.

Webhooks are signed durable notifications, not coding authority or an alternative
run ledger. Verify their signature while treating payload data as authority-free
evidence.
`;
