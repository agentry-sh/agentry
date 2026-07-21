#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { stdin, stdout, stderr } from "node:process";
import {
  DraftSubjectError,
  canonicalizeAgentryDraftSubject,
} from "./lib/agentry-draft-subject.mjs";

async function readStdin(maximum = 128 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    size += chunk.length;
    if (size > maximum) throw new DraftSubjectError(`stdin exceeds ${maximum} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function parseArgs(argv) {
  if (argv.length === 0) return { input: null };
  if (argv.length === 2 && argv[0] === "--input") return { input: argv[1] };
  throw new DraftSubjectError("usage: node scripts/prepare-agentry-draft-subject.mjs [--input <json-file>]");
}

try {
  const { input } = parseArgs(process.argv.slice(2));
  const source = input ? await readFile(input, "utf8") : await readStdin();
  const parsed = JSON.parse(source);
  const subject = canonicalizeAgentryDraftSubject(parsed);
  stdout.write(`${JSON.stringify(subject, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`draft subject rejected: ${message}\n`);
  process.exitCode = 1;
}
