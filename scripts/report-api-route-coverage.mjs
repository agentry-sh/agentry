#!/usr/bin/env node

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, collectMountedRoutes } from "./lib/api-route-surface.mjs";

const TEST_DIR = join(ROOT, "apps/api/test");
const OUT_PATH = join(ROOT, "tmp/api-route-coverage.md");
const PRODUCTION_HIDDEN_ROUTE_KEYS = new Set([
  "POST /v1/auth/_test/login",
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function routePattern(path) {
  const parts = path.split(/(:[A-Za-z_][A-Za-z0-9_]*)/g).filter(Boolean);
  const body = parts.map((part) => {
    if (part.startsWith(":")) {
      return String.raw`(?:\$\{[^}]+\}|[^/"'\s` + "`" + String.raw`]+)`;
    }
    return escapeRegExp(part);
  }).join("");
  return new RegExp(body, "m");
}

function collectTests() {
  return readdirSync(TEST_DIR)
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((file) => ({
      file,
      text: readFileSync(join(TEST_DIR, file), "utf8"),
    }));
}

function findMatches(route, tests) {
  const pattern = routePattern(route.path);
  const hits = [];
  for (const test of tests) {
    if (pattern.test(test.text)) {
      hits.push(test.file);
      continue;
    }
  }
  return hits;
}

const tests = collectTests();
const routes = collectMountedRoutes()
  .filter((route) => !PRODUCTION_HIDDEN_ROUTE_KEYS.has(`${route.method} ${route.path}`))
  .map((route) => ({
    ...route,
    tests: findMatches(route, tests),
  }));

const uncovered = routes.filter((route) => route.tests.length === 0);
const covered = routes.length - uncovered.length;

const lines = [];
lines.push("# API Route Coverage");
lines.push("");
lines.push(`Generated on ${new Date().toISOString().slice(0, 10)}.`);
lines.push("");
lines.push(`- Total route declarations: ${routes.length}`);
lines.push(`- Covered by at least one test-file path match: ${covered}`);
lines.push(`- Uncovered by this heuristic: ${uncovered.length}`);
lines.push("");
lines.push("## Covered Routes");
lines.push("");
lines.push("| Status | Method | Path | Route File | Matching Test Files |");
lines.push("|---|---|---|---|---|");
for (const route of routes) {
  const status = route.tests.length > 0 ? "covered" : "missing";
  lines.push(
    `| ${status} | \`${route.method}\` | \`${route.path}\` | \`${route.routeFile}\` | ${
      route.tests.length > 0 ? route.tests.map((name) => `\`${name}\``).join(", ") : ""
    } |`,
  );
}

if (uncovered.length > 0) {
  lines.push("");
  lines.push("## Heuristic Gaps");
  lines.push("");
  lines.push("These routes did not match any test-file path strings and should be reviewed manually:");
  lines.push("");
  for (const route of uncovered) {
    lines.push(`- \`${route.method} ${route.path}\` in \`${route.routeFile}\``);
  }
}

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${lines.join("\n")}\n`);
console.log(JSON.stringify({
  out_path: OUT_PATH,
  total_routes: routes.length,
  covered_routes: covered,
  uncovered_routes: uncovered.length,
  uncovered,
}, null, 2));
