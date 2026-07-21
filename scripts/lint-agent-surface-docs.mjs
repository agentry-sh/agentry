#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  listWorkflowFiles,
  parseWorkflowMarkdown,
  workflowRelativePath,
} from "./lib/workflow-files.mjs";

const RAW_ROOT = "https://raw.githubusercontent.com/agentry-sh/agentry/main";
const activeFiles = [
  "README.md",
  "INSTALL.md",
  "AGENTRY.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "PRIVACY.md",
  "TERMS.md",
  "SELF_HOSTING.md",
  "workflows/README.md",
  "workflows/AGENTS.md",
  "workflows/CONTRIBUTING.md",
  "plugins/agentry/README.md",
  "plugins/agentry/skills/agentry/SKILL.md",
  "packages/mcp/README.md",
];

const errors = [];

for (const file of activeFiles) {
  if (!existsSync(file)) {
    errors.push(`${file}: required public document is missing`);
    continue;
  }
  const text = readFileSync(file, "utf8");
  for (const [pattern, message] of [
    [/https:\/\/agentry\.sh\/(?:install\.md|agentry\.md|skill\/agentry\/SKILL\.md)/i, "points at a retired website document instead of GitHub"],
    [/fr33dr4g0n\/(?:agentry-public|agentry-skill)/i, "points at a retired personal repository"],
    [/agentry-private/i, "names the private repository"],
    [/apps\/web\/src\/content\/workflows/i, "names the retired Astro workflow directory"],
    [/AGENTRY_DSN|\.agentry\/config\.json/i, "contains a retired credential contract"],
  ]) {
    if (pattern.test(text)) errors.push(`${file}: ${message}`);
  }
}

const readme = readFileSync("README.md", "utf8");
if (!readme.includes(`${RAW_ROOT}/INSTALL.md`)) {
  errors.push("README.md: install prompt must use the raw GitHub INSTALL.md URL");
}
for (const phrase of [
  "open-source error monitoring",
  "product analytics",
  "deploy attribution",
  "coding agents",
  "Apache License 2.0",
]) {
  if (!readme.toLowerCase().includes(phrase.toLowerCase())) {
    errors.push(`README.md: missing discoverability phrase ${JSON.stringify(phrase)}`);
  }
}

const install = readFileSync("INSTALL.md", "utf8");
if (install.split(/\r?\n/).length >= 230 || Buffer.byteLength(install) >= 32 * 1024) {
  errors.push("INSTALL.md: install contract exceeded the bounded agent context budget");
}

const reference = readFileSync("AGENTRY.md", "utf8");
if (reference.split(/\r?\n/).length >= 250 || Buffer.byteLength(reference) >= 16 * 1024) {
  errors.push("AGENTRY.md: resident agent reference exceeded the context budget");
}

const workflowFiles = listWorkflowFiles();
if (workflowFiles.length !== 86) {
  errors.push(`workflows: expected 86 canonical examples, found ${workflowFiles.length}`);
}
for (const file of workflowFiles) {
  const text = readFileSync(file, "utf8");
  const parsed = parseWorkflowMarkdown(text);
  const title = String(parsed.data.title ?? "").trim();
  const description = String(parsed.data.description ?? "").trim().replace(/\s+/g, " ");
  const relativePath = workflowRelativePath(file);
  const expectedDirectory = parsed.data.category === "ops"
    ? "operations"
    : String(parsed.data.category ?? "");
  if (!relativePath.startsWith(`workflows/${expectedDirectory}/`)) {
    errors.push(`${relativePath}: category metadata does not match its directory`);
  }
  if (parsed.format !== "embedded") {
    errors.push(`${relativePath}: workflow metadata must use the collapsed GitHub-native block`);
  }
  if (!title || !text.startsWith(`# ${title}\n`)) {
    errors.push(`${relativePath}: GitHub-visible H1 must be first and exactly match metadata title`);
  }
  const beforeMetadata = text.split("<details data-agentry-workflow-metadata>", 1)[0];
  const visibleIntro = beforeMetadata.trim().replace(/\s+/g, " ");
  if (!description || !visibleIntro.includes(description)) {
    errors.push(`${relativePath}: metadata description must be visible before the collapsed metadata`);
  }
  if (basename(file) === "README.md") {
    errors.push(`${relativePath}: generated indexes must not be parsed as workflows`);
  }
}

if (errors.length > 0) {
  console.error(`lint-agent-surface-docs: ${errors.length} problem(s)`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`lint-agent-surface-docs: ${activeFiles.length} public docs and ${workflowFiles.length} workflows checked`);
