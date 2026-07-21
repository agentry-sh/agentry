# GitHub public-repository migration

This document is the release checklist for making
[`github.com/agentry-sh/agentry`](https://github.com/agentry-sh/agentry) Agentry's
canonical public home. It is deliberately a fresh-history migration, not a
push or rename of this private development repository.

## Decisions

- **Public model:** the canonical public core, including the API, database,
  agent adapters, workflows, tests, and contributor documentation.
- **License:** Apache License 2.0 for Agentry-authored code, with third-party
  notices and licenses retained separately. See `LICENSES.md` and `NOTICE`.
- **Documentation:** repository Markdown only. The root README is the homepage;
  `INSTALL.md`, `AGENTRY.md`, and `workflows/` hold the durable guides.
- **Domains:** only `agentry.sh` redirects to the GitHub repository.
  `api.agentry.sh`, `auth.agentry.sh`, and every other required service
  subdomain keep their existing application or API behavior.

## Repository metadata and reachability

Use this exact GitHub **About** metadata at launch:

- **Description:** `Agent-first control plane for PostHog — source-backed analytics, production investigation, and bounded self-healing and self-improving software workflows.`
- **Website:** `https://agentry.sh`
- **Social preview:** upload `assets/social/repository-preview.png` in repository
  settings. The reviewed image is 1280×640; committing it does not make GitHub
  select it automatically.

Use these 20 repository topics, in this order of importance:

```text
observability
ai-agents
coding-agents
agentic-observability
error-monitoring
product-analytics
deploy-tracking
api-first
mcp-server
codex
claude-code
cursor
developer-tools
logging
production-debugging
github-actions
self-healing
incident-response
root-cause-analysis
posthog
```

These terms describe shipped surfaces and should also appear naturally in the
README's opening, headings, quickstart, integrations, and image alt text. Do not
add unrelated trending topics or repeat keyword lists in prose; precise examples
and links are more useful to engineers and search indexing than keyword stuffing.

Short GitHub reachability checklist:

1. Make the repository public with `main` as the default branch and complete
   the description, website, topics, and social preview before announcement.
2. Verify the README's first screen says **open-source**, **agent-native
   observability**, **error monitoring**, **product analytics**, and **deploy
   attribution**, then exposes a copyable install path without requiring a site.
3. Add the repository to the Agentry organization profile and pin it; link to it
   from package metadata, agent/plugin directories, release notes, and the apex
   redirect so GitHub receives consistent canonical references.
4. Publish a real initial release with concise notes and stable install links.
   Keep Issues enabled and use descriptive issue/PR titles, labels, and public
   roadmap discussions so solutions remain discoverable.
5. From a signed-out session, search GitHub for `agent native observability`,
   `error monitoring ai agents`, `product analytics coding agents`,
   `mcp observability`, and `deploy attribution`. Confirm Agentry's description
   and README answer each relevant query accurately; indexing may not be
   immediate after launch.

## Branch and security settings

Create the `@agentry-sh/maintainers` team referenced by `.github/CODEOWNERS`, then
apply an organization ruleset to `main`:

- require a pull request, at least one approval, Code Owner review, dismissal of
  stale approvals, and resolution of all review conversations;
- require the `CI / verify` and `CodeQL / Analyze JavaScript and TypeScript`
  checks to pass and require the branch to be current before merge;
- require linear history and signed commits; block force pushes and branch
  deletion; do not grant the automation identity a bypass;
- limit direct pushes and ruleset bypass to the smallest reviewed maintainer
  group, while keeping emergency changes attributable and reviewable.

In repository and organization security settings, enable secret scanning and
push protection, dependency graph, Dependabot alerts and security updates,
CodeQL/code scanning, and private vulnerability reporting. Keep GitHub Actions'
default token read-only, allow write permissions only in explicitly reviewed
workflows, require approval for first-time external contributors, and prevent
Actions from creating or approving pull requests unless a specific workflow
has been reviewed for that authority.

## Public boundary

The public snapshot includes the product core and the material an engineer
needs to understand, run, test, review, and contribute to it:

- `apps/api`, `apps/auth`, and `apps/redirect`;
- `packages/db`, `packages/mcp`, and `packages/shared`;
- the Agentry plugin and agent adapters;
- repository workflows, product documentation, tests, and public release
  tooling;
- reviewed brand/demo assets and their third-party notices.

The snapshot excludes:

- outreach applications, prospect records, enrichment exports, email or social
  campaign state, and outreach-specific database code;
- customer data, production database files, provider exports, deployment
  scratch, onboarding proofs, generated evaluation runs, and credentials;
- internal status/history/decision diaries and launch-planning notes;
- the nested Toolcraft-derived UI source, whose upstream license does not permit
  relicensing as part of this public product;
- generated website source. GitHub Markdown is the presentation layer.

`public-boundary.json` is the reviewed allow/deny policy. Run:

```bash
node scripts/check-public-boundary.mjs
```

The default check covers both tracked files and unignored untracked files, so a
new file cannot silently bypass the allowlist. It rejects denied paths, unsafe
credential/database filenames, unreviewed symlinks, case-insensitive path
collisions, oversized files, and several high-confidence secret and personal
profile patterns. It never scans ignored local files.

The boundary check is a release gate, not a substitute for a dedicated secret
scanner. Run an independent full secret scan on the exported snapshot before
publishing it, and review every policy exception in `public-boundary.json`.

## Preserve private local state

Never copy the working directory wholesale. This checkout intentionally
contains ignored local credentials and runtime artifacts such as `.dev.vars`,
`.env*`, `.wrangler`, `.turso`, `docs/agent-recovery-runs`, generated onboarding
runs, audit output, and `tmp`. They must remain local and must not be deleted as
part of this migration.

Use Git's reviewed snapshot, not `rsync`, Finder, or a recursive copy. The
public-boundary check obtains its candidates from the Git index plus unignored
new files for the same reason.

## Create the fresh public history

Do not add the new organization repository as a remote of this checkout. Its
existing history contains excluded source and historical prospect artifacts;
deleting them in a later commit does not remove them from Git history.

After all migration changes have been reviewed and committed on the private
preparation branch:

1. Confirm the worktree is clean and run the boundary check and the complete
   test suite in this repository.
2. Create an empty sibling directory outside this checkout.
3. Export only the reviewed commit snapshot:

   ```bash
   mkdir ../agentry-public-snapshot
   git archive --format=tar HEAD | tar -x -C ../agentry-public-snapshot
   ```

4. Initialize a new repository and stage that snapshot locally:

   ```bash
   cd ../agentry-public-snapshot
   git init -b main
   git add .
   node scripts/check-public-boundary.mjs --tracked-only
   ```

5. Install from the lockfile, run all public build/typecheck/test gates, inspect
   license attribution, and run an independent secret scanner. Review the staged
   file list and largest files manually.
6. Create one clean initial commit. Only then create the empty repository under
   the Agentry organization, add that repository as this new checkout's remote,
   and push `main`.
7. Enable branch protection, required checks, secret scanning, dependency
   alerts, private-vulnerability reporting, Discussions if desired, and the
   issue/PR templates before announcing the repository.

Apache source publication may proceed independently, but hosted commercial
launch is blocked until qualified counsel reviews `TERMS.md` and `PRIVACY.md`
and the documents identify the actual legal operator/controller. That review
must cover contact details, effective dates, California venue, data processors,
retention claims, and the separation between hosted-service terms and
Apache-licensed source rights. Verify the README and `PRICING.md` against the
live checkout configuration at the same time.

The public initial commit must have no parent from this repository. Verify with
`git rev-list --max-parents=0 --all` in the public checkout: before any later
merges, it should report exactly the intended new root commit.

## Domain cutover

1. Deploy and verify `api.agentry.sh` and `auth.agentry.sh` without changing
   their DNS behavior.
2. Deploy the minimal redirect worker for the apex only. It should send
   `agentry.sh` requests to `https://github.com/agentry-sh/agentry` without
   intercepting service subdomains.
3. Check the one-flow PostHog sign-in/callback, invitation and billing callbacks, API discovery,
   OpenAPI, and agent installation end to end.
4. Update external profiles, package metadata, repository topics, and release
   links to the GitHub canonical URL.
5. Confirm no maintained guide depends on `agentry.sh/install.md`,
   `agentry.sh/agentry.md`, or the retired Astro site. Old public paths may
   redirect to the corresponding GitHub Markdown file, but repository Markdown
   is the only authored source.

## Final release gate

- The boundary checker passes in both the private preparation checkout and the
  fresh public checkout.
- The public repository has one new root history and no private remote or
  private commit objects.
- Apache-2.0 and all third-party attributions match every shipped source and
  asset.
- No outreach corpus, Toolcraft source, production state, secret, or ignored
  artifact appears in the staged snapshot.
- Public install, API, PostHog sign-in/OAuth, MCP/plugin, redirect, and workflow
  checks pass from a clean clone.
- Only the apex domain redirects; required subdomains remain operational.
