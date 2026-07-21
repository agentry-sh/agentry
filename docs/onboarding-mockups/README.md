# Onboarding fixture boundary

This directory is not an onboarding documentation archive or acceptance
harness. Tracked content is limited to two small demo products that developers
may use for local instrumentation experiments:

- [`fixtures/runtime-b2b-funnel`](./fixtures/runtime-b2b-funnel/README.md) — a
  server-side B2B product funnel with provider and billing failures.
- [`fixtures/runtime-b2c-existing-analytics`](./fixtures/runtime-b2c-existing-analytics/README.md)
  — a B2C product that must retain its existing analytics while Agentry is
  layered in.

Current contracts and release instructions live outside this directory:

- [`docs/onboarding.md`](../onboarding.md) — onboarding state-machine
  architecture.
- [`INSTALL.md`](../../INSTALL.md) — the canonical verified-install contract.

Legacy mockups, personas, transcripts, scored runs, route snapshots, and old
fixtures were removed because they taught retired endpoints and repo-artifact
conventions. Keep any research archive outside the active repository. Ignored
local remnants are not instructions, tests, or release evidence and should not
be searched or cited by agents.

These fixtures are not part of the blind acceptance score. Generated output and
route-coverage reports belong under ignored `tmp/`, never beside the fixtures.
