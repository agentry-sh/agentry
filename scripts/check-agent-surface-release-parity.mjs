#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import {
  compareAgentSurface,
} from "./lib/agent-surface-parity.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_SURFACE_BYTES = 16 * 1024 * 1024;
const USER_AGENT = "agentry-agent-surface-release-parity/1.0";

function parseArgs(argv) {
  const out = {
    api: process.env.AGENTRY_URL ?? "https://api.agentry.sh",
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--api") out.api = String(argv[++index] ?? "");
    else if (arg === "--json") out.json = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/check-agent-surface-release-parity.mjs [--api <url>] [--json]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  const parsed = new URL(out.api);
  if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname)) {
    throw new Error("--api must use HTTPS or exact loopback HTTP");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("--api must not contain credentials, query, or fragment");
  }
  out.api = parsed.href.replace(/\/$/, "");
  return out;
}

function compileLocalApi() {
  for (const [command, args] of [
    ["npm", ["-w", "@agentrysh/shared", "run", "build"]],
    ["npm", ["-w", "@agentry/db", "run", "build"]],
    ["npx", ["tsc", "-p", "apps/api/tsconfig.json", "--pretty", "false"]],
  ]) {
    execFileSync(command, args, {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180_000,
    });
  }
}

async function importDist(relativePath) {
  const target = path.join(REPO_ROOT, "apps", "api", "dist", "src", relativePath);
  return import(`${pathToFileURL(target).href}?release_parity=${Date.now()}_${Math.random()}`);
}

async function localSurfaces() {
  compileLocalApi();
  const [discovery, automationDocs, adapters, playbooks] = await Promise.all([
    importDist("routes/discovery.js"),
    importDist("automation-docs.js"),
    importDist("adapters.js"),
    importDist("automation-playbooks.js"),
  ]);
  const serializedPlaybooks = await Promise.all(
    playbooks.listAutomationPlaybookTemplates().map(playbooks.serializeAutomationPlaybookTemplate),
  );
  return [
    { id: "openapi", path: "/v1/openapi.json", kind: "json", expected: discovery.buildOpenApiSchema() },
    { id: "adapter-index", path: "/adapters", kind: "json", expected: adapters.adaptersIndex() },
    { id: "claude-plugin-manifest", path: "/adapters/claude-plugin.json", kind: "json", expected: adapters.renderClaudePluginManifest() },
    { id: "automation-docs", path: "/v1/docs/automation", kind: "text", expected: automationDocs.AUTOMATION_DOCS },
    {
      id: "automation-playbooks",
      path: "/v1/automation-playbooks",
      kind: "json",
      expected: {
        kind: "automation_playbook_catalog",
        count: serializedPlaybooks.length,
        version_policy: "immutable_semver",
        list_policy: "latest_version_per_template",
        playbooks: serializedPlaybooks,
        next_action: "Read one exact template version, collect its project-specific bindings without secrets or telemetry, then call its project-scoped render endpoint. Rendering is read-only and always returns a disabled candidate.",
      },
    },
  ];
}

async function boundedFetch(baseUrl, surface) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${baseUrl}${surface.path}`, {
      headers: { accept: surface.kind === "json" ? "application/json" : "text/markdown", "user-agent": USER_AGENT },
      redirect: "error",
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    const chunks = [];
    let total = 0;
    if (reader) {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (!next.value) continue;
        total += next.value.byteLength;
        if (total > MAX_SURFACE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new Error(`${surface.path} exceeded ${MAX_SURFACE_BYTES} bytes`);
        }
        chunks.push(next.value);
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder().decode(bytes);
    let actual = text;
    if (surface.kind === "json" && response.status === 200) {
      try {
        actual = JSON.parse(text);
      } catch {
        return { status: response.status, actual: null, parse_error: "invalid JSON" };
      }
    }
    return { status: response.status, actual, parse_error: null };
  } finally {
    clearTimeout(timer);
  }
}

const args = parseArgs(process.argv.slice(2));
const surfaces = await localSurfaces();
const results = [];
for (const surface of surfaces) {
  const live = await boundedFetch(args.api, surface).catch((error) => ({
    status: 0,
    actual: null,
    parse_error: error instanceof Error ? error.message : "request failed",
  }));
  const result = compareAgentSurface({ ...surface, actual: live.actual, status: live.status });
  results.push({ ...result, ...(live.parse_error ? { failure: live.parse_error } : {}) });
}
const report = {
  ok: results.every((result) => result.ok),
  api: args.api,
  policy: "API-generated contracts must exactly match local code before adapters or transactional surfaces are deployed; authored guides are versioned in GitHub.",
  results,
};
if (args.json) console.log(JSON.stringify(report, null, 2));
else {
  for (const result of results) {
    console.log(`${result.ok ? "PASS" : "FAIL"} ${result.id} ${result.path}${result.failure ? ` — ${result.failure}` : ""}`);
  }
}
if (!report.ok) process.exitCode = 1;
