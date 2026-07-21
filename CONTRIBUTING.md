# Contributing to Agentry

Agentry welcomes focused bug fixes, documentation improvements, tests, workflow
examples, and proposals that make the HTTP contract safer or easier for coding
agents to use.

## Before opening a change

1. Read [`PLAN.md`](./PLAN.md) and [`docs/agent-product-guide.md`](./docs/agent-product-guide.md).
2. Search existing issues and pull requests.
3. For a broad API, storage, auth, billing, or automation change, open an issue
   first so the contract and migration cost can be discussed.
4. Never use production credentials or customer data in development, fixtures,
   issues, or pull requests.

## Local checks

Requirements: Node.js 22.12 or newer and npm.

```sh
npm ci
npm run lint
npm run typecheck
npm test
```

Run focused package tests while iterating. Before requesting review, run the
repository-wide checks relevant to your change and report anything you could
not run.

## Pull requests

- Keep one coherent change per pull request.
- Add or update tests for observable behavior.
- Update OpenAPI and agent-facing docs when a contract changes.
- Preserve existing telemetry unless the change explicitly migrates it.
- Explain security, privacy, credential, compatibility, and deployment effects.
- Do not commit generated secrets, `.dev.vars`, local databases, telemetry
  exports, proof artifacts, screenshots containing private data, or outreach
  data.

Contributions intentionally submitted to this repository are licensed under
Apache License 2.0 as described in section 5 of [`LICENSE`](./LICENSE), unless
you explicitly mark the submission as “Not a Contribution.”

Workflow contributions have additional guidance in
[`workflows/CONTRIBUTING.md`](./workflows/CONTRIBUTING.md).
