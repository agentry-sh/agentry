---
name: agentry
description: Use for Agentry setup or use; analytics, errors, recordings, feature flags, surveys, experiments, deploy attribution, production investigation, or agentic automation.
---

# Agentry

Agentry connects a customer's PostHog Cloud project to their coding agent. PostHog remains authoritative for analytics, Error Tracking, recordings, feature flags, surveys, and experiments; Agentry owns source-backed plans, bounded evidence, deploy attribution, approvals, and automation state. Docs/filtered OpenAPI are authoritative.

Route by task:

- Install or change telemetry: https://raw.githubusercontent.com/agentry-sh/agentry/main/INSTALL.md
- Exact onboarding schema: https://api.agentry.sh/v1/openapi.json?flow=onboarding
- Daily product/reliability questions: https://raw.githubusercontent.com/agentry-sh/agentry/main/AGENTRY.md
- Recordings, flags, surveys, and experiments: https://api.agentry.sh/v1/openapi.json?flow=posthog
- Product discovery: https://api.agentry.sh/
- Exact payloads: https://api.agentry.sh/v1/openapi.json?index=true; filter with `?flow=<name>`, `?tag=<name>`, or `?path=<encoded-path>&method=<method>`.
- Automations: https://api.agentry.sh/v1/docs/automation, https://api.agentry.sh/v1/openapi.json?flow=automation, and immutable versioned https://api.agentry.sh/v1/automation-playbooks
- Refresh agent adapter pointers: https://api.agentry.sh/adapters

## First installation

Run `agentry onboard` interactively or `agentry onboard --json` from an agent, then follow its `agent_task`, `human_checkpoint`, `external_action`, or `complete` checkpoint. The CLI owns sign-in, project claim, discovery, plan hashes, resumption, and credential storage.

With no owner key, `agentry login` starts an ephemeral loopback listener, opens one PostHog sign-in/consent URL, and returns automatically. No separate Agentry account or copied code exists; provider tokens never reach the CLI or agent. JSON mode asks the human to run interactive login once.

Read the canonical `INSTALL.md` URL above completely. Connect the customer's existing PostHog Cloud project through browser-based read-only OAuth. Deeply inspect the repository before choosing telemetry: map the actor, entry, every material durable milestone, business result, impactful failure surfaces, current official PostHog setup, and real deploy boundary. Inspect recording metadata, flags, surveys, and experiments as provider state; prove source application, rendering, exposure, consent, and outcomes separately. Event names and journey length are project-specific.

Compare bounded PostHog history with current source. Label matching history `historically_observed`; it does not prove current source ownership. Show the exact source-backed plan and hash before editing. Installation completes only when the CLI returns `complete` with required signals `source_verified`; do not preserve a generic verified alias.

Preserve correct existing PostHog telemetry. Add or move signals only after exact plan approval, emit product outcomes after success, and use the customer's official PostHog SDKs and CLI directly. Application analytics and exceptions go straight to customer PostHog Cloud. Source maps go straight through the official PostHog CLI. Agentry never proxies either path.

Before plan submission, use a fresh read-only reviewer or fresh context to try to falsify the business flow, alternate owners, indirect state writes, exact properties, failures, privacy, identity, and deploy ordering. Telemetry-derived state is observational: do not change product queues, webhooks, notifications, retries, responses, or payloads to satisfy proof.

Keep source snapshots, plans, receipts, and credentials outside the repo. Historical rows cannot prove a current source boundary, and server evidence cannot infer a physical click or external actor. Exercise the reviewed shipped paths after deployment before claiming source verification.

Credentials are non-interchangeable:

- PostHog SDK/project credentials: customer-owned application telemetry sent directly to PostHog.
- PostHog CLI credential: customer-owned source-map upload from trusted CI directly to PostHog.
- PostHog OAuth: encrypted read-only control-plane connection for bounded analytics, Error Tracking, recording-metadata, flag, survey, and experiment reads; access/refresh tokens are never exposed to the CLI, coding agent, app, CI, or runner.
- `AGENTRY_CI_API_KEY` (`agentry_ci_`): Agentry deploy evidence and CI proof only.
- `AGENTRY_RUNNER_API_KEY` (`agentry_runner_`): exactly one automation.
- `AGENTRY_PRIVATE_API_KEY` (`agentry_sk_`): interactive owner/member only.

An owner key is never a scheduler credential. An unattended scheduler gets only its automation-scoped runner key. Do not emit deploys from browser, app startup, request handlers, or cron routes. Keep secrets out of repos, telemetry, prompts, and output.

Use a custom User-Agent for non-browser direct HTTP calls. Browser fetch uses the browser's own User-Agent and cannot set this header manually.
