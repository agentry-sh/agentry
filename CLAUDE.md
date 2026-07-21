# Agentry — Repo Instructions for Claude

## What this is
Agent-first error monitoring, product analytics, and deploy attribution. The user's own AI agent investigates over the HTTP API. We never run LLM calls server-side.

## Read order for new sessions
1. [AGENTS.md](./AGENTS.md) — current operating contract and mental model.
2. [PLAN.md](./PLAN.md) — what we're building and why.
3. [docs/agent-product-guide.md](./docs/agent-product-guide.md) — product and architecture decision compass.

## Topical guides (read before editing the relevant area)
- [workflows/AGENTS.md](./workflows/AGENTS.md) — before adding or editing
  repository workflow examples. Covers the customer-owned PostHog data plane,
  the Agentry control-plane API surface,
  GitHub-native workflow metadata, and conversation-mockup convention. These
  workflows are source material, not executable API recipe endpoints.
- [docs/core-database-migrations.md](./docs/core-database-migrations.md) — before
  changing the product schema, migration manifest, database release command, or
  control-plane database/API rollout order.

## Hard rules
- **AGENTS FIRST.** No dashboard or browser-only observability interface. The
  HTTP API is the product surface; agents use it directly (curl/fetch) or via
  thin per-platform skills/adapters that point at it. Human browser pages are
  limited to the PostHog authorization return and transactional invitation or
  billing-return flows. PostHog is the only interactive sign-in surface.
- **Never run an LLM server-side** in the API or worker. The agent runs in the user's own coding agent.
- **No opaque server-side compute.** The HTTP API is the deterministic product surface — durable delivery, retrieval, verification, management, queries, and provider-backed controls. PostHog owns issue grouping and source-map symbolication; Agentry does not recreate either engine locally. Everything Agentry does is reproducible text. The principle:
  - Every capability is an HTTP endpoint documented in the live
    `/v1/openapi.json`; authored install and operating guidance lives in
    [INSTALL.md](./INSTALL.md) and [AGENTRY.md](./AGENTRY.md).
  - Per-platform skills/adapters (Claude skill, AGENTS.md, Cursor, Windsurf, ChatGPT Action) are thin wrappers that point at the API — they must not carry exclusive product logic.
- Keep public architecture and operating guidance current in the same change
  that changes its contract. Do not publish customer data, credentials,
  onboarding proofs, internal launch notes, or production runbooks.

## Agentry state and credentials
- Onboarding plans, proof state, receipts, and operational data stay on the
  server. Do not create a repo-local onboarding state bundle.
- Application analytics and exceptions go directly to the customer's PostHog
  Cloud project through its existing official SDKs. Source maps go directly
  through the official PostHog CLI. Agentry issues no application telemetry
  credential and exposes no runtime-ingest endpoint.
- `agentry onboard` uses one browser-based PostHog sign-in/read-only consent
  flow, not a separate account flow. The hosted control plane encrypts
  the access and refresh tokens and never exposes them to the CLI, coding agent,
  repository, application, CI, or runner.
- Credential boundaries are exact: `agentry_sk_` is interactive owner/member
  access, `agentry_ci_` is Agentry deploy and provider-observed PR proof, and
  `agentry_runner_` is bound to one unattended automation. Customer PostHog
  project and personal credentials remain customer-owned and never become
  Agentry runner credentials.
- Follow the CLI/server onboarding state's one current checkpoint until every
  required signal is `source_verified` and the command returns `complete`.
  Credentials live only in their execution environment or
  `~/.agentry/credentials.json`.
- Do not create repo-local `.agentry` onboarding or scratch files.

## Stack
TypeScript, Cloudflare Workers (Hono), Turso/libSQL via Drizzle, Zod, Vitest, npm workspaces.

## Commands
- `npm ci` at root
- `npm run typecheck` — across all packages
- `npm run test` — vitest across all
- `npm -w @agentry/api run dev` — local Worker development
- `npm run release:verify` — complete public release gate
- Package deploy scripts use the guarded release wrapper. Never call
  `wrangler deploy` directly for a product release.

## Pitfalls
- Workers don't have `Buffer` or many Node APIs by default. Use Web Crypto, not `crypto`.
- Product DB releases use the append-only coordinator in
  `packages/db/scripts/core-migration-manifest.mjs`; never use
  `drizzle-kit push` against a shared or production database. The generated
  Drizzle baseline is only for the guarded empty-database bootstrap.
