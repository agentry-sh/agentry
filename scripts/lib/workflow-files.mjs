import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, "..", "..");
export const WORKFLOWS_DIR = join(REPO_ROOT, "workflows");

const RESERVED_FILES = new Set([
  "README.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
]);

export function listWorkflowFiles() {
  const files = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".md") && !RESERVED_FILES.has(entry.name)) {
        files.push(path);
      }
    }
  }

  visit(WORKFLOWS_DIR);
  return files.sort((a, b) => a.localeCompare(b));
}

export function workflowRelativePath(path) {
  return relative(REPO_ROOT, path).replaceAll("\\", "/");
}

const EMBEDDED_METADATA = /<details data-agentry-workflow-metadata>\s*\n<summary>Workflow metadata<\/summary>\s*\n+```yaml\n([\s\S]*?)\n```\s*\n<\/details>\s*/;

/**
 * Parse both legacy leading frontmatter and the GitHub-native format.
 *
 * GitHub renders leading YAML as a large table, so canonical workflow pages put
 * the H1 and outcome first and retain the same YAML in a collapsed details
 * block. Supporting the old form here keeps migration tooling deterministic.
 */
export function parseWorkflowMarkdown(text) {
  if (/^---\r?\n/.test(text)) {
    const parsed = matter(text);
    const metadata = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? "";
    return {
      data: parsed.data,
      content: parsed.content,
      metadata,
      format: "frontmatter",
    };
  }

  const embedded = text.match(EMBEDDED_METADATA);
  if (!embedded || embedded.index === undefined) {
    return { data: {}, content: text, metadata: "", format: "none" };
  }

  const metadata = embedded[1];
  const parsed = matter(`---\n${metadata}\n---\n`);
  const content = `${text.slice(0, embedded.index)}${text.slice(embedded.index + embedded[0].length)}`
    .replace(/\n{3,}/g, "\n\n");
  return {
    data: parsed.data,
    content,
    metadata,
    format: "embedded",
  };
}
