#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import {
  listWorkflowFiles,
  parseWorkflowMarkdown,
  workflowRelativePath,
} from "./lib/workflow-files.mjs";

const checkOnly = process.argv.includes("--check");
const MAX_LINE = 88;

function wrapParagraph(value) {
  const words = String(value).trim().replace(/\s+/g, " ").split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line && `${line} ${word}`.length > MAX_LINE) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

function formatWorkflow(text, label) {
  const parsed = parseWorkflowMarkdown(text);
  const title = String(parsed.data.title ?? "").trim();
  const description = wrapParagraph(parsed.data.description ?? "");
  if (!title || !description || !parsed.metadata) {
    throw new Error(`${label}: title, description, and workflow metadata are required`);
  }

  const heading = `# ${title}`;
  let body = parsed.content.trim();
  if (!body.startsWith(`${heading}\n`) && body !== heading) {
    throw new Error(`${label}: body H1 does not match metadata title`);
  }
  body = body.slice(heading.length).trimStart();
  if (parsed.format === "embedded" && body.startsWith(description)) {
    body = body.slice(description.length).trimStart();
  }

  return [
    heading,
    "",
    description,
    "",
    "<details data-agentry-workflow-metadata>",
    "<summary>Workflow metadata</summary>",
    "",
    "```yaml",
    parsed.metadata.trim(),
    "```",
    "",
    "</details>",
    "",
    body,
    "",
  ].join("\n");
}

let stale = 0;
for (const file of listWorkflowFiles()) {
  const label = workflowRelativePath(file);
  const current = readFileSync(file, "utf8");
  const formatted = formatWorkflow(current, label);
  if (formatted === current) continue;
  stale += 1;
  if (checkOnly) console.error(`format-workflow-markdown: stale ${label}`);
  else writeFileSync(file, formatted);
}

if (checkOnly && stale > 0) process.exitCode = 1;
else console.log(`format-workflow-markdown: ${stale || "all"} workflow file(s) ${checkOnly ? "canonical" : "formatted"}`);
