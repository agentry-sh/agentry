#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadAgentryCredentials } from "./lib/agentry-credentials.mjs";
import { deleteProjectDurably } from "./lib/durable-project-delete.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_BASE_URL = "https://api.agentry.sh";
const USER_AGENT = process.env.AGENTRY_LIVE_TEST_USER_AGENT ?? "agentry-contract-drift-check/1.0";

function usage() {
  return [
    "Usage: node scripts/check-api-contract-drift.mjs [--api <url>] [--json] [--compare-local] [--local-only] [--runtime]",
    "",
    "Checks live/public OpenAPI contract surfaces for canonical Agentry response shapes.",
    "Exits nonzero when an endpoint documents internal PostHog results instead of object-shaped rows.",
    "",
    "Options:",
    "  --compare-local  Rebuild local API schema and classify failures as local gaps or live deploy drift.",
    "  --local-only     Rebuild local API schema and validate canonical contracts without network.",
    "  --runtime        With API credentials, validate actual live runtime JSON response shapes too.",
  ].join("\n");
}

function parseArgs(argv) {
  const out = {
    api: process.env.AGENTRY_URL ?? DEFAULT_BASE_URL,
    json: false,
    compareLocal: false,
    localOnly: false,
    runtime: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--api") {
      out.api = String(argv[++i] ?? "");
    } else if (arg === "--json") {
      out.json = true;
    } else if (arg === "--compare-local") {
      out.compareLocal = true;
    } else if (arg === "--local-only") {
      out.localOnly = true;
      out.compareLocal = true;
    } else if (arg === "--runtime") {
      out.runtime = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }
  if (!out.localOnly && !out.api) throw new Error("--api must be a URL");
  out.api = out.api.replace(/\/$/, "");
  return out;
}


function loadConfiguredProjectId() {
  const projectId = process.env.AGENTRY_PROJECT_ID?.trim();
  if (projectId) return { projectId, source: "AGENTRY_PROJECT_ID" };
  return null;
}

const CONTRACTS = [
  {
    id: "analytics_query",
    method: "POST",
    path: "/v1/projects/{project_id}/analytics/query",
    requiredResponseProperties: ["rows", "columns", "row_count", "freshness", "next_action"],
    forbiddenResponseProperties: ["results"],
    requiredDescriptionFragments: ["canonical object-shaped rows"],
    forbiddenDescriptionFragments: [
      "raw response uses PostHog",
      "results is an array",
    ],
    requiredExampleProperties: ["rows", "row_count", "freshness"],
    forbiddenExampleProperties: ["results"],
    requireRowsObjectItems: true,
  },
  {
    id: "public_query_execute",
    method: "GET",
    path: "/v1/public/q/{publication_id}",
    requiredResponseProperties: ["publication_id", "blueprint_id", "rows", "columns", "row_count", "next_action"],
    forbiddenResponseProperties: ["results"],
    requiredDescriptionFragments: [],
    forbiddenDescriptionFragments: [
      "raw response uses PostHog",
      "results is an array",
    ],
    requiredExampleProperties: ["publication_id", "blueprint_id", "rows", "row_count"],
    forbiddenExampleProperties: ["results"],
    requireRowsObjectItems: true,
  },
];

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Expected JSON from ${url}, got ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(`GET ${url} failed with ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return json;
}

function getOperation(filteredSchema, contract) {
  if (filteredSchema?.operation) return filteredSchema.operation;
  return filteredSchema?.paths?.[contract.path]?.[contract.method.toLowerCase()] ?? null;
}

function getResponseMedia(operation) {
  return operation?.responses?.["200"]?.content?.["application/json"] ?? null;
}

function hasOwn(obj, key) {
  return Boolean(obj && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key));
}

function exampleHasProperty(value, prop) {
  return hasOwn(value, prop);
}

function checkRowsItemShape(schema, failures) {
  const rows = schema?.properties?.rows;
  if (!rows) return;
  const items = rows.items;
  if (!items || typeof items !== "object") {
    failures.push({
      code: "rows_items_schema_missing",
      message: "rows must declare object item shape for generated clients.",
      actual: rows,
    });
    return;
  }
  if (items.type !== "object") {
    failures.push({
      code: "rows_items_not_object",
      message: "rows must be object-shaped, not arrays or untyped scalars.",
      actual: items,
    });
  }
}

function validateOperation(contract, operation) {
  const failures = [];
  if (!operation) {
    return [{ code: "operation_missing", message: "Filtered OpenAPI lookup did not return an operation." }];
  }

  const media = getResponseMedia(operation);
  const schema = media?.schema ?? null;
  const properties = schema?.properties ?? {};
  const example = media?.examples?.default?.value ?? media?.example ?? {};
  const description = String(operation.description ?? "");

  for (const prop of contract.requiredResponseProperties) {
    if (!hasOwn(properties, prop)) {
      failures.push({
        code: "schema_property_missing",
        message: `Response schema must include ${prop}.`,
        property: prop,
        response_properties: Object.keys(properties),
      });
    }
  }
  for (const prop of contract.forbiddenResponseProperties) {
    if (hasOwn(properties, prop)) {
      failures.push({
        code: "schema_property_forbidden",
        message: `Response schema must not expose internal ${prop}.`,
        property: prop,
        response_properties: Object.keys(properties),
      });
    }
  }
  for (const fragment of contract.requiredDescriptionFragments) {
    if (!description.includes(fragment)) {
      failures.push({
        code: "description_missing_fragment",
        message: `Operation description should mention '${fragment}'.`,
        fragment,
        description,
      });
    }
  }
  for (const fragment of contract.forbiddenDescriptionFragments) {
    if (description.includes(fragment)) {
      failures.push({
        code: "description_forbidden_fragment",
        message: `Operation description still teaches stale shape '${fragment}'.`,
        fragment,
        description,
      });
    }
  }
  for (const prop of contract.requiredExampleProperties) {
    if (!exampleHasProperty(example, prop)) {
      failures.push({
        code: "example_property_missing",
        message: `Response example must include ${prop}.`,
        property: prop,
        example_keys: Object.keys(example ?? {}),
      });
    }
  }
  for (const prop of contract.forbiddenExampleProperties) {
    if (exampleHasProperty(example, prop)) {
      failures.push({
        code: "example_property_forbidden",
        message: `Response example must not expose internal ${prop}.`,
        property: prop,
        example,
      });
    }
  }
  if (contract.requireRowsObjectItems) checkRowsItemShape(schema, failures);

  return failures;
}

function checkOperation(contract, operation, schemaUrl) {
  const failures = validateOperation(contract, operation);
  return {
    id: contract.id,
    method: contract.method,
    path: contract.path,
    schema_url: schemaUrl,
    schema_ok: failures.length === 0,
    ok: failures.length === 0,
    failures,
  };
}

async function checkContract(baseUrl, contract) {
  const schemaUrl =
    `${baseUrl}/v1/openapi.json?path=${encodeURIComponent(contract.path)}&method=${contract.method.toLowerCase()}`;
  const filteredSchema = await fetchJson(schemaUrl);
  const operation = getOperation(filteredSchema, contract);
  return checkOperation(contract, operation, schemaUrl);
}

async function loadLocalOpenApiSchema() {
  execFileSync("npm", ["-w", "@agentrysh/shared", "run", "build"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 180_000,
  });
  execFileSync("npm", ["-w", "@agentry/db", "run", "build"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 180_000,
  });
  execFileSync("npx", ["tsc", "-p", "apps/api/tsconfig.json", "--pretty", "false"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 180_000,
  });
  const distPath = path.join(REPO_ROOT, "apps", "api", "dist", "src", "routes", "discovery.js");
  const mod = await import(`${pathToFileURL(distPath).href}?contract_drift=${Date.now()}`);
  if (typeof mod.buildOpenApiSchema !== "function") {
    throw new Error(`buildOpenApiSchema not exported from ${path.relative(REPO_ROOT, distPath)}`);
  }
  return mod.buildOpenApiSchema();
}

async function checkLocalContracts() {
  const schema = await loadLocalOpenApiSchema();
  return CONTRACTS.map((contract) =>
    checkOperation(
      contract,
      schema?.paths?.[contract.path]?.[contract.method.toLowerCase()] ?? null,
      `local:${path.join("apps", "api", "src", "routes", "discovery.ts")}#${contract.method} ${contract.path}`,
    )
  );
}

function classifySourceStatus(live, local) {
  if (!local) return "live_only";
  if (live.schema_ok === true && live.runtime_ok === false && local.ok) return "live_runtime_contract_gap";
  if (live.ok && local.ok) return "in_sync";
  if (live.schema_ok === false && local.ok) return "local_fixed_live_stale";
  if (!live.ok && !local.ok) return "local_and_live_contract_gap";
  if (live.ok && !local.ok) return "live_ok_local_regression";
  return "unknown";
}

async function httpJson(baseUrl, method, pathSuffix, { headers = {}, body } = {}) {
  const res = await fetch(`${baseUrl}${pathSuffix}`, {
    method,
    headers: {
      "user-agent": USER_AGENT,
      ...headers,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

function runtimePayloadFailures(contract, payload) {
  const failures = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [{
      code: "runtime_response_not_object",
      message: "Runtime response must be a JSON object.",
      response_type: Array.isArray(payload) ? "array" : typeof payload,
    }];
  }
  const keys = Object.keys(payload);
  for (const prop of contract.requiredResponseProperties) {
    if (!hasOwn(payload, prop)) {
      failures.push({
        code: "runtime_property_missing",
        message: `Runtime response must include ${prop}.`,
        property: prop,
        response_keys: keys,
      });
    }
  }
  for (const prop of contract.forbiddenResponseProperties) {
    if (hasOwn(payload, prop)) {
      failures.push({
        code: "runtime_property_forbidden",
        message: `Runtime response must not expose internal ${prop}.`,
        property: prop,
        response_keys: keys,
      });
    }
  }
  if (hasOwn(payload, "rows")) {
    if (!Array.isArray(payload.rows)) {
      failures.push({
        code: "runtime_rows_not_array",
        message: "Runtime rows must be an array.",
        actual_type: typeof payload.rows,
      });
    } else {
      const badRow = payload.rows.find((row) => Array.isArray(row) || row == null || typeof row !== "object");
      if (badRow !== undefined) {
        failures.push({
          code: "runtime_rows_not_object_shaped",
          message: "Runtime rows must contain object-shaped rows, not arrays or scalars.",
          row_preview: badRow,
        });
      }
    }
  }
  if (hasOwn(payload, "row_count") && typeof payload.row_count !== "number") {
    failures.push({
      code: "runtime_row_count_not_number",
      message: "Runtime row_count must be numeric.",
      actual_type: typeof payload.row_count,
    });
  }
  return failures;
}

async function runRuntimeContracts(baseUrl) {
  const credentials = loadAgentryCredentials();
  const apiKey = credentials.apiKey;
  if (!apiKey) {
    return {
      ok: false,
      error: "No API key available. Set AGENTRY_PRIVATE_API_KEY or ~/.agentry/credentials.json to run --runtime.",
      project_id: null,
      cleanup: null,
      results: CONTRACTS.map((contract) => ({
        id: contract.id,
        method: contract.method,
        path: contract.path,
        ok: false,
        status: null,
        failures: [{
          code: "runtime_auth_missing",
          message: "No API key available for runtime contract probe.",
        }],
      })),
    };
  }
  const runId = `contract-runtime-${Date.now()}`;
  const configuredProject = loadConfiguredProjectId();
  let projectId = configuredProject?.projectId ?? null;
  const cleanup = {
    ok: true,
    project_strategy: configuredProject ? "configured_project" : "created_disposable_project",
    project_id_source: configuredProject?.source ?? null,
    project_cleanup_supported: false,
    created_project: false,
    project_deleted: null,
    project_delete_status: null,
    project_delete_ok: null,
    publication_id: null,
    publication_revoked: null,
    publication_revoke_status: null,
    publication_revoke_ok: null,
    failures: [],
  };
  if (!projectId) {
    const create = await httpJson(baseUrl, "POST", "/v1/projects", {
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": `${runId}-project-create`,
      },
      body: {
        name: `${runId}-project`,
        repo_url: "https://example.com/agentry-contract-runtime",
        local_path: `/tmp/${runId}`,
      },
    });
    if (create.status !== 200 || !create.json?.id) {
      return {
        ok: false,
        error: `Could not create runtime probe project: HTTP ${create.status}`,
        project_id: null,
        cleanup: {
          ...cleanup,
          ok: false,
          failures: [{
            code: "runtime_project_create_failed",
            message: "Could not create disposable project for runtime contract probe.",
            status: create.status,
          }],
        },
        results: CONTRACTS.map((contract) => ({
          id: contract.id,
          method: contract.method,
          path: contract.path,
          ok: false,
          status: create.status,
          failures: [{
            code: "runtime_project_create_failed",
            message: "Could not create disposable project for runtime contract probe.",
          }],
        })),
      };
    }
    projectId = create.json.id;
    cleanup.created_project = true;
  }
  const analyticsContract = CONTRACTS.find((contract) => contract.id === "analytics_query");
  const publicContract = CONTRACTS.find((contract) => contract.id === "public_query_execute");
  const results = [];

  if (analyticsContract) {
    const analytics = await httpJson(baseUrl, "POST", `/v1/projects/${projectId}/analytics/query`, {
      headers: { authorization: `Bearer ${apiKey}` },
      body: { query: "SELECT 1 AS contract_probe" },
    });
    const failures = analytics.status === 200
      ? runtimePayloadFailures(analyticsContract, analytics.json)
      : [{
        code: "runtime_status_unexpected",
        message: `Runtime analytics/query returned HTTP ${analytics.status}.`,
        status: analytics.status,
      }];
    results.push({
      id: analyticsContract.id,
      method: analyticsContract.method,
      path: analyticsContract.path,
      status: analytics.status,
      ok: failures.length === 0,
      failures,
      response_keys: analytics.json && typeof analytics.json === "object" && !Array.isArray(analytics.json)
        ? Object.keys(analytics.json)
        : [],
    });
  }

  if (publicContract) {
    const publish = await httpJson(baseUrl, "POST", `/v1/projects/${projectId}/public-queries`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": `${runId}-public-query-publish`,
      },
      body: {
        blueprint_id: "active_users_daily",
        params: { days: 7 },
        description: "Contract runtime probe",
      },
    });
    let publicRead = null;
    let failures = [];
    if (publish.status !== 200 || !publish.json?.id) {
      failures = [{
        code: "runtime_public_query_publish_failed",
        message: `Could not publish runtime public query probe: HTTP ${publish.status}.`,
        status: publish.status,
      }];
    } else {
      cleanup.publication_id = publish.json.id;
      try {
        publicRead = await httpJson(baseUrl, "GET", `/v1/public/q/${publish.json.id}`);
      } catch (error) {
        failures = [{
          code: "runtime_public_query_read_failed",
          message: "Runtime public-query read failed before response validation.",
          error: error instanceof Error ? error.message : String(error),
        }];
      }
      if (failures.length === 0) {
        failures = publicRead.status === 200
          ? runtimePayloadFailures(publicContract, publicRead.json)
          : [{
            code: "runtime_status_unexpected",
            message: `Runtime public-query read returned HTTP ${publicRead.status}.`,
            status: publicRead.status,
          }];
      }
      try {
        const revoke = await httpJson(
          baseUrl,
          "DELETE",
          `/v1/projects/${projectId}/public-queries/${publish.json.id}`,
          {
            headers: {
              authorization: `Bearer ${apiKey}`,
              "idempotency-key": `${runId}-public-query-revoke`,
            },
          },
        );
        cleanup.publication_revoke_status = revoke.status;
        cleanup.publication_revoked = revoke.status === 200 && revoke.json?.revoked === true;
        cleanup.publication_revoke_ok = cleanup.publication_revoked;
        if (!cleanup.publication_revoke_ok) {
          cleanup.ok = false;
          cleanup.failures.push({
            code: "runtime_public_query_revoke_failed",
            message: `Could not revoke temporary public query publication: HTTP ${revoke.status}.`,
            status: revoke.status,
          });
        }
      } catch (error) {
        cleanup.ok = false;
        cleanup.publication_revoke_ok = false;
        cleanup.failures.push({
          code: "runtime_public_query_revoke_failed",
          message: "Could not revoke temporary public query publication.",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    results.push({
      id: publicContract.id,
      method: publicContract.method,
      path: publicContract.path,
      status: publicRead?.status ?? publish.status,
      ok: failures.length === 0,
      failures,
      publication_id: publish.json?.id ?? null,
      response_keys: publicRead?.json && typeof publicRead.json === "object" && !Array.isArray(publicRead.json)
        ? Object.keys(publicRead.json)
        : [],
    });
  }

  if (cleanup.created_project && projectId) {
    try {
      const deleteProject = await deleteProjectDurably({
        idempotencyKey: `${runId}-project-delete`,
        maxWaitMs: Number(process.env.AGENTRY_CLEANUP_WAIT_MS ?? 120_000),
        acceptNotFound: true,
        attempt: ({ idempotencyKey }) => httpJson(
          baseUrl,
          "DELETE",
          `/v1/projects/${projectId}`,
          {
            headers: {
              authorization: `Bearer ${apiKey}`,
              "idempotency-key": idempotencyKey,
            },
          },
        ),
      });
      cleanup.project_delete_status = deleteProject.status;
      cleanup.project_deleted = deleteProject.deletion_complete === true;
      cleanup.project_delete_ok = cleanup.project_deleted;
      cleanup.project_cleanup_supported = true;
      cleanup.project_delete_attempts = deleteProject.deletion_attempts;
      if (!cleanup.project_delete_ok) {
        cleanup.ok = false;
        cleanup.failures.push({
          code: "runtime_project_delete_failed",
          message: `Could not delete disposable runtime probe project: HTTP ${deleteProject.status}.`,
          status: deleteProject.status,
        });
      }
    } catch (error) {
      cleanup.ok = false;
      cleanup.project_delete_ok = false;
      cleanup.failures.push({
        code: "runtime_project_delete_failed",
        message: "Could not delete disposable runtime probe project.",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ok: results.every((result) => result.ok) && cleanup.ok,
    error: null,
    project_id: projectId,
    cleanup,
    results,
  };
}

function mergeRuntimeResults(results, runtimeResults) {
  if (!runtimeResults) return results;
  return results.map((result) => {
    const runtime = runtimeResults.results?.find((item) => item.id === result.id) ?? null;
    const runtimeOk = runtime?.ok ?? null;
    return {
      ...result,
      runtime_ok: runtimeOk,
      runtime_status: runtime?.status ?? null,
      runtime_failures: runtime?.failures ?? null,
      runtime_response_keys: runtime?.response_keys ?? null,
      ok: result.ok && runtimeOk !== false,
    };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.localOnly) {
    const localResults = await checkLocalContracts();
    const summary = {
      api: null,
      checked_at: new Date().toISOString(),
      user_agent: USER_AGENT,
      ok: localResults.every((result) => result.ok),
      local_only: true,
      compare_local: true,
      local_comparison: {
        ok: localResults.every((result) => result.ok),
        error: null,
        results: localResults,
      },
      results: localResults.map((result) => ({
        ...result,
        source_status: result.ok ? "local_canonical" : "local_contract_gap",
        local_ok: result.ok,
        local_failures: result.failures,
      })),
    };
    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`Agentry local contract check: ${summary.ok ? "pass" : "fail"}`);
      for (const result of summary.results) {
        console.log(`- ${result.ok ? "PASS" : "FAIL"} ${result.method} ${result.path} [${result.source_status}]`);
        for (const failure of result.failures) {
          console.log(`  - ${failure.code}: ${failure.message}`);
        }
      }
    }
    if (!summary.ok) process.exit(1);
    return;
  }

  const results = [];
  for (const contract of CONTRACTS) {
    results.push(await checkContract(args.api, contract));
  }
  let runtimeResults = null;
  if (args.runtime) {
    runtimeResults = await runRuntimeContracts(args.api);
  }
  let localResults = null;
  let localComparisonError = null;
  if (args.compareLocal) {
    try {
      localResults = await checkLocalContracts();
    } catch (error) {
      localComparisonError = error instanceof Error ? error.message : String(error);
    }
  }
  const checkedResults = mergeRuntimeResults(results, runtimeResults);
  const resultsWithSource = checkedResults.map((result) => {
    const local = localResults?.find((item) => item.id === result.id) ?? null;
    return {
      ...result,
      source_status: args.compareLocal ? classifySourceStatus(result, local) : "live_only",
      local_ok: local?.ok ?? null,
      local_failures: local?.failures ?? null,
    };
  });
  const localOk = !args.compareLocal || (localResults != null && localResults.every((result) => result.ok));
  const runtimeOk = !args.runtime || runtimeResults?.ok === true;
  const summary = {
    api: args.api,
    checked_at: new Date().toISOString(),
    user_agent: USER_AGENT,
    ok: resultsWithSource.every((result) => result.ok) && localOk && runtimeOk,
    compare_local: args.compareLocal,
    runtime_probe: args.runtime
      ? {
        ok: runtimeOk,
        error: runtimeResults?.error ?? null,
        project_id: runtimeResults?.project_id ?? null,
        cleanup: runtimeResults?.cleanup ?? null,
        results: runtimeResults?.results ?? null,
      }
      : null,
    local_comparison: args.compareLocal
      ? {
        ok: localOk,
        error: localComparisonError,
        results: localResults,
      }
      : null,
    results: resultsWithSource,
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Agentry contract drift check: ${summary.ok ? "pass" : "fail"} (${args.api})`);
    if (localComparisonError) console.log(`Local comparison failed: ${localComparisonError}`);
    if (args.runtime && runtimeResults?.error) console.log(`Runtime probe failed: ${runtimeResults.error}`);
    for (const result of resultsWithSource) {
      console.log(`- ${result.ok ? "PASS" : "FAIL"} ${result.method} ${result.path} [${result.source_status}]`);
      for (const failure of result.failures) {
        console.log(`  - ${failure.code}: ${failure.message}`);
      }
      for (const failure of result.runtime_failures ?? []) {
        console.log(`  - ${failure.code}: ${failure.message}`);
      }
    }
  }

  if (!summary.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
