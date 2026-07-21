#!/usr/bin/env node
// Normalize public workflow examples so they teach endpoint/query concepts
// without looking like copyable Agentry API payloads.

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listWorkflowFiles } from "./lib/workflow-files.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const checkOnly = process.argv.includes("--check");

const requestOpenRe =
  /^(\s*)(GET|POST|PUT|PATCH|DELETE)\s+(\/v1\/[^\s{]+)\s*\{\s*$/;
const requestInlineRe =
  /^(\s*)(GET|POST|PUT|PATCH|DELETE)\s+(\/v1\/[^\s{]+)\s*\{\s*(.*?)\s*\}\s*$/;

function countBraces(line) {
  let depth = 0;
  for (const char of line) {
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
  }
  return depth;
}

function schemaPathFor(path) {
  const barePath = path.split("?")[0];
  const canonicalPath = barePath
    .replace(/\/query-blueprints\/[^/]+\/run$/, "/query-blueprints/{blueprint_id}/run")
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
  return `/v1/openapi.json?path=${encodeURIComponent(canonicalPath)}&method=`;
}

function extractField(lines, field) {
  const re = new RegExp(`^\\s*${field}\\s*:\\s*["']([^"']+)["']\\s*,?\\s*$`);
  for (const line of lines) {
    const match = line.match(re);
    if (match) return match[1];
  }
  return null;
}

function cleanConceptLines(method, path, lines) {
  const drop = [/^\s*project_id\s*:\s*["']default["']\s*,?\s*$/];
  if (/\/query-blueprints\/:blueprint_id\/run\b/.test(path)) {
    drop.push(/^\s*blueprint_id\s*:\s*["'][^"']+["']\s*,?\s*$/);
  }

  const cleaned = lines
    .filter((line) => !drop.some((re) => re.test(line)))
    .map((line) => line.replace(/\s+$/, ""));

  while (cleaned.length > 0 && cleaned[0].trim() === "") cleaned.shift();
  while (cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === "") cleaned.pop();

  if (method === "GET") {
    return cleaned.filter((line) => !/^\s*[A-Za-z_][A-Za-z0-9_]*_id\s*:/.test(line));
  }
  return cleaned;
}

function renderRequestSketch(method, path, rawLines, prefix = "") {
  const lines = cleanConceptLines(method, path, rawLines);
  const schemaUrl = `${schemaPathFor(path)}${method.toLowerCase()}`;
  const sketch = [`${prefix}Endpoint: ${method} ${path}`, `${prefix}Exact shape: ${schemaUrl}`];

  const blueprintId = extractField(rawLines, "blueprint_id");
  if (blueprintId) {
    sketch.push(`${prefix}Blueprint: ${blueprintId}`);
  }

  if (/\/analytics\/query\b/.test(path)) {
    sketch.push(`${prefix}Custom HogQL goes in the OpenAPI-defined \`query\` field.`);
  } else if (/\/query-blueprints\//.test(path)) {
    sketch.push(`${prefix}Fetch GET /v1/query-blueprints${blueprintId ? `/${blueprintId}` : "/:blueprint_id"} for the allowed params before running it.`);
  } else if (/\/public-queries\b/.test(path)) {
    sketch.push(`${prefix}Publish only real query-blueprint results; use Agentry's returned \`public_url\`.`);
  } else if (method === "GET") {
    sketch.push(`${prefix}Use query parameters, not a JSON body.`);
  }

  if (lines.length > 0) {
    sketch.push(`${prefix}${method === "GET" ? "Query/filter concept:" : "Concept fields:"}`);
    sketch.push(...lines.map((line) => `${prefix}${line}`));
  }

  return sketch;
}

function normalizeFenceBody(body) {
  const lines = body.split("\n");
  const out = [];

  for (let index = 0; index < lines.length; index += 1) {
    const inline = lines[index].match(requestInlineRe);
    if (inline) {
      const [, prefix, method, path, rawBody] = inline;
      const rawLines = rawBody
        .split(",")
        .map((part) => `${prefix}  ${part.trim()}`)
        .filter((line) => line.trim() !== "");
      out.push(...renderRequestSketch(method, path, rawLines, prefix));
      continue;
    }

    const open = lines[index].match(requestOpenRe);
    if (!open) {
      out.push(lines[index]);
      continue;
    }

    const [, prefix, method, path] = open;
    const requestLines = [];
    let depth = 1;
    let cursor = index + 1;

    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      depth += countBraces(line);
      if (depth <= 0 && line.trim() === "}") break;
      requestLines.push(line);
    }

    out.push(...renderRequestSketch(method, path, requestLines, prefix));
    index = cursor;
  }

  return out.join("\n");
}

function normalizeMarkdown(text) {
  let next = text.replace(
    /```([A-Za-z0-9_-]*)\n([\s\S]*?)```/g,
    (match, lang, body) => {
      if (lang && !["text", "http"].includes(lang)) return match;
      return `\`\`\`${lang}\n${normalizeFenceBody(body)}\`\`\``;
    },
  );

  next = next.replace(
    /(^|\s)https:\/\/api\.agentry\.sh\/v1\/public\/q\/pub[A-Za-z0-9_]+/g,
    "$1PUBLIC_URL_FROM_AGENTRY",
  );
  next = next.replace(
    /api\.agentry\.sh\/v1\/public\/q\/pub[A-Za-z0-9_]+/g,
    "api.agentry.sh/v1/public/q/<publication_id>",
  );
  next = next.replace(/"id": "pub_[A-Za-z0-9_]+"/g, '"id": "<publication_id>"');
  next = next.replace(
    /Public dashboard:\n  PUBLIC_URL_FROM_AGENTRY/g,
    "Public view:\n  Use Agentry's returned public_url after publishing a real query blueprint.",
  );
  next = next.replace(
    /Optional published view, when explicitly requested:\n  PUBLIC_URL_FROM_AGENTRY/g,
    "Optional published view, when explicitly requested:\n  Use Agentry's returned public_url after publishing the approved blueprint.",
  );
  next = next.replace(
    /> Live dashboard: PUBLIC_URL_FROM_AGENTRY/g,
    "> No public dashboard URL yet; add a real query blueprint for this custom analysis before publishing.",
  );
  next = next.replace(
    /A live dashboard at `api\.agentry\.sh\/v1\/public\/q\/<publication_id>` that updates as data flows in:/g,
    "A protected/internal results view until this custom analysis has a real query blueprint:",
  );

  next = next.replace(
    /(GET\s+\/v1\/[^\s`{]+)\s*\{\s*project_id:\s*["']default["']\s*,?\s*([^}]*?)\s*\}/g,
    (_match, endpoint, params) => {
      const cleanParams = params.trim();
      return cleanParams
        ? `${endpoint} (query params: ${cleanParams})`
        : `${endpoint} (path parameter only)`;
    },
  );

  return next;
}

const changed = [];
for (const path of listWorkflowFiles()) {
  const file = basename(path);
  const before = readFileSync(path, "utf8");
  const after = normalizeMarkdown(before);
  if (after !== before) {
    changed.push(basename(file));
    if (!checkOnly) writeFileSync(path, after);
  }
}

if (changed.length > 0) {
  const message = `normalize-workflow-examples: ${changed.length} file(s) ${checkOnly ? "need normalization" : "normalized"}`;
  if (checkOnly) {
    console.error(message);
    for (const file of changed) console.error(`- ${file}`);
    process.exit(1);
  }
  console.log(message);
  for (const file of changed) console.log(`- ${file}`);
} else {
  console.log("normalize-workflow-examples: all workflow examples are normalized");
}
