# Automation workflow v3: cold-agent runbook

**Status:** fail-closed production slice
**Workflow schema:** `3`
**Runtime and receipt schemas:** `1`

This is the shortest complete guide for an agent or scheduler that has no prior
Agentry context. The canonical machine contract is always:

- `GET /v1/openapi.json?flow=automation`
- `GET /v1/docs/automation`
- `GET /v1/automation-workflow-components`
- `GET /v1/automation-workflow-contracts`

Use a descriptive `User-Agent` on direct HTTP calls. Fetch the filtered OpenAPI
operation before every mutation; examples here show the sequence, not permission
to invent fields.

## What is production-enabled

Workflow v3 is a deterministic workflow engine over Agentry's error-monitoring,
analytics, and deploy evidence. A workflow is an immutable, forward-only graph of
typed nodes:

`trigger -> query -> condition -> agent_task -> approval -> effect -> wait -> verify -> terminal`

The first enabled component set is deliberately small:

| Kind | Exact component |
| --- | --- |
| Trigger | `trigger.schedule.cron@1.0.0` |
| Query | `query.analytics.ordered-funnel-period-compare@1.0.0` |
| Agent task | `agent.funnel-review@1.0.0` |
| Effect | `effect.report.private@1.0.0` |

That set supports a scheduled, ordered-funnel comparison, one customer-runner
analysis step, and one private Agentry report. The report is not published or
sent. Code changes, PRs, merge, deploy, arbitrary HogQL, and arbitrary provider
effects have zero authority in this slice.

Other component combinations may compile and save as disabled revisions. Their
readiness response remains `blocked` until every exact adapter, proof gate, and
execution handler is reviewed and installed. Never bypass readiness or send a v3
artifact to automation-v2 run routes.

## The mental model

Agentry owns coordination and proof; it does not host the model or invoke a coding
tool. The customer scheduler wakes a customer-selected runner. The runner asks
Agentry for server-issued work, follows the returned `next_action`, and reports one
typed result. Every authority-bearing fact is durable before it is returned.

There are five separate things to keep straight:

1. **Workflow revision:** immutable graph, components, schemas, principals, and
   budgets. The head has a strong `ETag`; an enabled run is pinned to one exact
   `revision_id`, `workflow_hash`, `compile_hash`, `execution_authority_id`, and
   `execution_descriptor_hash` from its reviewed enablement receipt.
2. **Trigger receipt:** server-issued occurrence and typed trigger output. A runner
   supplies only `trigger_receipt_id`; it never supplies schedule times, case facts,
   trigger payloads, actor identity, or server timestamps. The receipt pins the
   exact `execution_authority_id` that start must carry into the run.
3. **Run ledger:** immutable command/event chain plus a replay-verified projection.
   `state.revision` is the optimistic command fence.
4. **Lease:** expiring runner ownership for one run. Every takeover creates a larger
   `lease_epoch`; commands from an older epoch are rejected even if their token was
   once valid.
5. **Effect ledger:** provider-call intent and reconciliation history. A durable
   call-start is the one-way boundary after which a provider call must never be
   blindly repeated.

The project and individual workflow kill switches are live authority checks. They
can stop new starts, leases, work, and effect calls without rewriting an immutable
run. They cannot undo a provider call whose call-start already committed.

## Credentials are not interchangeable

| Principal | Environment variable | Prefix | Use |
| --- | --- | --- | --- |
| Human owner/member | `AGENTRY_PRIVATE_API_KEY` | `agentry_sk_` | Inspect; owner saves/enables/pauses, manages credentials, decides approvals, and cancels. |
| Exact runner | `AGENTRY_RUNNER_API_KEY` | `agentry_runner_` | One `automation_id`; reads receipts/runs, starts that workflow, leases runner work, and submits allowed commands. |
| Trusted CI | `AGENTRY_CI_API_KEY` | `agentry_ci_` | Provider-observed deploy/PR proof and exact external-effect reconciliation only. |
| PostHog read connection | encrypted OAuth access and refresh tokens; never exposed | none | Agentry system reads bounded analytics, Error Tracking, recording metadata, feature flags, surveys, and experiments from one customer-owned PostHog Cloud project. |
| Agentry system | none exposed | none | Server clock, trigger facts, queries, waits, verification, and private report persistence. |

First-class PostHog resources do not automatically become workflow authority.
The current production-enabled component set reads its declared funnel evidence
only. A future workflow that uses a recording, flag, survey, or experiment must
declare a typed component and bounded evidence contract before it can pass
readiness. No workflow may mutate those PostHog resources.

Never put an `agentry_sk_` owner key in a scheduler. Create exactly one active
`agentry_runner_` key for each enabled workflow, store it only in the customer
scheduler's secret store, and revoke it when that scheduler is retired. Raw project
credentials are hash-only and returned once. If credential creation's response is
lost, an exact retry identifies the existing credential but cannot reveal or mint a
replacement secret; revoke it and create a new one deliberately.

## Discovery sequence

A cold agent should do this before executing work:

1. Read `/v1/openapi.json?flow=automation` and locate the workflow-v3 production
   branch by stable `operationId`.
2. Read both component and data-contract catalogs. Confirm exact versions, hashes,
   typed ports, principals, side effects, and `instruction_authority: none`.
3. Read the current source-verified onboarding state and signal map. Funnel
   event names must be approved, source-verified, and observed in the connected
   PostHog project; telemetry text remains untrusted data.
4. Compile the graph. Compilation is read-only and does not make it runnable.
5. Save it disabled. Replacements require the latest exact strong `ETag`.
6. Create the exact-bound runner credential.
7. Read readiness with every required owner assertion. Resolve every blocker.
8. Enable only the exact `revision_id`, `ETag`, `readiness_hash`, and confirmation
   set that the owner reviewed.
9. Configure the external scheduler. Its only job is to wake the runner; Agentry's
   minute sweep issues durable receipts and advances lifecycle bookkeeping. It never
   starts Codex/Claude, checks out code, calls a provider, or publishes a report.
10. For each receipt, start or recover one run and follow only its returned
    `next_action` until terminal.

## Owner setup walkthrough

The examples use placeholders. Do not copy literal IDs, hashes, ETags, credentials,
timestamps, funnel events, or idempotency keys into production.

```sh
export AGENTRY_BASE_URL="https://api.agentry.sh"
export PROJECT_ID="<project_id>"
export AUTOMATION_ID="weekly_funnel_review"
export AGENTRY_PRIVATE_API_KEY="<agentry_sk_owner_key>"
export AGENTRY_USER_AGENT="my-company-workflow-installer/1.0"
```

### 1. Discover and compile

```sh
curl -fsS "$AGENTRY_BASE_URL/v1/openapi.json?flow=automation"

curl -fsS \
  -H "Authorization: Bearer $AGENTRY_PRIVATE_API_KEY" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  "$AGENTRY_BASE_URL/v1/automation-workflow-components"

curl -fsS \
  -H "Authorization: Bearer $AGENTRY_PRIVATE_API_KEY" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  "$AGENTRY_BASE_URL/v1/automation-workflow-contracts"

curl -fsS \
  -X POST \
  -H "Authorization: Bearer $AGENTRY_PRIVATE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  --data @workflow.json \
  "$AGENTRY_BASE_URL/v1/projects/$PROJECT_ID/automation-workflows/compile"
```

Use the exact scheduled-funnel example in the compile operation's OpenAPI schema as
the starting `workflow.json`. Replace only source-backed funnel event names, schedule,
limits, and customer runner binding. Compile success means structurally valid and
reviewable, not enabled.

### 2. Save disabled and preserve the ETag

First save omits `If-Match`:

```sh
curl -fsS -D workflow-headers.txt \
  -X PUT \
  -H "Authorization: Bearer $AGENTRY_PRIVATE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  --data @workflow.json \
  "$AGENTRY_BASE_URL/v1/projects/$PROJECT_ID/automation-workflows/$AUTOMATION_ID"
```

For any replacement, first `GET` the current head and send its exact quoted `ETag`:

```sh
curl -fsS -D workflow-headers.txt \
  -H "Authorization: Bearer $AGENTRY_PRIVATE_API_KEY" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  "$AGENTRY_BASE_URL/v1/projects/$PROJECT_ID/automation-workflows/$AUTOMATION_ID"

curl -fsS \
  -X PUT \
  -H "Authorization: Bearer $AGENTRY_PRIVATE_API_KEY" \
  -H 'If-Match: "<current_workflow_etag>"' \
  -H "Content-Type: application/json" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  --data @workflow.json \
  "$AGENTRY_BASE_URL/v1/projects/$PROJECT_ID/automation-workflows/$AUTOMATION_ID"
```

On `412` or `428`, reload and review; never overwrite another revision.

### 3. Mint one exact runner credential

```sh
curl -fsS \
  -X POST \
  -H "Authorization: Bearer $AGENTRY_PRIVATE_API_KEY" \
  -H "Idempotency-Key: create-$AUTOMATION_ID-<stable-random-id>" \
  -H "Content-Type: application/json" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  --data '{
    "kind":"automation_runner",
    "name":"weekly funnel production runner",
    "automation_id":"weekly_funnel_review",
    "expires_in_seconds":2592000
  }' \
  "$AGENTRY_BASE_URL/v1/projects/$PROJECT_ID/credentials"
```

Place the one returned raw value in `AGENTRY_RUNNER_API_KEY` in the scheduler secret
store. Do not persist the response, key, or bearer value in this repository.

### 4. Read readiness, then enable the exact evidence

The schedule assertion is explicit owner evidence, not a free-form string. Use the
same confirmation set in readiness and enable:

```sh
curl -fsS -D readiness-headers.txt \
  -H "Authorization: Bearer $AGENTRY_PRIVATE_API_KEY" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  "$AGENTRY_BASE_URL/v1/projects/$PROJECT_ID/automation-workflows/$AUTOMATION_ID/readiness?confirm=scheduler_execution_configured"
```

Continue only when `status` is `ready`. Copy `revision_id`, `readiness_hash`, and the
exact workflow `ETag` from this response:

```sh
curl -fsS \
  -X POST \
  -H "Authorization: Bearer $AGENTRY_PRIVATE_API_KEY" \
  -H "Idempotency-Key: enable-$AUTOMATION_ID-<review-id>" \
  -H 'If-Match: "<exact_workflow_etag>"' \
  -H "Content-Type: application/json" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  --data '{
    "revision_id":"<exact_revision_id>",
    "readiness_hash":"<exact_readiness_hash>",
    "owner_confirmed_caller_assertion_ids":["scheduler_execution_configured"]
  }' \
  "$AGENTRY_BASE_URL/v1/projects/$PROJECT_ID/automation-workflows/$AUTOMATION_ID/enable"
```

If the response is lost, repeat the byte-equivalent normalized request with the same
`Idempotency-Key` and old reviewed `If-Match`. Agentry returns the durable receipt;
do not create another revision or credential. Preserve its `execution_authority_id`
and `execution_descriptor_hash`; every run must return that immutable reviewed
binding.

## Runner loop

```sh
export AGENTRY_RUNNER_API_KEY="<agentry_runner_key_for_exact_automation>"
export AGENTRY_USER_AGENT="my-company-workflow-runner/1.0"
```

The minute sweep normally issues due schedule receipts. An authenticated explicit
issue operation with strict body `{}` is also available for bounded catch-up/manual
proof. In either case,
the server derives `scheduled_for`, receipt output, source trust, availability,
expiry, revision binding, and hashes. The runner never sends those fields.

1. List `ready` receipts under the exact workflow's `/trigger-receipts` collection.
2. Start with only `{"trigger_receipt_id":"<receipt_id>"}` and a stable
   `Idempotency-Key` at the workflow's `/runs` collection.
3. `GET` the run immediately before every action. Treat `next_action` as the only
   work order only while `authority.open` is `true`. A historical action or command
   replay receipt does not override a live project/workflow kill switch.
4. If `next_action.required_principal` is `agentry_system`, that names the executor,
   not the HTTP caller. The project owner or exact-bound runner invokes its returned
   `/advance` path; Agentry then executes the reviewed node as `agentry_system` and
   never impersonates the caller.
5. If it is `automation_runner`, acquire the returned lease path before model work.
6. Submit one command with the returned `expected_revision`, exact node and typed
   output; then re-read. Release the lease when runner work stops.
7. Stop when `next_action` is `null`. Inspect `state.terminal`; do not infer success
   merely from HTTP `200`.

### Copyable minimal runner calls

Use the same exact workflow base for every call:

```sh
export WORKFLOW_BASE="$AGENTRY_BASE_URL/v1/projects/$PROJECT_ID/automation-workflows/$AUTOMATION_ID"
export RUNNER_AUTH="Authorization: Bearer $AGENTRY_RUNNER_API_KEY"
```

Issue a bounded server eligibility sweep. The body must be exactly `{}`; there is no
place for caller-authored trigger facts:

```sh
curl -fsS \
  -X POST \
  -H "$RUNNER_AUTH" \
  -H "Content-Type: application/json" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  --data '{}' \
  "$WORKFLOW_BASE/trigger-receipts/issue"
```

List ready receipts, then copy one exact `receipt_id`:

```sh
curl -fsS \
  -H "$RUNNER_AUTH" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  "$WORKFLOW_BASE/trigger-receipts?status=ready&limit=20"

export TRIGGER_RECEIPT_ID="<awtr_server_issued_id>"
export START_KEY="start-$TRIGGER_RECEIPT_ID-<stable-random-id>"
```

Start with only the receipt id. `trigger_output`, `scheduled_for`, trust, actor,
credential id, and timestamps are forbidden:

```sh
curl -fsS \
  -X POST \
  -H "$RUNNER_AUTH" \
  -H "Idempotency-Key: $START_KEY" \
  -H "Content-Type: application/json" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  --data "{\"trigger_receipt_id\":\"$TRIGGER_RECEIPT_ID\"}" \
  "$WORKFLOW_BASE/runs"

export RUN_ID="<awrun_id_from_response>"
export RUN_BASE="$WORKFLOW_BASE/runs/$RUN_ID"
```

Read immediately before every action. Continue only when
`execution_control.execution_authorized` and `authority.open` are both `true`:

```sh
curl -fsS \
  -H "$RUNNER_AUTH" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  "$RUN_BASE"
```

Require the non-null run `execution_authority_id` and `execution_descriptor_hash` to
match its enablement binding. An explicit null/mismatch fails closed; omission is
valid only on non-run control reads, never on an executable run.

When the open action names `required_principal: agentry_system`, ask the server to
advance reviewed system-owned nodes. The runner is the authenticated HTTP caller;
Agentry is the node executor:

```sh
curl -fsS \
  -X POST \
  -H "$RUNNER_AUTH" \
  -H "Content-Type: application/json" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  --data '{}' \
  "$RUN_BASE/advance"
```

When the open action is `agent.funnel-review`, generate one local opaque lease token,
then acquire the lease. Keep the token out of logs and output:

```sh
export LEASE_TOKEN="$(openssl rand -hex 32)"

curl -fsS \
  -X POST \
  -H "$RUNNER_AUTH" \
  -H "Content-Type: application/json" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  --data "{\"lease_token\":\"$LEASE_TOKEN\",\"lease_seconds\":900}" \
  "$RUN_BASE/lease"

export LEASE_EPOCH="<lease_epoch_from_response>"
```

Renew only the current unexpired epoch with the original token:

```sh
curl -fsS \
  -X POST \
  -H "$RUNNER_AUTH" \
  -H "Content-Type: application/json" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  --data "{\"lease_epoch\":$LEASE_EPOCH,\"lease_token\":\"$LEASE_TOKEN\",\"lease_seconds\":900}" \
  "$RUN_BASE/lease/renew"
```

Submit the typed funnel report with the lease nested inside the command. Copy
`EXPECTED_REVISION`, `SOURCE_HASH`, and valid dot-separated evidence paths from the
current action. Compute `REPORT_HASH` as SHA-256 of canonical JSON containing exactly
`source_hash`, `findings`, `limitations`, and `instruction_authority`. Canonical JSON
sorts every object key recursively, preserves array order, rejects non-JSON values,
and hashes the UTF-8 bytes. Do not hash display JSON, prose, or an unbound value:

```json
{
  "kind": "component_succeeded",
  "command_id": "review-funnel-result-<stable-id>",
  "expected_revision": 2,
  "node_id": "review_funnel",
  "output": {
    "report_hash": "<REPORT_HASH>",
    "source_hash": "<SOURCE_HASH_FROM_CURRENT_ACTION>",
    "findings": [
      {
        "kind": "metric",
        "statement": "The first current-period step contains the reported user count.",
        "evidence_paths": ["current.steps.0.users"]
      }
    ],
    "limitations": [],
    "instruction_authority": "none"
  },
  "usage": {
    "sequence": 1,
    "turns_used": 4,
    "cost_micros": 120000,
    "touched_files": [],
    "changed_line_churn": 0
  },
  "lease": {
    "lease_epoch": 1,
    "lease_token": "<LEASE_TOKEN>"
  }
}
```

Save that object as `funnel-command.json`, preserving the actual current revision and
lease values, then submit it:

```sh
curl -fsS \
  -X POST \
  -H "$RUNNER_AUTH" \
  -H "Content-Type: application/json" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  --data @funnel-command.json \
  "$RUN_BASE/commands"
```

Release the exact epoch when runner work stops. Exact replay uses the same reason:

```sh
curl -fsS \
  -X DELETE \
  -H "$RUNNER_AUTH" \
  -H "Content-Type: application/json" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  --data "{\"lease_epoch\":$LEASE_EPOCH,\"lease_token\":\"$LEASE_TOKEN\",\"reason\":\"runner component finished\"}" \
  "$RUN_BASE/lease"
```

Call `/advance` again to let Agentry persist the private report and reduce the
terminal. Finally `GET $RUN_BASE` and require `state.terminal.outcome` to be
`complete`; do not infer it from an earlier command response.

### Owner approval and cancellation payloads

The currently enabled scheduled-funnel graph has no approval node. This exact
approval command is protocol-only for a future graph whose components remain
readiness-blocked; never add it to the funnel workflow or use it without a current
`await_approval` action:

```sh
curl -fsS \
  -X POST \
  -H "Authorization: Bearer $AGENTRY_PRIVATE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  --data '{
    "kind":"approval_decided",
    "command_id":"approval-<stable-id>",
    "expected_revision":2,
    "node_id":"<CURRENT_APPROVAL_NODE_ID>",
    "decision":"approved",
    "reason":"Reviewed exact durable subject and binding"
  }' \
  "$RUN_BASE/commands"
```

Cancellation is available to the owner for a current nonterminal run. Preserve the
same key, revision, and reason after response loss:

```sh
curl -fsS \
  -X POST \
  -H "Authorization: Bearer $AGENTRY_PRIVATE_API_KEY" \
  -H "Idempotency-Key: cancel-$RUN_ID-<stable-random-id>" \
  -H "Content-Type: application/json" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  --data '{"expected_revision":2,"reason":"Owner requested stop"}' \
  "$RUN_BASE/cancel"
```

### CI effect reconciliation payload

GitHub external-effect graphs are not production-enableable in this slice. This is
the exact recovery protocol for a future reviewed graph or an already-started effect;
it is never permission to add or execute that component now. First `GET` the exact
`effect_id` and wait until `reconciliation.due=true`. For an inconclusive lookup:

```sh
export EFFECT_ID="<effect_id_from_current_run_action>"
export LOOKUP_STARTED_AT=1783661600
export LOOKUP_COMPLETED_AT=1783661610

curl -fsS \
  -H "Authorization: Bearer $AGENTRY_CI_API_KEY" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  "$RUN_BASE/effects/$EFFECT_ID"

curl -fsS \
  -X POST \
  -H "Authorization: Bearer $AGENTRY_CI_API_KEY" \
  -H "Idempotency-Key: reconcile-$EFFECT_ID-<stable-lookup-id>" \
  -H "Content-Type: application/json" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  --data "{
    \"outcome\":\"unknown\",
    \"evidence\":{
      \"provider\":\"github\",
      \"provider_operation_key\":\"<EFFECT_PROVIDER_OPERATION_KEY>\",
      \"provider_target\":\"<FROZEN_GITHUB_REPOSITORY_TARGET>\",
      \"intent_marker\":\"<EFFECT_INTENT_HASH>\",
      \"expected_head_sha\":\"<FROZEN_APPROVED_HEAD_SHA>\",
      \"lookup_started_at\":$LOOKUP_STARTED_AT,
      \"lookup_completed_at\":$LOOKUP_COMPLETED_AT,
      \"lookup_result\":\"unknown\",
      \"matched_provider_ref\":null
    }
  }" \
  "$RUN_BASE/effects/$EFFECT_ID/reconcile"
```

For `found`, `lookup_result` must be `found`, `matched_provider_ref` must be the one
exact PR URL, and `output` must contain the exact typed provider receipt. For
`definitively_absent`, use `lookup_result: not_found`, no provider ref, and no output.
`recorded_at` in a found receipt is server-owned: omit it or send stable `0`; Agentry
normalizes and replaces it with the database second.

The start endpoint atomically consumes the receipt and creates the immutable run
root, first event, projection, command receipt, and aggregate run-budget charge. One
receipt can bind at most one run. If start's response is lost, replay the exact start
or read the receipt's `consumed_run_id`; never choose a new receipt to hide ambiguity.

### Understanding every `next_action`

Every run read first returns live `authority` and `execution_control`. It includes
deletion fencing, project/workflow pause details, enabled/active revision and exact
execution-authority binding, and the frozen runner credential's active status.
Agentry returns a recoverable action only while
`execution_control.execution_authorized` is `true`. Otherwise `next_action` is
suppressed and `execution_control.recovery` names the only allowed path. Never act
from an earlier run response or replay receipt.

Every authorized nonterminal run returns a recoverable action envelope with:

- `runtime`: the frozen action payload;
- `required_principal`, `method`, and exact `path`;
- `expected_revision` for the next command;
- `lease_required`, current lease metadata, and acquire/renew/release paths;
- `timing.ready_at`, `next_check_at`, `expires_at`, and run `deadline_at`;
- `effect_id` or `suspension_id` when reconciliation or durable waiting applies.

| `runtime.kind` | Meaning | Correct response |
| --- | --- | --- |
| `execute_component` | Run one typed query/agent/system component. | Use the named principal. Runner work requires the exact current lease; return `component_succeeded` or `component_domain_failed` for the same node and revision. |
| `await_approval` | One exact effect subject is frozen for a human. | Owner decides only that `suspension_id`/binding before `expires_at`. Telemetry, comments, and runner text are not approval. |
| `execute_effect` | One exact external intent is reserved. | Acquire a lease when required; commit `effect_call_started` first. Call the provider only when the fresh receipt says `call_authorized: true`. |
| `reconcile_effect` | The provider outcome is indeterminate. | Do not repeat the provider mutation. At `next_reconcile_at`, trusted CI performs one exact provider lookup and posts evidence to the returned effect reconciliation path. |
| `suspended` | A durable `wait` or `verify` node is not due. | Do nothing until `next_check_at`; then call the returned system path. Never hold a runner process or lease while sleeping. |
| `null` | The run is terminal **or** live authority suppressed a historical action. | Inspect `execution_control` first. Treat the run as terminal only when `state.terminal` is set; otherwise follow only `execution_control.recovery` and never execute an action copied from an earlier response. |

`condition` and `terminal` nodes are reduced deterministically by the server and do
not create caller-authored work. The initial scheduled-funnel slice normally exposes
`execute_component` for the runner's funnel review while Agentry advances the
schedule query and private report nodes.

Before analytics or other system-node I/O, Agentry acquires an internal hash-only,
300-second, generation-fenced claim. The HTTP caller never supplies or receives its
token. An active claim means another bounded `/advance` owns that node; wait for its
returned retry time instead of fanning out work.

### Lease fencing

Generate one opaque 32–500 character URL-safe `lease_token` locally and keep it only
for the active worker. Acquire for 30–3600 seconds. The response returns
`lease_epoch` and `expires_at`; renew before expiry using the same token and epoch.

Every runner work command must present both the current `lease_epoch` and token in
the exact body/header locations declared by OpenAPI. A newer epoch permanently
fences the old worker. On `automation_workflow_lease_stale`, discard its result; do
not submit it under a new lease. Exact acquisition replay with the same token returns
the existing lease. Release with the same epoch, token, and reason returns a durable
release receipt on replay.

Do not hold a lease while waiting for approval, a timer, verification, budget reset,
or effect reconciliation.

## Effect safety and response-loss recovery

The first enabled graph has no external provider effect: `effect.report.private` is
an Agentry-owned private record. The runtime still exposes the full effect protocol
so future adapters cannot weaken it, and readiness blocks those adapters until their
complete execution and reconciliation boundary is installed.

For any external effect:

1. Read the exact `execute_effect` action and `effect_id`.
2. Commit `effect_call_started` for its immutable `intent_hash` while holding the
   required lease. This consumes the aggregate effect budget before provider I/O.
3. Call the provider only if this fresh command receipt returns
   `call_authorized: true` and `reconcile_only: false`.
4. Record the typed provider receipt against the same intent. If the provider result
   is ambiguous, read the effect and reconcile at `next_reconcile_at` using trusted
   CI and exact provider lookup evidence.

If the call-start response is lost, replaying it deliberately returns
`call_authorized: false` and `reconcile_only: true`. **Never interpret an idempotent
replay as permission to call the provider.** Look up the frozen provider operation
key/intent marker. If found, reconcile `found`; if a consistency-window-safe lookup
proves absence, reconcile `definitively_absent`; otherwise reconcile `unknown` and
wait for the next bounded attempt. Reconciliation always returns
`provider_call_authorized: false`.

A project/workflow pause or run cancellation after call-start prevents downstream
work but still permits the exact receipt or evidence-bound reconciliation to settle.
Settlement may then quarantine/stop the run. It never revives terminal authority.
Project deletion is stricter: its fence suppresses the action and blocks new local
cancel/settle/reconcile state. Resume only the original deletion command and use its
frozen external-cleanup manifest.

For a found external provider receipt, `recorded_at` is server-owned. The runner or
CI caller may omit it or send stable `0`; the transaction replaces it with its
database second and request identity normalizes it, so a retry crossing seconds is
still exact. Reconciliation replay binds `trusted_ci` rather than a particular
credential id: a replacement active project CI key may replay the same key/body,
while a revoked bearer remains rejected.

## Kill switches

Read project workflow control:

`GET /v1/projects/{project_id}/automation-workflow-control`

Emergency project pause and individual workflow pause intentionally require no
`If-Match`, so a stop can win:

```sh
curl -fsS \
  -X POST \
  -H "Authorization: Bearer $AGENTRY_PRIVATE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  --data '{"reason":"incident INC-123: stop all workflow authority"}' \
  "$AGENTRY_BASE_URL/v1/projects/$PROJECT_ID/automation-workflow-control/pause"

curl -fsS \
  -X POST \
  -H "Authorization: Bearer $AGENTRY_PRIVATE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  --data '{"reason":"incident INC-123: stop this workflow"}' \
  "$WORKFLOW_BASE/pause"
```

Project resume is owner-only, uses the exact project-control `ETag`, an empty JSON
object, and a stable `Idempotency-Key`. Read the current ETag immediately before
resume:

```sh
curl -fsS -D project-control-headers.txt \
  -H "Authorization: Bearer $AGENTRY_PRIVATE_API_KEY" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  "$AGENTRY_BASE_URL/v1/projects/$PROJECT_ID/automation-workflow-control"

curl -fsS \
  -X POST \
  -H "Authorization: Bearer $AGENTRY_PRIVATE_API_KEY" \
  -H 'If-Match: "<exact_project_control_etag>"' \
  -H "Idempotency-Key: resume-$PROJECT_ID-<stable-random-id>" \
  -H "Content-Type: application/json" \
  -H "User-Agent: $AGENTRY_USER_AGENT" \
  --data '{}' \
  "$AGENTRY_BASE_URL/v1/projects/$PROJECT_ID/automation-workflow-control/resume"
```

An individual paused workflow remains disabled. Re-read its revision and readiness,
review a new `readiness_hash`, and enable it again. A pause does not disable the
customer scheduler or revoke its secret; do those in the owning system when the stop
must persist outside Agentry.

Kill switches block new receipts, starts, leases, system advancement, runner work,
and provider call-start. The current run response suppresses its historical action
and returns live recovery permissions. They do not refund budgets or reverse
external state.

## Budgets

The immutable revision and aggregate ledgers enforce:

- runs per rolling day and attempts per trigger;
- model turns, integer micro-dollar cost, active runtime, and elapsed deadline;
- files changed and total line churn;
- external effects per run and per rolling day.

Run charges commit atomically with start. Effect charges commit atomically with
call-start, before provider I/O. Cancellation, pause, failure, response loss, and an
unknown provider outcome do not refund a consumed charge. On a budget error, obey its
`next_action`; never change a key, receipt, run, or lease to evade the ledger.

## Lost-response recovery table

| Lost response | Safe recovery |
| --- | --- |
| Save/replace | `GET` current workflow. Match revision/hash/ETag; never repeat a stale conditional write blindly. |
| Credential create | Retry same `Idempotency-Key`. If the secret was lost, revoke the identified credential and create one deliberate replacement. |
| Enable/project resume | Replay byte-equivalent request with the same `Idempotency-Key`; the durable receipt wins even if the reviewed ETag is now old. |
| Pause | Read desired state. Repeating the same bounded reason returns the existing pause state. |
| Trigger issue | List/detail receipts for the exact revision and occurrence; issuance identity absorbs duplicates. Never invent trigger output. |
| Run start | Replay same key and receipt, or read receipt `consumed_run_id`, then `GET` that run. |
| Lease acquire | Replay with the same locally retained token. A different token waits for expiry and creates a new epoch; it does not inherit old work. |
| Lease renew/release | Replay exact epoch/token/request. If stale, read the current run/lease and discard work from the old epoch. |
| Ordinary command | Replay the identical `command_id`, `expected_revision`, actor, and payload. A different payload with the same ID is a conflict. |
| Effect call-start | Replay only to recover the receipt. On replay, `reconcile_only: true`; never call the provider from that replay. |
| Provider mutation/receipt | Read `effect_id`; reconcile by frozen provider operation key and intent marker. Do not submit another call-start. |
| Effect reconciliation | Replay the same evidence and `Idempotency-Key`. If another event advanced first, read the effect and continue only if another lookup is due. |
| System advance | Re-read the run. If the action changed, it committed; if unchanged and due, call the returned path again. |
| Cancel | Replay the same stable key/reason, then read the terminal run. Inspect external follow-up separately. |

## Error recovery matrix

All errors use the standard `ErrorEnvelope` with `code`, `message`, `next_action`,
`request_id`, `retryable`, and optional `details`. The code and `next_action` are more
specific than the HTTP status.

| Code or family | Meaning | Recovery |
| --- | --- | --- |
| `automation_workflow_not_ready` | One or more exact enablement checks is blocked. | Resolve every returned blocker, then re-read readiness. Do not reuse the old hash. |
| `automation_workflow_caller_assertion_unknown` | Confirmation is not required by this revision. | Send only exact IDs in readiness checks; no free-form assurances. |
| `automation_workflow_component_set_not_enabled` | Graph compiles but lacks a production adapter/handler. | Keep it disabled. Use only the four enabled components or ship the reviewed adapter/runtime first. |
| `automation_workflow_execution_descriptor_not_ready` | The exact reviewed execution descriptor cannot be issued. | Keep disabled; re-read readiness, resolve every blocker, and enable only the newly reviewed exact descriptor. |
| `precondition_required` / HTTP `428` | Required strong `If-Match` is absent. | `GET` current state, review it, and retry conditionally. |
| `precondition_failed` / HTTP `412` | Revision, ETag, or readiness changed. | Reload workflow and readiness; never transplant an old hash to the new revision. |
| `automation_workflow_project_kill_switch_active`, `automation_workflow_trigger_authority_closed` | Project-wide authority is paused or missing. | Stop new work and read `execution_control.project_control`. Outside deletion, the current recovery object may allow cancellation or already-started effect recovery. |
| `automation_workflow_kill_switch_active`, `automation_workflow_disabled` | This workflow/revision authority is disabled, paused, mismatched, or missing. | Read `execution_control.workflow_control`; restore only a newly reviewed exact revision. Never reuse the suppressed action. |
| `project_deletion_in_progress` | Project deletion is the live authority fence. | Resume only the original delete command and its frozen external-cleanup manifest. Do not cancel, settle, reconcile, query analytics, or start work locally. |
| `automation_workflow_execution_authority_missing` | This run has no immutable reviewed execution authority. | Nonretryable: do no analytics/provider work; pause, save/review/enable a replacement revision. Never advance the legacy run. |
| `automation_workflow_execution_descriptor_drift` | Stored execution descriptor/hash no longer matches its reviewed binding. | Nonretryable: no analytics read or provider work; pause and inspect, then save/review/enable a new exact revision. |
| `automation_workflow_execution_authority_inactive` | This run's reviewed authority is no longer active. | Follow live `execution_control`; do no new work. Cancel, or settle/reconcile only an already-started effect when explicitly allowed, then enable/start a new run. |
| `automation_workflow_runner_credential_inactive` | The run's frozen runner credential was revoked/expired. | It cannot swap runners. Cancel, or explicitly allowed settle/reconcile only; create a new run after a new exact runner binding passes enablement. |
| `automation_workflow_system_node_claim_active`, `automation_workflow_system_node_claim_contention` | Another bounded system advance owns this node. | Wait until `details.retry_at`, `GET` the run, then replay `/advance`; never fan out. |
| `automation_workflow_system_node_claim_stale` | The claim no longer matches current run/node authority. | Re-read `next_action`; do not reuse the stale action or result. |
| `automation_workflow_system_node_claim_fence_lost` | This worker lost the internal generation fence. | Discard its result and re-read the run; never commit fenced output. |
| `automation_workflow_trigger_receipt_not_yet_available` | Receipt occurrence is early. | Wait until `available_at`; do not alter server time or payload. |
| `automation_workflow_trigger_receipt_expired` or receipt `status=cancelled` | Receipt cannot start work. | Keep its evidence; request/list a new eligible occurrence only if policy permits. |
| `automation_workflow_trigger_receipt_already_consumed` / `automation_workflow_trigger_consume_conflict` | Receipt already binds a run or raced. | Read `consumed_run_id` and that run; do not start a second run. |
| `automation_workflow_run_revision_conflict` | Another command advanced the run. | Re-read; discard work based on the old revision. |
| `automation_workflow_lease_busy` | Another unexpired worker owns the run. | Wait until returned expiry. Do not use or guess its token. |
| `automation_workflow_lease_stale`, `automation_workflow_lease_contention` | Epoch expired, released, or lost a race. | Stop and discard stale output; acquire/read the current epoch before new work. |
| `automation_workflow_run_terminal` | Run no longer issues work. | Read and retain terminal state; reconcile only separately allowed indeterminate effects. |
| `automation_workflow_effect_indeterminate` | Provider call outcome is uncertain. | Never repeat it. Read effect and follow reconciliation timing. |
| `automation_workflow_effect_reconciliation_not_due` | Backoff/consistency window is active. | Wait until returned `next_reconcile_at`; preserve the same intent identity. |
| `automation_workflow_effect_not_indeterminate` | Effect already settled or needs manual follow-up. | Return existing state; do not write another reconciliation event. |
| `automation_workflow_effect_run_budget_exhausted` | This run has no provider-call capacity. | Do not call provider; escalate/inspect prior attempts. This is not a timed retry for the same run. |
| `automation_workflow_effect_daily_budget_exhausted`, `automation_workflow_daily_run_budget_exhausted` | Rolling aggregate capacity is spent. | Wait until the returned/reset boundary. Never rotate credentials or IDs to evade it. |
| HTTP `429` platform quota | Account/platform limit, not necessarily workflow budget. | Read the exact code and `Retry-After`/details; recovery reads and stop controls remain available. |
| HTTP `500`/persistence/hash-chain error | Durable state cannot be proven consistent. | Stop/quarantine. Preserve IDs and request ID for operators; never retry a provider mutation from uncertainty. |

`retryable: true` never grants permission to repeat an external mutation. A retry is
safe only when the operation's OpenAPI mutation policy and this table say how to
recover its durable intent.

## Deletion and external cleanup

Project/account deletion fences every workflow credential and mutation before local
rows cascade. Keep one stable deletion `Idempotency-Key` through every `202`. Read the
terminal automation deletion manifest. Then disable the customer scheduler, revoke
runner/provider credentials, and reconcile every named or possible external effect
in its owning system. Agentry cannot disable schedules or provider resources it does
not own.

## Cold-agent completion checklist

A setup is complete only when all of these are true:

- the exact saved revision is the enabled active revision;
- readiness is `ready` with reviewed evidence and the schedule confirmation;
- exactly one active runner credential is bound to the `automation_id`;
- the customer scheduler holds only that runner key;
- one server-issued receipt starts or recovers one run;
- the runner follows returned paths/revisions/leases and reaches a terminal state;
- the private report is bound to the exact ordered-funnel source hash and remains
  private;
- pause, response-loss replay, stale-lease rejection, aggregate budget rejection,
  and any relevant effect reconciliation path have been exercised or tested;
- the external scheduler stop/revoke procedure is documented outside Agentry.
