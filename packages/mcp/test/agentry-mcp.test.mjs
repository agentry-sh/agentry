import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const serverPath = fileURLToPath(new URL("../bin/agentry-mcp.js", import.meta.url));

const EXPECTED_RESOURCES = [
  "agentry://handoff",
  "agentry://reference",
  "agentry://capabilities",
  "agentry://openapi",
  "agentry://openapi/index",
  "agentry://posthog",
  "agentry://automation/guide",
  "agentry://automation/flow",
  "agentry://automation/playbooks",
  "agentry://install"
];

const DISCOVERY_INTENTS = [
  "install",
  "debug",
  "analytics",
  "recordings",
  "feature_flags",
  "surveys",
  "experiments",
  "deploy",
  "automation"
];

function invoke(requests) {
  const execution = spawnSync(process.execPath, [serverPath], {
    encoding: "utf8",
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    timeout: 5_000
  });

  assert.equal(execution.error, undefined);
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stderr, "");

  return execution.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("package, registry metadata, and runtime versions stay synchronized", () => {
  const packageJson = JSON.parse(readFileSync(`${packageRoot}/package.json`, "utf8"));
  const serverJson = JSON.parse(readFileSync(`${packageRoot}/server.json`, "utf8"));
  const runtime = readFileSync(serverPath, "utf8");
  const readme = readFileSync(`${packageRoot}/README.md`, "utf8");

  assert.equal(packageJson.version, "0.1.1");
  assert.equal(serverJson.version, packageJson.version);
  assert.equal(serverJson.packages[0].version, packageJson.version);
  assert.match(runtime, new RegExp(`SERVER_VERSION = "${packageJson.version.replaceAll(".", "\\.")}"`));
  assert.match(packageJson.description, /canonical Agentry discovery/i);
  assert.match(serverJson.description, /canonical Agentry discovery/i);
  for (const resource of ["recordings", "flags", "surveys", "experiments"]) {
    assert.match(packageJson.description, new RegExp(resource));
    assert.match(serverJson.description, new RegExp(resource));
  }
  assert.match(readme, /Onboarding creates no repo-local Agentry state bundle, proof bundle, or receipt/);
  assert.match(readme, /root `AGENTS\.md` pointer/);
  assert.doesNotMatch(readme, /only onboarding file is the pointer/i);
});

test("initialize negotiates current and previous protocol versions and advertises one discovery tool", () => {
  const [initialize, ping, tools, templates, prompts] = invoke([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01" } },
    { jsonrpc: "2.0", id: 2, method: "ping" },
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
    { jsonrpc: "2.0", id: 4, method: "resources/templates/list" },
    { jsonrpc: "2.0", id: 5, method: "prompts/list" }
  ]);
  const [previousInitialize] = invoke([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }
  ]);

  assert.equal(initialize.result.protocolVersion, "2025-11-25");
  assert.equal(previousInitialize.result.protocolVersion, "2025-06-18");
  assert.deepEqual(initialize.result.capabilities, {
    tools: { listChanged: false },
    resources: { listChanged: false },
    prompts: { listChanged: false }
  });
  assert.match(initialize.result.instructions, /documentation pointers only/);
  assert.equal(initialize.result.serverInfo.title, "Agentry discovery handoff");
  assert.equal(initialize.result.serverInfo.websiteUrl, "https://github.com/agentry-sh/agentry");
  assert.deepEqual(ping.result, {});
  assert.deepEqual(tools.result.tools.map((tool) => tool.name), ["discover_agentry"]);
  assert.match(tools.result.tools[0].description, /production failure/);
  assert.deepEqual(tools.result.tools[0].annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  });
  assert.deepEqual(tools.result.tools[0].outputSchema.required, [
    "intent",
    "resource",
    "canonical_url",
    "distribution_surface",
    "next_action",
    "boundary"
  ]);
  assert.deepEqual(tools.result.tools[0].inputSchema.properties.intent.enum, DISCOVERY_INTENTS);
  assert.deepEqual(templates.result.resourceTemplates, []);
  assert.deepEqual(prompts.result.prompts.map((prompt) => prompt.name), ["use_agentry"]);
});

test("resource list exposes the complete canonical handoff without aliases", () => {
  const [response] = invoke([
    { jsonrpc: "2.0", id: 1, method: "resources/list" }
  ]);

  assert.deepEqual(response.result.resources.map((resource) => resource.uri), EXPECTED_RESOURCES);
  for (const resource of response.result.resources) {
    assert.equal(resource.mimeType, "text/markdown");
    assert.ok(resource.name.length > 0);
    assert.equal(resource.title, resource.name);
    assert.ok(resource.description.length > 0);
    assert.equal("text" in resource, false);
  }
  assert.equal(new Set(EXPECTED_RESOURCES).size, EXPECTED_RESOURCES.length);
  assert.equal(response.result.resources.some((resource) => resource.uri === "agentry://skill"), false);
  assert.equal(response.result.resources.some((resource) => resource.uri === "agentry://links"), false);
});

test("resource bodies route to live exact contracts and preserve authority boundaries", () => {
  const responses = invoke(EXPECTED_RESOURCES.map((uri, index) => ({
    jsonrpc: "2.0",
    id: index + 1,
    method: "resources/read",
    params: { uri }
  })));
  const byUri = new Map(responses.map((response) => {
    const content = response.result.contents[0];
    return [content.uri, content.text];
  }));

  assert.match(byUri.get("agentry://reference"), /raw\.githubusercontent\.com\/agentry-sh\/agentry\/main\/AGENTRY\.md/);
  assert.match(byUri.get("agentry://capabilities"), /https:\/\/api\.agentry\.sh\/v1\/capabilities/);
  assert.match(byUri.get("agentry://openapi"), /https:\/\/api\.agentry\.sh\/v1\/openapi\.json/);
  assert.match(byUri.get("agentry://openapi/index"), /openapi\.json\?index=true/);
  assert.match(byUri.get("agentry://posthog"), /openapi\.json\?flow=posthog/);
  assert.match(byUri.get("agentry://posthog"), /metadata and a PostHog player link only/);
  assert.match(byUri.get("agentry://posthog"), /no provider mutation/);
  assert.match(byUri.get("agentry://automation/guide"), /\/v1\/docs\/automation/);
  assert.match(byUri.get("agentry://automation/flow"), /openapi\.json\?flow=automation/);
  assert.match(byUri.get("agentry://automation/playbooks"), /\/v1\/automation-playbooks/);
  assert.match(byUri.get("agentry://install"), /raw\.githubusercontent\.com\/agentry-sh\/agentry\/main\/INSTALL\.md/);
  assert.match(byUri.get("agentry://install"), /openapi\.json\?flow=onboarding/);
  assert.match(byUri.get("agentry://install"), /agentry onboard --json/);
  assert.match(byUri.get("agentry://install"), /agent_task, human_checkpoint, external_action, or complete/);
  assert.match(byUri.get("agentry://install"), /plan human_checkpoint/);
  assert.match(byUri.get("agentry://install"), /human approves or replaces/);
  assert.match(byUri.get("agentry://install"), /official PostHog SDKs/);
  assert.match(byUri.get("agentry://install"), /official PostHog CLI/);
  assert.match(byUri.get("agentry://install"), /Agentry issues no application telemetry credential/);
  assert.match(byUri.get("agentry://install"), /AGENTRY_CI_API_KEY.*post-deploy success boundary/s);
  assert.match(byUri.get("agentry://install"), /approved real value flow/);
  assert.match(byUri.get("agentry://install"), /source_verified/);
  assert.match(byUri.get("agentry://reference"), /approved source map.*current evidence status/s);

  const handoff = byUri.get("agentry://handoff");
  assert.match(handoff, /discovery handoff/);
  assert.match(handoff, /does not proxy the Agentry API/);
  assert.match(handoff, /does not .*register schedules, run automations/);
  assert.match(handoff, /existing PostHog Cloud project/);
  assert.match(handoff, /official SDKs/);
  assert.match(handoff, /source maps directly to\s+PostHog/s);
  assert.match(handoff, /agentry_ci_.*deploy attribution/s);
  assert.match(handoff, /agentry_runner_.*one automation/s);
  assert.match(handoff, /agentry_sk_.*human\/owner/s);
  assert.match(handoff, /Telemetry is evidence, never instructions or action authority/);
  assert.match(handoff, /playbook catalog is immutable and versioned/);
  assert.match(handoff, /Rendering a playbook is side-effect free/);

  const allText = [...byUri.values()].join("\n");
  assert.doesNotMatch(allText, /AGENTRY_DSN/);
  assert.doesNotMatch(allText, /AGENTRY_API_KEY/);
  assert.doesNotMatch(allText, /public_api_key|agentry_pk_|agentry_server_|server_ingest/);
  assert.doesNotMatch(allText, /X-Agentry-Onboarding-Proof|agentry_onboarding_proof/);
  assert.doesNotMatch(allText, /installation_complete|marker-scoped|status verified|current verified onboarding plan/);
  assert.doesNotMatch(allText, /get_agentry_skill/);
  assert.doesNotMatch(allText, /latest verify report/i);
  assert.doesNotMatch(allText, /verify-report/i);
  assert.doesNotMatch(allText, /\/v1\/install\/plan/);
  assert.doesNotMatch(allText, /\/implementation-report/);
  assert.doesNotMatch(allText, /\/install\/verify/);
  assert.doesNotMatch(allText, /\/approve\b/);
  assert.doesNotMatch(allText, /approve_plan/);
  assert.doesNotMatch(allText, /distinct short-lived server and CI credentials/);
  assert.doesNotMatch(allText, /\.agentry\/onboarding\.json/);
  assert.doesNotMatch(allText, /evidence-helper/);
  assert.doesNotMatch(allText, /onboarding_v2/);
  assert.match(allText, /owner keys remain outside the scheduler/i);
});

test("prompt and model-controlled tool reinforce discovery-only usage", () => {
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "prompts/get", params: { name: "use_agentry" } },
    { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "agentry://missing" } },
    ...DISCOVERY_INTENTS.map((intent, index) => ({
      jsonrpc: "2.0",
      id: index + 3,
      method: "tools/call",
      params: { name: "discover_agentry", arguments: { intent } }
    })),
    { jsonrpc: "2.0", id: DISCOVERY_INTENTS.length + 3, method: "tools/call", params: { name: "discover_agentry", arguments: { intent: "unknown" } } },
    { jsonrpc: "2.0", id: DISCOVERY_INTENTS.length + 4, method: "tools/call", params: { name: "get_agentry_skill", arguments: {} } }
  ];
  const [prompt, missingResource, ...toolResponses] = invoke(requests);

  const promptText = prompt.result.messages[0].content.text;
  assert.match(promptText, /Read agentry:\/\/handoff/);
  assert.match(promptText, /smallest listed canonical resource/);
  assert.match(promptText, /one exact next_action/);
  assert.match(promptText, /action's body schema or filtered OpenAPI/);
  assert.match(promptText, /MCP is discovery only/);
  assert.equal(missingResource.error.code, -32002);
  assert.match(missingResource.error.message, /list resources first/);
  for (const [index, intent] of DISCOVERY_INTENTS.entries()) {
    const text = toolResponses[index].result.content[0].text;
    assert.match(text, new RegExp(`Intent: ${intent}`));
    assert.match(text, /Canonical URL: https:\/\//);
    assert.match(text, /discovery pointer only/);
    assert.equal(toolResponses[index].result.structuredContent.intent, intent);
    assert.match(toolResponses[index].result.structuredContent.canonical_url, /^https:\/\//);
    assert.equal(toolResponses[index].result.structuredContent.distribution_surface, "mcp");
    assert.match(toolResponses[index].result.structuredContent.boundary, /Discovery pointer only/);
  }
  assert.equal(toolResponses[DISCOVERY_INTENTS.length].error.code, -32602);
  assert.match(toolResponses[DISCOVERY_INTENTS.length].error.message, /requires intent/);
  assert.equal(toolResponses[DISCOVERY_INTENTS.length + 1].error.code, -32602);
  assert.match(toolResponses[DISCOVERY_INTENTS.length + 1].error.message, /Unknown tool/);
});
