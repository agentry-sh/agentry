import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localOnly = process.argv.includes("--local-only");
const userAgent = "Agentry-Distribution-Parity/1.0 (+https://github.com/agentry-sh/agentry)";

const publicFiles = [
  "packages/mcp/package.json",
  "packages/mcp/server.json",
  "packages/mcp/bin/agentry-mcp.js",
  "packages/mcp/README.md",
  ".agents/plugins/marketplace.json",
  ".claude-plugin/marketplace.json",
  "plugins/agentry/.codex-plugin/plugin.json",
  "plugins/agentry/.claude-plugin/plugin.json",
  "plugins/agentry/.codexignore",
  "plugins/agentry/assets/icon.svg",
  "plugins/agentry/README.md",
  "plugins/agentry/skills/agentry/SKILL.md",
];

function normalizedText(value) {
  return `${String(value).replace(/\r\n/g, "\n").trimEnd()}\n`;
}

async function localFile(path) {
  return readFile(resolve(root, path), "utf8");
}

async function fetchBounded(url, maxBytes = 1_000_000) {
  const response = await fetch(url, {
    headers: { "user-agent": userAgent },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200, `${url} returned HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  assert(!declared || declared <= maxBytes, `${url} declared an oversized response`);
  const body = await response.text();
  assert(Buffer.byteLength(body) <= maxBytes, `${url} returned an oversized response`);
  return body;
}

async function checkLocalContract() {
  const packageJson = JSON.parse(await localFile("packages/mcp/package.json"));
  const serverJson = JSON.parse(await localFile("packages/mcp/server.json"));
  const runtime = await localFile("packages/mcp/bin/agentry-mcp.js");
  const readme = await localFile("packages/mcp/README.md");
  const codexMarketplace = JSON.parse(await localFile(".agents/plugins/marketplace.json"));
  const claudeMarketplace = JSON.parse(await localFile(".claude-plugin/marketplace.json"));
  const codexPlugin = JSON.parse(await localFile("plugins/agentry/.codex-plugin/plugin.json"));
  const claudePlugin = JSON.parse(await localFile("plugins/agentry/.claude-plugin/plugin.json"));
  const pluginSkill = await localFile("plugins/agentry/skills/agentry/SKILL.md");
  const adapters = await localFile("apps/api/src/adapters.ts");

  assert.equal(packageJson.version, serverJson.version, "MCP package and registry versions differ");
  assert.equal(serverJson.packages[0].version, packageJson.version, "registry package version differs");
  assert.equal(packageJson.homepage, "https://github.com/agentry-sh/agentry/tree/main/packages/mcp");
  assert.equal(serverJson.websiteUrl, "https://github.com/agentry-sh/agentry");
  assert.equal(packageJson.mcpName, "io.github.agentry-sh/agentry-observability");
  assert.equal(serverJson.name, packageJson.mcpName);
  assert.equal(codexMarketplace.plugins[0].name, codexPlugin.name);
  assert.equal(codexMarketplace.plugins[0].source.path, "./plugins/agentry");
  assert.equal(codexMarketplace.plugins[0].policy.installation, "AVAILABLE");
  assert.equal(codexMarketplace.plugins[0].policy.authentication, "ON_INSTALL");
  assert.equal(claudeMarketplace.plugins[0].source, "./plugins/agentry");
  assert.equal(claudeMarketplace.plugins[0].version, claudePlugin.version);
  assert.equal(codexPlugin.version, claudePlugin.version);
  assert.equal(codexPlugin.homepage, "https://github.com/agentry-sh/agentry");
  assert.equal(codexPlugin.interface.websiteURL, "https://github.com/agentry-sh/agentry");
  assert.equal(claudeMarketplace.plugins[0].homepage, "https://github.com/agentry-sh/agentry");
  assert.equal(claudePlugin.homepage, "https://github.com/agentry-sh/agentry");
  assert.equal(codexPlugin.license, "Apache-2.0");
  assert.equal(claudePlugin.license, "Apache-2.0");
  assert.match(runtime, new RegExp(`SERVER_VERSION = "${packageJson.version.replaceAll(".", "\\.")}"`));
  assert.match(runtime, /name: "discover_agentry"/);
  assert.match(runtime, /readOnlyHint: true/);
  assert.match(runtime, /structuredContent/);
  assert.match(runtime, /distribution_surface: "mcp"/);
  assert.match(runtime, /tools: \{ listChanged: false \}/);
  assert.equal(serverJson.title, "Agentry.sh Observability");
  assert.match(readme, /control plane over a customer's\s+existing PostHog Cloud/s);
  assert.match(pluginSkill, /openapi\.json\?flow=onboarding(?:\s|`|$)/);
  assert.match(pluginSkill, /Read the canonical `INSTALL\.md` URL above completely/);
  assert.match(pluginSkill, /`agentry onboard`/);
  assert.match(pluginSkill, /`agentry onboard --json`/);
  assert.match(pluginSkill, /`agent_task`/);
  assert.match(pluginSkill, /`human_checkpoint`/);
  assert.match(pluginSkill, /`external_action`/);
  assert.match(pluginSkill, /`complete`/);
  assert.match(pluginSkill, /historically_observed/);
  assert.match(pluginSkill, /source_verified/);
  assert.match(pluginSkill, /does not prove current source ownership/);
  assert.match(pluginSkill, /credentials outside the repo/);
  assert.match(pluginSkill, /PostHog OAuth/);
  assert.match(pluginSkill, /official PostHog SDKs and CLI directly/);
  assert.match(pluginSkill, /Application analytics and exceptions go straight to customer PostHog Cloud/);
  assert.match(pluginSkill, /Source maps go straight through the official PostHog CLI/);
  assert.match(pluginSkill, /AGENTRY_CI_API_KEY/);
  assert.match(pluginSkill, /AGENTRY_RUNNER_API_KEY/);
  assert.match(adapters, /codex plugin marketplace add agentry-sh\/agentry/);
  assert.match(adapters, /codex plugin add agentry@agentry/);
  assert.match(adapters, /claude plugin marketplace add agentry-sh\/agentry/);
  assert.match(pluginSkill, /raw\.githubusercontent\.com\/agentry-sh\/agentry\/main\/INSTALL\.md/);
  assert.match(pluginSkill, /raw\.githubusercontent\.com\/agentry-sh\/agentry\/main\/AGENTRY\.md/);

  for (const [path, content] of [
    ["MCP runtime", runtime],
    ["MCP README", readme],
    ["packaged skill", pluginSkill],
  ]) {
    assert.doesNotMatch(content, /AGENTRY_DSN|AGENTRY_API_KEY|AGENTRY_PROJECT_ID|\.agentry\/config\.json/, `${path} contains a retired credential contract`);
    assert.doesNotMatch(
      content,
      /AGENTRY_PUBLIC_API_KEY|AGENTRY_SERVER_API_KEY|public_api_key|agentry_pk_|agentry_server_|server_ingest/,
      `${path} contains a retired public/server ingest boundary`,
    );
    assert.doesNotMatch(
      content,
      /\/v1\/logs\/|\/v1\/analytics\/|status: "verified"|installation_complete|marker-scoped|proof markers/,
      `${path} contains a retired ingest or onboarding-proof contract`,
    );
    assert.doesNotMatch(
      content,
      /distinct(?:,)? short-lived server and CI credentials|distinct, short-lived, response-only secrets/,
      `${path} describes a retired temporary telemetry credential model`,
    );
  }

  return packageJson.version;
}

async function checkPublicGitHubParity() {
  for (const path of publicFiles) {
    const [local, remote] = await Promise.all([
      localFile(path),
      fetchBounded(`https://raw.githubusercontent.com/agentry-sh/agentry/main/${path}`),
    ]);
    assert.equal(normalizedText(remote), normalizedText(local), `public repo drift: ${path}`);
  }
}

async function checkPublishedVersions(expectedVersion) {
  const npmLatest = JSON.parse(await fetchBounded("https://registry.npmjs.org/@agentrysh%2Fmcp/latest"));
  assert.equal(npmLatest.version, expectedVersion, "npm latest version differs from the canonical MCP version");

  const registry = JSON.parse(await fetchBounded(
    "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.agentry-sh%2Fagentry-observability",
  ));
  const latest = registry.servers?.find((entry) =>
    entry.server?.name === "io.github.agentry-sh/agentry-observability" &&
    entry._meta?.["io.modelcontextprotocol.registry/official"]?.isLatest === true
  );
  assert(latest, "official MCP Registry has no latest Agentry entry");
  assert.equal(latest.server.version, expectedVersion, "official MCP Registry version differs");
  assert.equal(latest.server.packages?.[0]?.version, expectedVersion, "official registry npm version differs");
}

const version = await checkLocalContract();
if (!localOnly) {
  await checkPublicGitHubParity();
  await checkPublishedVersions(version);
}

console.log(JSON.stringify({
  ok: true,
  mode: localOnly ? "local" : "live",
  version,
  checked_public_files: localOnly ? 0 : publicFiles.length,
}, null, 2));
