# Workflow example authoring guide

This is the practical checklist for adding a workflow example under
`workflows/debugging/`, `workflows/growth/`, or `workflows/operations/`. These
pages are public repository docs and answer-contract source material only.

They are not API recipe endpoints, not executable API calls, and not a catalog
that agents should "run." Day-to-day agent execution uses query
blueprints, custom HogQL through `POST /v1/projects/:id/analytics/query`, cases,
deploys, and the saved signal map.

## Goal

A workflow example has two audiences:

1. An agent uses it as retrieval and adaptation material: recognize the user's
   intent, reject a bad fit, ask for missing context, and map the request to
   verified Agentry resources.
2. A human uses it to understand the business decision, evidence, authority
   boundary, output, and practical setup.

It is not a pasteable workflow. The compact entry must be enough to decide
whether the example is relevant; the full page must contain events, properties,
real HTTP routes, negative-fit notes, and questions the agent must resolve from
the saved signal map before claiming anything is answerable.

## Catalog admission gate

Keep a page only when all of these are true:

- It answers a distinct business or engineering decision, not merely a narrow
  query variation that belongs under another page's `Variations` section.
- Agentry can provide the required evidence from its real error, analytics,
  deploy, public-query, audit, or versioned automation surfaces.
- The page does not position Agentry as uptime monitoring, infrastructure APM,
  a production feature-flag runtime, an outbound messaging system, or an
  autonomous coding authority.
- The page states what the evidence cannot prove and which human decision or
  safe next action follows.
- Its title describes the outcome without a speed promise, causal claim,
  unsupported benchmark, or automatic side effect.

Merge near-duplicates into one canonical intent. Remove a page when its value
depends on a capability Agentry does not have or when adapting it safely would
produce the same workflow as an existing page.

## File checklist

- Filename is the stable workflow-example id: `kebab-case.md`.
- The collapsed workflow metadata passes `node scripts/lint-workflow-references.mjs`.
- `category` is exactly one of `debugging`, `growth`, or `ops`.
- `tags` are concrete discovery terms. Include one signal tag such as
  `analytics`, `errors`, or `deploys`, then domain tags such as `marketing`,
  `engineering`, `customer-success`, `revenue`, `product`, `webhooks`, or
  `onboarding`.
- `required_events` and `required_event_properties` are planning anchors; body
  examples should explain how to map them to live app signals.
- `negative_fit` and `ask_if_missing` are required, non-empty adaptation
  contracts. They must be specific enough to stop a plausible but wrong
  recommendation.
- `related` points to real workflow-example slugs in this collection.
- No invented Agentry SDK imports or fake `agentry_*` calls. Use raw HTTP,
  curl, or documented OpenAPI operations.
- Add `example_only: true` when the page contains illustrative query shapes that
  are not backed by query blueprint IDs in `apps/api/src/query-blueprint-catalog.ts`.

## GitHub-native page and metadata shape

The title and description must come first so the page works as a useful GitHub
search result. Put planner metadata immediately after them in the canonical
collapsed block; do not add YAML frontmatter above the H1.

````markdown
# Short action-oriented title

One sentence explaining the outcome and audience.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: "Short action-oriented title"
description: "One sentence explaining the outcome and audience."
category: growth
tags:
  - analytics
  - marketing
  - activation
prompt: "Starter request written from the user's perspective; agents adapt it."
difficulty: beginner
time_to_value: "5 minutes"
prereqs:
  - "Human-readable data prerequisite"
applies_to:
  - b2b-saas
required_events:
  - signup_completed
readiness_events:
  - signup_completed
required_event_properties:
  signup_completed:
    - plan
negative_fit:
  - "Avoid until signup events exist or can be mapped to equivalent live events."
ask_if_missing:
  - "Which live event represents signup completion?"
example_only: false
related:
  - signup-funnel
publishedAt: 2026-05-26
```

</details>
````

Use `requires_revenue`, `requires_b2b`, and `requires_two_sided` when a workflow
example should only be considered for those product shapes. These fields help
the planner decide which answer-contract candidates fit a project; verify checks
the approved events/properties from the saved signal map, not whether a
workflow example was selected.

## Page format

On-demand analysis examples use this section order:

````markdown
## Why this matters

Explain the business or engineering problem in one or two short paragraphs.

## What you get

- Concrete output 1
- Concrete output 2
- Concrete output 3

## Walk through it

**You:**
> Ask the thing a real user would ask.

**Agent:**
> Explain the next action briefly.

```http
GET /v1/projects/:project_id/event-names
```

```json
{
  "server_emitted": [],
  "analytics_events": [
    { "event": "signup_completed", "count": 12, "last_seen": "2026-06-20T00:00:00.000Z" }
  ],
  "wildcards": [],
  "next_action": "Use these observed event names when adapting the workflow to this project."
}
```

## The output

Describe the final answer shape and how the agent should interpret it.

## Setting it up

Name the exact events/properties to emit or the Agentry feature that must be
configured. Keep this operational, not promotional.

## Variations

- *"Natural-language variant one."*
- *"Natural-language variant two."*
- *"Natural-language variant three."*
````

Use `http` for concrete HTTP examples and `text` for mocked results. Do not use
`tool` or `tool-result` fences; `npm run lint` rejects them.

`human_review` and `automation_template` pages may use a purpose-built section
order when the approval, authority, run, verification, and stop boundaries are
clearer than the on-demand conversation format. Versioned automation pages must
start from their immutable machine template and explain that rendering and
saving leave the candidate disabled.

## Discovery metadata

Agents can search the repository and generated manifest by `category`, `tag`,
`audience`, `shape`, and starter-prompt terms. Write tags intentionally:

- `category` answers broad intent: debugging, growth, or ops.
- `tag` answers exact domains: `marketing`, `engineering`, `revenue`,
  `customer-success`, `product`, `webhooks`, `checkout`, etc.
- `audience` is inferred by the API from category, tags, app shapes,
  and title/description text. Use clear domain tags so this inference remains
  useful.
- `applies_to` lets planning choose relevant answer-contract candidates for the
  detected product shape.

The compact manifest includes the starter request as an adaptation seed but
never includes an executable query body. Put enough signal in title,
description, category, tags, app shape, execution mode, negative fit, and
questions for an agent to decide whether the example belongs in the install
answer-contract candidate set.

## Human and agent distribution

The Markdown files below `workflows/` are the source of truth. GitHub renders
each file for humans and exposes the same source to coding agents. Generated
`README.md` indexes provide category navigation, while the API's generated
manifest provides compact discovery metadata.

Keep versioned executable automation templates in the API catalog; do not copy
their mutable-looking JSON into repository prose.

## Validation

After adding or editing workflows, run:

```bash
node scripts/gen-workflow-manifest.mjs
node scripts/gen-workflow-manifest.mjs --check
node scripts/format-workflow-markdown.mjs --check
node scripts/gen-workflow-index.mjs --check
node scripts/lint-workflow-references.mjs
```

Also run focused planner/answer-contract tests when changing discovery code:

```bash
npm run test:onboarding:release
```

## Review pass

Before committing, read the workflow example as an agent would:

- Can the compact card reveal who it is for?
- Does the full page name the required events and properties?
- Does it say when the example is a bad fit and what must be asked first?
- Are the HTTP calls real and useful?
- Does the output say what decision the agent should help the user make?
- Does the page avoid causal, benchmark, identity, or mutation claims that the
  returned evidence cannot support?
- Does the example still make sense when treated as docs/source material rather
  than a script or API endpoint?
