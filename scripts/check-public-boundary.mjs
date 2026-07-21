#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function usage() {
  return `Usage: node scripts/check-public-boundary.mjs [--tracked-only] [--manifest PATH]

Checks every tracked file plus every unignored, untracked file by default. Use
--tracked-only for a committed export or CI checkout. Deny rules always win over
the public allowlist.
`;
}

function parseArguments(argv) {
  let manifest = "public-boundary.json";
  let trackedOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--tracked-only") {
      trackedOnly = true;
      continue;
    }
    if (argument === "--manifest") {
      const value = argv[index + 1];
      if (!value) throw new Error("--manifest requires a repository-relative path");
      manifest = value;
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  return { manifest, trackedOnly };
}

function repositoryPath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (
    isAbsolute(value)
    || value.includes("\\")
    || value.includes("\0")
    || /[\u0001-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is not a safe repository-relative path: ${JSON.stringify(value)}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} contains an empty or traversal segment: ${JSON.stringify(value)}`);
  }
  return value;
}

function stringArray(manifest, key) {
  const value = manifest[key];
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
  const result = value.map((entry, index) => repositoryPath(entry, `${key}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${key} contains duplicates`);
  return result;
}

function prefixArray(manifest, key) {
  const value = manifest[key];
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
  const result = value.map((prefix, index) => {
    if (typeof prefix !== "string" || !prefix.endsWith("/")) {
      throw new Error(`${key}[${index}] must be a non-empty path ending in '/'`);
    }
    return `${repositoryPath(prefix.slice(0, -1), `${key}[${index}]`)}/`;
  });
  if (new Set(result).size !== result.length) throw new Error(`${key} contains duplicates`);
  return result;
}

function compileRules(value, key, { allowExceptions = false } = {}) {
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
  const ids = new Set();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${key}[${index}] must be an object`);
    }
    const { id, pattern } = entry;
    if (typeof id !== "string" || !id) throw new Error(`${key}[${index}].id is required`);
    if (ids.has(id)) throw new Error(`${key} contains duplicate id ${id}`);
    ids.add(id);
    if (typeof pattern !== "string" || !pattern) {
      throw new Error(`${key}[${index}].pattern is required`);
    }
    const requestedFlags = entry.flags ?? "u";
    if (typeof requestedFlags !== "string" || /[gy]/u.test(requestedFlags)) {
      throw new Error(`${key}[${index}].flags cannot use stateful g or y flags`);
    }
    const flags = requestedFlags.includes("u") ? requestedFlags : `${requestedFlags}u`;
    let regex;
    try {
      regex = new RegExp(pattern, flags);
    } catch (error) {
      throw new Error(`${key}[${index}] has an invalid regular expression: ${error.message}`);
    }
    let unlessSuffixes = [];
    if (allowExceptions && entry.unlessSuffixes !== undefined) {
      if (!Array.isArray(entry.unlessSuffixes) || entry.unlessSuffixes.some((item) => typeof item !== "string" || !item)) {
        throw new Error(`${key}[${index}].unlessSuffixes must be an array of non-empty strings`);
      }
      unlessSuffixes = [...entry.unlessSuffixes];
    }
    return { id, regex, unlessSuffixes };
  });
}

function positiveInteger(manifest, key) {
  const value = manifest[key];
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive safe integer`);
  }
  return value;
}

function insideRepository(absolutePath) {
  const fromRoot = relative(repositoryRoot, absolutePath);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function readManifest(pathArgument) {
  const safePath = repositoryPath(pathArgument, "manifest path");
  const absolutePath = resolve(repositoryRoot, safePath);
  if (!insideRepository(absolutePath)) throw new Error("manifest resolves outside the repository");

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${safePath}: ${error.message}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest root must be an object");
  }
  if (manifest.version !== 1) throw new Error("manifest version must be 1");

  const policy = {
    allowedFiles: new Set(stringArray(manifest, "allowedFiles")),
    allowedPrefixes: prefixArray(manifest, "allowedPrefixes"),
    deniedFiles: new Set(stringArray(manifest, "deniedFiles")),
    deniedPrefixes: prefixArray(manifest, "deniedPrefixes"),
    deniedPathRules: compileRules(manifest.deniedPathRegexes, "deniedPathRegexes", {
      allowExceptions: true,
    }),
    maxFileBytes: positiveInteger(manifest, "maxFileBytes"),
    largeFileAllowFiles: new Set(stringArray(manifest, "largeFileAllowFiles")),
    allowedSymlinks: new Set(stringArray(manifest, "allowedSymlinks")),
    contentScanMaxBytes: positiveInteger(manifest, "contentScanMaxBytes"),
    contentScanExemptFiles: new Set(stringArray(manifest, "contentScanExemptFiles")),
    forbiddenContentRules: compileRules(manifest.forbiddenContentRegexes, "forbiddenContentRegexes"),
  };

  if (!policy.allowedFiles.has(safePath)) {
    throw new Error(`the manifest must allow itself explicitly: ${safePath}`);
  }
  for (const path of [
    ...policy.largeFileAllowFiles,
    ...policy.allowedSymlinks,
    ...policy.contentScanExemptFiles,
  ]) {
    if (!policy.allowedFiles.has(path) && !policy.allowedPrefixes.some((prefix) => path.startsWith(prefix))) {
      throw new Error(`policy exception is outside the public allowlist: ${path}`);
    }
  }

  return { policy, safePath };
}

function listCandidatePaths(trackedOnly) {
  const argumentsForGit = ["-c", "core.quotepath=false", "ls-files", "-z", "--cached"];
  if (!trackedOnly) argumentsForGit.push("--others", "--exclude-standard");
  let output;
  try {
    output = execFileSync("git", argumentsForGit, {
      cwd: repositoryRoot,
      encoding: "buffer",
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = error.stderr?.toString("utf8").trim();
    throw new Error(`git ls-files failed${stderr ? `: ${stderr}` : ""}`);
  }

  let decoded;
  try {
    decoded = utf8Decoder.decode(output);
  } catch {
    throw new Error("repository contains a path that is not valid UTF-8");
  }
  // `git ls-files --cached` keeps an unstaged deletion in the index. The public
  // snapshot, however, is exported from the working tree, so those paths are
  // intentionally absent and must not be treated as unreadable export inputs.
  // Keep this Git-backed instead of filtering every missing path so a path that
  // disappears for another reason still fails during inspection.
  let deletedOutput;
  try {
    deletedOutput = execFileSync(
      "git",
      ["-c", "core.quotepath=false", "ls-files", "-z", "--deleted"],
      {
        cwd: repositoryRoot,
        encoding: "buffer",
        maxBuffer: 128 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    const stderr = error.stderr?.toString("utf8").trim();
    throw new Error(`git ls-files --deleted failed${stderr ? `: ${stderr}` : ""}`);
  }

  let deletedDecoded;
  try {
    deletedDecoded = utf8Decoder.decode(deletedOutput);
  } catch {
    throw new Error("repository contains a deleted path that is not valid UTF-8");
  }
  const deleted = new Set(deletedDecoded.split("\0").filter(Boolean));
  const paths = decoded.split("\0").filter((path) => path && !deleted.has(path));
  if (new Set(paths).size !== paths.length) throw new Error("git returned duplicate candidate paths");
  return paths.sort((left, right) => left.localeCompare(right, "en"));
}

function allowlisted(path, policy) {
  return policy.allowedFiles.has(path)
    || policy.allowedPrefixes.some((prefix) => path.startsWith(prefix));
}

function denyReason(path, policy) {
  if (policy.deniedFiles.has(path)) return "explicitly denied file";
  const prefix = policy.deniedPrefixes.find((candidate) => path.startsWith(candidate));
  if (prefix) return `denied prefix ${prefix}`;
  for (const rule of policy.deniedPathRules) {
    if (rule.unlessSuffixes.some((suffix) => path.endsWith(suffix))) continue;
    if (rule.regex.test(path)) return `denied path rule ${rule.id}`;
  }
  return null;
}

function lineNumber(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function inspectFiles(paths, policy) {
  const errors = [];
  const collisionMap = new Map();
  let textFilesScanned = 0;
  let binaryFilesSkipped = 0;
  let bytesChecked = 0;

  for (const rawPath of paths) {
    let path;
    try {
      path = repositoryPath(rawPath, "candidate path");
    } catch (error) {
      errors.push(error.message);
      continue;
    }

    const collisionKey = path.normalize("NFC").toLowerCase();
    const collidedWith = collisionMap.get(collisionKey);
    if (collidedWith && collidedWith !== path) {
      errors.push(`case/Unicode-colliding paths: ${JSON.stringify(collidedWith)} and ${JSON.stringify(path)}`);
    } else {
      collisionMap.set(collisionKey, path);
    }

    const denied = denyReason(path, policy);
    if (denied) errors.push(`${JSON.stringify(path)}: ${denied}`);
    if (!allowlisted(path, policy)) errors.push(`${JSON.stringify(path)}: not in the public allowlist`);

    const absolutePath = resolve(repositoryRoot, path);
    if (!insideRepository(absolutePath)) {
      errors.push(`${JSON.stringify(path)}: resolves outside the repository`);
      continue;
    }

    let metadata;
    try {
      metadata = lstatSync(absolutePath);
    } catch (error) {
      errors.push(`${JSON.stringify(path)}: missing or unreadable in the working tree (${error.code ?? error.message})`);
      continue;
    }

    if (metadata.isSymbolicLink()) {
      if (!policy.allowedSymlinks.has(path)) {
        errors.push(`${JSON.stringify(path)}: symlink is not explicitly allowed`);
        continue;
      }
      let target;
      try {
        target = realpathSync(absolutePath);
      } catch (error) {
        errors.push(`${JSON.stringify(path)}: symlink target cannot be resolved (${error.code ?? error.message})`);
        continue;
      }
      if (!insideRepository(target)) {
        errors.push(`${JSON.stringify(path)}: symlink target escapes the repository`);
      }
      continue;
    }

    if (!metadata.isFile()) {
      errors.push(`${JSON.stringify(path)}: candidate is not a regular file`);
      continue;
    }
    if (metadata.size > policy.maxFileBytes && !policy.largeFileAllowFiles.has(path)) {
      errors.push(`${JSON.stringify(path)}: ${metadata.size} bytes exceeds maxFileBytes without review`);
      continue;
    }
    if (metadata.size > policy.contentScanMaxBytes || policy.contentScanExemptFiles.has(path)) continue;

    let buffer;
    try {
      buffer = readFileSync(absolutePath);
    } catch (error) {
      errors.push(`${JSON.stringify(path)}: cannot be read (${error.code ?? error.message})`);
      continue;
    }
    bytesChecked += buffer.length;
    if (buffer.includes(0)) {
      binaryFilesSkipped += 1;
      continue;
    }

    let text;
    try {
      text = utf8Decoder.decode(buffer);
    } catch {
      binaryFilesSkipped += 1;
      continue;
    }
    textFilesScanned += 1;
    for (const rule of policy.forbiddenContentRules) {
      const match = rule.regex.exec(text);
      if (match) {
        errors.push(`${JSON.stringify(path)}:${lineNumber(text, match.index)}: forbidden content rule ${rule.id}`);
      }
    }
  }

  return { binaryFilesSkipped, bytesChecked, errors, textFilesScanned };
}

try {
  const options = parseArguments(process.argv.slice(2));
  const { policy, safePath } = readManifest(options.manifest);
  const paths = listCandidatePaths(options.trackedOnly);
  const result = inspectFiles(paths, policy);

  if (result.errors.length > 0) {
    process.stderr.write(`Public boundary FAILED with ${result.errors.length} issue(s):\n`);
    for (const error of result.errors.slice(0, 100)) process.stderr.write(`- ${error}\n`);
    if (result.errors.length > 100) {
      process.stderr.write(`- ... ${result.errors.length - 100} additional issue(s) omitted\n`);
    }
    process.exitCode = 1;
  } else {
    const mode = options.trackedOnly ? "tracked" : "tracked + unignored untracked";
    process.stdout.write(
      `Public boundary OK: ${paths.length} ${mode} files; `
      + `${result.textFilesScanned} text files scanned, `
      + `${result.binaryFilesSkipped} binary files skipped, `
      + `${result.bytesChecked} bytes checked against ${safePath}.\n`,
    );
  }
} catch (error) {
  process.stderr.write(`Public boundary check could not run: ${error.message}\n\n${usage()}`);
  process.exitCode = 2;
}
