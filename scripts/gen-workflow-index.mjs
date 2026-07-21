#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, relative } from "node:path";
import {
  REPO_ROOT,
  WORKFLOWS_DIR,
  listWorkflowFiles,
  parseWorkflowMarkdown,
} from "./lib/workflow-files.mjs";

const checkOnly = process.argv.includes("--check");

const categories = {
  debugging: {
    title: "Debugging and reliability",
    description: "Error monitoring, deploy regressions, source maps, incidents, latency, and release health.",
  },
  growth: {
    title: "Growth and product analytics",
    description: "Funnels, activation, adoption, conversion, retention, revenue, and experiments.",
  },
  operations: {
    title: "Operations and recurring reviews",
    description: "Alerts, audit, account reviews, automations, webhooks, queues, and scheduled evidence.",
  },
};

const entries = listWorkflowFiles().map((path) => {
  const parsed = parseWorkflowMarkdown(readFileSync(path, "utf8"));
  const category = relative(WORKFLOWS_DIR, dirname(path)).split(/[\\/]/)[0];
  if (!categories[category]) throw new Error(`${path}: unsupported category directory ${category}`);
  return {
    category,
    file: basename(path),
    title: String(parsed.data.title ?? "").trim(),
    description: String(parsed.data.description ?? "").trim(),
    difficulty: String(parsed.data.difficulty ?? "").trim(),
    tags: Array.isArray(parsed.data.tags) ? parsed.data.tags.map(String) : [],
    featured: parsed.data.featured === true,
  };
}).sort((a, b) => a.title.localeCompare(b.title));

function writeOrCheck(path, body) {
  const normalized = `${body.trimEnd()}\n`;
  if (checkOnly) {
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (current !== normalized) {
      console.error(`gen-workflow-index: stale ${relative(REPO_ROOT, path)}`);
      process.exitCode = 1;
    }
    return;
  }
  writeFileSync(path, normalized);
}

const categoryCounts = Object.fromEntries(
  Object.keys(categories).map((key) => [key, entries.filter((entry) => entry.category === key).length]),
);

const rootLines = [
  "# Agentry workflows",
  "",
  `This directory contains ${entries.length} GitHub-native examples for using coding agents with error monitoring, product analytics, and deploy attribution. Each workflow is reviewable Markdown and links to the exact Agentry HTTP concepts it uses.`,
  "",
  "> [!IMPORTANT]",
  "> Workflows are adaptation material, not executable API recipes. Before running one, verify the project's onboarding receipt, signal map, live event names, and property keys. Fetch the filtered OpenAPI operation before making a call.",
  "",
  "## Collections",
  "",
  "| Collection | Workflows | Focus |",
  "| --- | ---: | --- |",
  ...Object.entries(categories).map(([key, category]) =>
    `| [${category.title}](./${key}) | ${categoryCounts[key]} | ${category.description} |`
  ),
  "",
  "## Featured starting points",
  "",
  ...entries.filter((entry) => entry.featured).map((entry) =>
    `- [${entry.title}](./${entry.category}/${entry.file}) — ${entry.description}`
  ),
  "",
  "## Find the right workflow",
  "",
  "Use GitHub repository search with `path:workflows` and the question or technology you care about. Examples:",
  "",
  "```text",
  "path:workflows deploy regression",
  "path:workflows signup funnel",
  "path:workflows stripe payment",
  "path:workflows webhook reliability",
  "```",
  "",
  "To add or revise a workflow, read [the authoring guide](./CONTRIBUTING.md) and the scoped [agent instructions](./AGENTS.md).",
];

writeOrCheck(`${WORKFLOWS_DIR}/README.md`, rootLines.join("\n"));

for (const [key, category] of Object.entries(categories)) {
  const categoryEntries = entries.filter((entry) => entry.category === key);
  const lines = [
    `# ${category.title}`,
    "",
    category.description,
    "",
    `[← All workflows](../README.md) · ${categoryEntries.length} examples`,
    "",
    "| Workflow | Difficulty | Tags |",
    "| --- | --- | --- |",
    ...categoryEntries.map((entry) =>
      `| [${entry.title}](./${entry.file})<br>${entry.description} | ${entry.difficulty || "—"} | ${entry.tags.map((tag) => `\`${tag}\``).join(" ")} |`
    ),
  ];
  writeOrCheck(`${WORKFLOWS_DIR}/${key}/README.md`, lines.join("\n"));
}

if (!process.exitCode) {
  console.log(`gen-workflow-index: ${entries.length} workflows indexed`);
}
