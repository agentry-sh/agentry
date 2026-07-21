import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectMountedRoutes, ROOT } from "./api-route-surface.mjs";

test("route inventory resolves its repository from the module, not cwd", () => {
  const expectedRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  assert.equal(ROOT, expectedRoot);
  const originalCwd = process.cwd();
  try {
    process.chdir("/tmp");
    const routes = collectMountedRoutes();
    assert.ok(routes.length > 100);
    assert.ok(routes.some((route) => route.method === "GET" && route.path === "/v1/openapi.json"));
  } finally {
    process.chdir(originalCwd);
  }
});
