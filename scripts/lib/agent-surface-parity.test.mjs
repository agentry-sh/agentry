import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalJson,
  compareAgentSurface,
  normalizedText,
} from "./agent-surface-parity.mjs";

test("JSON parity ignores object insertion order but not contract content", () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
  assert.equal(compareAgentSurface({
    id: "openapi",
    path: "/v1/openapi.json",
    kind: "json",
    expected: { paths: { "/v1/new": { get: {} } }, version: 2 },
    actual: { version: 2, paths: { "/v1/new": { get: {} } } },
  }).ok, true);
  const drift = compareAgentSurface({
    id: "openapi",
    path: "/v1/openapi.json",
    kind: "json",
    expected: { paths: { "/v1/new": { get: {} } } },
    actual: { paths: {} },
  });
  assert.equal(drift.ok, false);
  assert.equal(drift.failure, "live surface differs from the local release contract");
});

test("text parity normalizes transport newlines and fails closed on missing routes", () => {
  assert.equal(normalizedText("# Agent\r\n"), "# Agent\n");
  assert.equal(compareAgentSurface({
    id: "automation-doc",
    path: "/v1/docs/automation",
    kind: "text",
    expected: "# Agent\n",
    actual: "# Agent\r\n\r\n",
  }).ok, true);
  const missing = compareAgentSurface({
    id: "automation-playbooks",
    path: "/v1/automation-playbooks",
    kind: "json",
    expected: { count: 2 },
    actual: null,
    status: 404,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.actual_sha256, null);
  assert.match(missing.failure, /HTTP 404/);
});
