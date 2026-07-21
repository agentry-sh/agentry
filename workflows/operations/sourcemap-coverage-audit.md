# Audit PostHog source-map coverage for production errors

Find active client errors whose provider-symbolicated frames are still minified, then
repair the PostHog CLI build/upload boundary.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Audit PostHog source-map coverage for production errors
description: >-
  Find active client errors whose provider-symbolicated frames are still
  minified, then repair the PostHog CLI build/upload boundary.
category: ops
tags:
  - errors
  - sourcemaps
  - posthog
  - releases
  - frontend
  - ops
  - sentry-alternative
prompt: >-
  Audit source-map coverage for active client-side errors. Which PostHog-backed
  cases still have minified frames, and which build or CLI upload step needs repair?
difficulty: intermediate
time_to_value: 5 minutes
prereqs:
  - Client errors are flowing with the deployed release
  - The production build emits source maps
  - Trusted CI can run the official PostHog CLI
applies_to:
  - b2c-saas
  - b2b-saas
  - ecommerce
  - marketplace
  - content-media
  - devtools-api
required_events:
  - $exception
required_event_properties:
  $exception:
    - release
negative_fit:
  - >-
    Do not use when the shipped runtime has no minified or native-debug artifact
    boundary, or until the exception signal is source-verified and live
    PostHog issues exist.
ask_if_missing:
  - >-
    Is the exception source-verified, which active cases have minified provider
    frames, and does the reviewed CI build generate source maps before deployment?
related:
  - browser-version-errors
  - deploy-regression
  - session-replay-investigation
updatedAt: 2026-07-15T00:00:00.000Z
publishedAt: 2026-05-26T00:00:00.000Z
```

</details>

Find active client-side errors whose PostHog-symbolicated frames are still
minified, then repair the build or official CLI upload step that owns them.

## Why this matters

Minified frames turn a small frontend bug into archaeology. PostHog already
owns symbolication; the useful question is whether the deployed artifact was
injected and uploaded under the same release identity as the exception.

## What you get

- Active client-side cases with still-minified provider frames
- The affected deploy/release identities
- The exact build, injection, or upload boundary that is missing
- A reviewable CI change using the official PostHog CLI

## Walk through it

**You:**
> Which production errors still need source maps?

**Agent:**
> I’ll inspect active PostHog-backed cases, compare their frames and release
> identities with the shipped build, then review the trusted CI upload step.

```text
Endpoint: GET /v1/projects/:project_id/cases?status=active
Then: GET /v1/cases/:case_id for bounded provider-symbolicated evidence.
```

```text
Use the official PostHog CLI commands documented for the customer's SDK and
build tool to inject chunk ids before deployment and upload the matching source
maps directly to the customer-owned PostHog Cloud project.
```

The required PostHog credential stays in the customer's CI secret store and is
used only by the official PostHog CLI. Agentry receives neither that credential
nor the source-map artifacts; its separate CI credential records only deploy and
provider-observed PR proof.

## The output

Return a punch list by active case: deploy SHA, minified frame, build output,
current CI evidence, likely mismatch, and the smallest safe repair. Do not call
an empty case list proof that source maps work.

## Setting it up

Generate source maps in the production build, then run the official PostHog CLI
after bundling and before deployment. Keep the customer-owned PostHog CLI
credential and the Agentry deploy-proof credential in separate CI secret
boundaries. Run `agentry onboard` to review the exact existing build integration.

## Variations

- *"Only audit the latest production release."*
- *"Generate the PostHog CLI step for Vite or Next.js."*
- *"Which active cases became readable after the last upload?"*
