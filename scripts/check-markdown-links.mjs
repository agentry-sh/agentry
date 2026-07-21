#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const boundary = JSON.parse(readFileSync(resolve(repositoryRoot, "public-boundary.json"), "utf8"));

const allowedFiles = new Set(boundary.allowedFiles);
const allowedPrefixes = boundary.allowedPrefixes;
const deniedFiles = new Set(boundary.deniedFiles);
const deniedPrefixes = boundary.deniedPrefixes;
const deniedPatterns = boundary.deniedPathRegexes.map(({ pattern, flags = "u", unlessSuffixes = [] }) => ({
  pattern: new RegExp(pattern, flags),
  unlessSuffixes,
}));

function isPublicPath(path) {
  if (deniedFiles.has(path) || deniedPrefixes.some((prefix) => path.startsWith(prefix))) return false;
  if (deniedPatterns.some(({ pattern, unlessSuffixes }) =>
    !unlessSuffixes.some((suffix) => path.endsWith(suffix)) && pattern.test(path))) return false;
  return allowedFiles.has(path) || allowedPrefixes.some((prefix) => path.startsWith(prefix));
}

function listCandidates() {
  return execFileSync(
    "git",
    ["-c", "core.quotepath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
  ).split("\0").filter(Boolean);
}

function blank(value) {
  return value.replace(/[^\r\n]/g, " ");
}

function maskInlineCode(line) {
  const characters = line.split("");
  for (let index = 0; index < characters.length;) {
    if (characters[index] !== "`") {
      index += 1;
      continue;
    }
    let runLength = 1;
    while (characters[index + runLength] === "`") runLength += 1;
    const delimiter = "`".repeat(runLength);
    const close = line.indexOf(delimiter, index + runLength);
    if (close === -1) {
      index += runLength;
      continue;
    }
    characters.fill(" ", index, close + runLength);
    index = close + runLength;
  }
  return characters.join("");
}

function maskCodeAndComments(text) {
  let fence = null;
  const masked = text.split(/(?<=\n)/u).map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (fence) {
      const closes = marker?.[0] === fence.character
        && marker.length >= fence.length
        && new RegExp(`^ {0,3}${fence.character}{${fence.length},}\\s*$`, "u").test(line.trimEnd());
      if (closes) fence = null;
      return blank(line);
    }
    if (marker) {
      fence = { character: marker[0], length: marker.length };
      return blank(line);
    }
    return maskInlineCode(line);
  }).join("");
  return masked.replace(/<!--[\s\S]*?-->/gu, (comment) => blank(comment));
}

function escapedAt(text, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function hasLinkLabel(text, closeIndex) {
  let nested = 0;
  for (let index = closeIndex - 1; index >= 0 && text[index] !== "\n"; index -= 1) {
    if (escapedAt(text, index)) continue;
    if (text[index] === "]") nested += 1;
    if (text[index] === "[") {
      if (nested === 0) return true;
      nested -= 1;
    }
  }
  return false;
}

function markdownDestinations(text) {
  const destinations = [];
  for (let close = text.indexOf("]("); close !== -1; close = text.indexOf("](", close + 2)) {
    if (escapedAt(text, close) || !hasLinkLabel(text, close)) continue;
    let cursor = close + 2;
    while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
    const offset = cursor;
    if (text[cursor] === "<") {
      const end = text.indexOf(">", cursor + 1);
      if (end !== -1 && !text.slice(cursor + 1, end).includes("\n")) {
        destinations.push({ raw: text.slice(cursor + 1, end), offset: cursor + 1 });
      }
      continue;
    }
    let depth = 0;
    while (cursor < text.length) {
      const character = text[cursor];
      if (character === "\\") {
        cursor += 2;
        continue;
      }
      if (character === "(") depth += 1;
      else if (character === ")") {
        if (depth === 0) break;
        depth -= 1;
      } else if (/\s/u.test(character) && depth === 0) break;
      cursor += 1;
    }
    if (cursor > offset) destinations.push({ raw: text.slice(offset, cursor), offset });
  }

  const definition = /^ {0,3}\[[^\]\n]+\]:[ \t]*(?:<([^>\n]+)>|(\S+))/gmu;
  for (const match of text.matchAll(definition)) {
    const raw = match[1] ?? match[2];
    destinations.push({ raw, offset: match.index + match[0].indexOf(raw) });
  }
  return destinations;
}

function htmlDestinations(text) {
  const destinations = [];
  for (const tag of text.matchAll(/<[A-Za-z][^>]*>/gu)) {
    const attributes = tag[0];
    const pattern = /\b(src|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu;
    for (const attribute of attributes.matchAll(pattern)) {
      const name = attribute[1].toLowerCase();
      const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
      const valueOffset = tag.index + attribute.index + attribute[0].indexOf(value);
      if (name === "src") {
        destinations.push({ raw: value, offset: valueOffset });
      } else if (!value.trim().toLowerCase().startsWith("data:")) {
        let searchFrom = 0;
        for (const candidate of value.split(",")) {
          const raw = candidate.trim().split(/\s+/u, 1)[0];
          if (raw) {
            const relativeOffset = value.indexOf(raw, searchFrom);
            destinations.push({ raw, offset: valueOffset + relativeOffset });
            searchFrom = relativeOffset + raw.length;
          }
        }
      }
    }
  }
  return destinations;
}

function normalizeLocalTarget(raw) {
  let value = raw.trim().replaceAll("&amp;", "&");
  if (!value || value.startsWith("#") || value.startsWith("?") || value.startsWith("//") || value.startsWith("/")) {
    return null;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return null;
  const separator = value.search(/[?#]/u);
  if (separator !== -1) value = value.slice(0, separator);
  if (!value) return null;
  try {
    value = decodeURIComponent(value);
  } catch {
    return { error: `has invalid percent encoding: ${JSON.stringify(raw)}` };
  }
  value = value.replace(/\\(.)/gu, "$1");
  if (value.includes("\0")) return { error: `contains a NUL byte: ${JSON.stringify(raw)}` };
  return { value };
}

function exactPathExists(absolutePath) {
  if (!existsSync(absolutePath)) return false;
  let current = repositoryRoot;
  for (const segment of relative(repositoryRoot, absolutePath).split(sep).filter(Boolean)) {
    if (!readdirSync(current).includes(segment)) return false;
    current = resolve(current, segment);
  }
  return true;
}

function lineNumber(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

const candidates = listCandidates();
const candidateSet = new Set(candidates);
const publicCandidates = candidates.filter(isPublicPath);
const markdownFiles = publicCandidates.filter((path) =>
  /\.(?:md|markdown)$/iu.test(path)
  && existsSync(resolve(repositoryRoot, path))
  && lstatSync(resolve(repositoryRoot, path)).isFile());
const publicDirectories = new Set([""]);
for (const path of publicCandidates) {
  let directory = dirname(path).replaceAll("\\", "/");
  while (directory !== "." && !publicDirectories.has(directory)) {
    publicDirectories.add(directory);
    directory = dirname(directory).replaceAll("\\", "/");
  }
}

const errors = [];
let checkedLinks = 0;
for (const markdownPath of markdownFiles) {
  const text = readFileSync(resolve(repositoryRoot, markdownPath), "utf8");
  const masked = maskCodeAndComments(text);
  for (const destination of [...markdownDestinations(masked), ...htmlDestinations(masked)]) {
    const target = normalizeLocalTarget(destination.raw);
    if (!target) continue;
    checkedLinks += 1;
    if (target.error) {
      errors.push(`${markdownPath}:${lineNumber(text, destination.offset)}: ${target.error}`);
      continue;
    }
    const absoluteTarget = resolve(repositoryRoot, dirname(markdownPath), target.value);
    const relativeTarget = relative(repositoryRoot, absoluteTarget).split(sep).join("/");
    if (isAbsolute(relativeTarget) || relativeTarget === ".." || relativeTarget.startsWith("../")) {
      errors.push(`${markdownPath}:${lineNumber(text, destination.offset)}: ${JSON.stringify(destination.raw)} escapes the repository`);
      continue;
    }
    if (!exactPathExists(absoluteTarget)) {
      errors.push(`${markdownPath}:${lineNumber(text, destination.offset)}: missing local target ${JSON.stringify(destination.raw)}`);
      continue;
    }
    const stats = lstatSync(absoluteTarget);
    const publishable = stats.isDirectory()
      ? publicDirectories.has(relativeTarget)
      : candidateSet.has(relativeTarget) && isPublicPath(relativeTarget);
    if (!publishable) {
      errors.push(`${markdownPath}:${lineNumber(text, destination.offset)}: target is outside the public candidate set: ${JSON.stringify(destination.raw)}`);
    }
  }
}

if (errors.length > 0) {
  console.error(`check-markdown-links: ${errors.length} problem(s)`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`check-markdown-links: ${checkedLinks} local links across ${markdownFiles.length} public Markdown files`);
