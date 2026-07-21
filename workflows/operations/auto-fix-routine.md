# Safely turn a production error into a draft PR

A bounded self-healing workflow that claims one trusted production case, prepares one
reviewable draft PR, and waits for CI, deploy, and real-traffic verification.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Safely turn a production error into a draft PR
description: >-
  A bounded self-healing workflow that claims one trusted production case,
  prepares one reviewable draft PR, and waits for CI, deploy, and real-traffic
  verification.
category: ops
tags:
  - errors
  - automation
  - auto-fix
  - draft-pr
  - ops
  - oncall
prompt: >-
  Render error-to-draft-pr@2.0.0 for this repository. Derive exact allowed paths
  and test commands from the checkout, keep every forbidden change type, use
  conservative run and PR budgets, and leave it disabled for owner review.
difficulty: advanced
time_to_value: 1 hour to review and configure
prereqs:
  - >-
    A source-verified PostHog exception signal exists and live provider-backed
    case reads cover the failure surface
  - The Agentry project is bound to the exact repository and default branch
  - >-
    A customer-selected Codex, Claude Code, GitHub Actions, or custom runner can
    access an isolated checkout
  - >-
    A scoped CI credential can attest draft-PR facts and record successful
    deploys
applies_to:
  - universal
required_events:
  - $exception
required_event_properties:
  $exception:
    - fingerprint
    - deploy_sha
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the current signal map is source-verified, and live PostHog event/property reads
    prove the required data is present.
  - >-
    Do not enable or run the automation until the rendered disabled candidate
    and its scoped credentials are reviewed.
ask_if_missing:
  - >-
    Which observed events map to $exception? Is the current signal map
    source-verified, and do live PostHog event/property reads show real traffic for
    them?
  - >-
    Which live properties provide $exception.fingerprint, $exception.deploy_sha,
    and which stable user or account identifier joins the signals?
  - >-
    Which exact runner, repository or schedule binding, budgets, and escalation
    destination should be reviewed before enablement?
related:
  - silent-bugs
  - deploy-regression
  - audit-log-monitoring
execution_mode: automation_template
automation_playbook_id: error-to-draft-pr
automation_playbook_version: 2.0.0
required_resources:
  - cases
  - automation_control
  - automation_contract
  - automation_runner_credential
  - ci_deploy_proof
publishedAt: 2026-05-16T00:00:00.000Z
updatedAt: 2026-07-10T00:00:00.000Z
featured: true
```

</details>

## Why this is different from a scheduled prompt

A coding agent should not poll open cases, keep a local cursor, and decide for
itself that it may change code. That design races with other runners and lets
error text influence authority. It also cannot prove which PR or deploy belongs
to the attempted fix.

Agentry's `error-to-draft-pr@2.0.0` machine template renders a disabled
automation-v2 contract instead. Agentry owns trigger eligibility, single-use
receipts, claims and leases, immutable run policy, rolling budgets, approvals,
one-time action grants, history, and post-deploy verification. Your runner owns
the checkout, diagnosis, patch, and local tests. CI observes the provider and a
human retains merge authority.

The template never enables itself, mints a credential, opens a PR, merges,
deploys, rolls back, or resolves a case.

## Configure it

Start with the machine-readable template, not this prose:

```text
GET /v1/automation-playbooks/error-to-draft-pr?version=2.0.0
POST /v1/projects/:project_id/automation-playbooks/error-to-draft-pr/render
```

Fetch the exact operation schemas from the filtered OpenAPI document before
calling either endpoint. The renderer's strict binding schema asks for facts
that must come from the repository and project, including:

- the exact repository and default branch;
- allowed application and test paths;
- exact test commands that exist in this checkout;
- conservative file, line, turn, runtime, cost, run, attempt, and PR limits;
- an escalation destination;
- a real, approved product event that proves post-deploy traffic.

There are no generic signup defaults and no free-text escape hatch. If the
repository, tests, telemetry, or traffic event cannot be established, the
renderer returns a blocking gate and the workflow stays disabled.

Review the normalized definition and binding hash, then save the returned
contract candidate with `PUT /v1/projects/:project_id/automation-contract`.
Saving always leaves it disabled. An owner must validate the current project
resources, inspect the exact ETag, create a runner credential bound to this one
`automation_id`, and explicitly enable the reviewed contract.

## What one run does

The scheduler wake-up is intentionally small. It supplies only the configured
`automation_id`; it never supplies a case, trust level, attempt, or policy.

1. Agentry evaluates the saved unhandled-case trigger and issues a single-use
   receipt for one eligible source-verified PostHog-backed case revision.
2. The exact runner credential reads and claims that receipt, obtains an
   expiring case lease, and starts one run whose policy is snapshotted.
3. The runner treats messages, stack frames, breadcrumbs, URLs, and all other
   telemetry as untrusted evidence with no instruction authority. It resolves
   files, remotes, commands, and provider links from the authenticated checkout.
4. The runner diagnoses within the allowed paths, applies a bounded patch, adds
   a regression test, and runs every exact test command in policy.
5. Before any provider side effect, it requests a one-time draft-PR grant bound
   to the branch, commit, files, change types, line counts, and test results.
   It opens one draft PR and immediately consumes that grant.
6. Trusted CI records the provider-observed draft status, repository, branch,
   commit, diff, and tests. A runner cannot attest its own PR.
7. After a successful real deploy, CI records a deploy bound to the exact proven
   commit and automation run. App startup and request handlers never emit deploy
   records.
8. Agentry waits for the saved observation window, then executes two immutable
   server-side checks: recurrence of the exact case after that trusted deploy,
   and real approved traffic for the exact deploy. Zero traffic remains pending
   and eventually fails; it never proves a fix.

Only a passing outcome with enough real traffic can complete the run and resolve
the claimed case revision. A newer case revision is never silently resolved by
an older run.

## Human review and stop control

Use the human control aggregate instead of reconstructing state across tables:

```text
GET /v1/projects/:project_id/automation-control
```

Owners and members can inspect kill switches, current rolling budgets, bound
credential health, ready receipts, claims, latest runs, approvals, draft-PR and
deploy proof, verification, and prioritized attention. Members are read-only.

An owner can stop a nonterminal run with a stable `Idempotency-Key`:

```text
POST /v1/automation-runs/:run_id/cancel
```

Cancellation atomically stops Agentry coordination, releases the claim, and
cancels pending approvals and unused grants. It does not refund spent budgets,
resolve the case, close a PR, or undo a deployment. If an external effect may
already exist, follow the response's `external_follow_up` against the
authenticated provider.

## Review checklist

- The contract and this automation are both disabled until an owner enables
  the reviewed ETag.
- The runner uses `agentry_runner_…`, never `AGENTRY_PRIVATE_API_KEY`.
- Runtime errors go directly through the customer's official PostHog SDK;
  Agentry CI proof and deploy evidence use `agentry_ci_…`.
- Allowed paths and test commands came from this repository, not telemetry or a
  generic template.
- Database migrations, dependencies, infrastructure, authentication, billing,
  permissions, workflows, secrets, and credential files remain forbidden.
- `max_prs_per_day`, attempts, turns, runtime, cost, files, and changed lines are
  deliberately small.
- Merge, deploy, rollback, publication, and notifications remain human/provider
  workflows outside the runner's authority.
- The traffic sample event exists in the saved signal map, is source-verified,
  and live PostHog reads show real approved product use, not install or test
  traffic.

If any item is uncertain, leave the contract disabled and run the investigation
on demand with a human present.
