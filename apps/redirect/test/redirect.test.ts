import assert from "node:assert/strict";
import test from "node:test";

import { routeApexRequest } from "../src/index.ts";

test("apex and unknown marketing routes converge on the repository without queries", () => {
  for (const url of [
    "https://agentry.sh/?utm_source=private",
    "https://www.agentry.sh/old-page?token=secret",
  ]) {
    const response = routeApexRequest(new Request(url));
    assert.equal(response.status, 308);
    assert.equal(response.headers.get("location"), "https://github.com/agentry-sh/agentry");
  }
});

test("only the billing return keeps its provider query on the browser-page origin", () => {
  const response = routeApexRequest(new Request(
    "https://agentry.sh/billing/success?session_id=cs_test",
  ));
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(
    response.headers.get("location"),
    "https://auth.agentry.sh/billing/success?session_id=cs_test",
  );
});

test("retired device and invitation paths cannot carry their old secrets onward", () => {
  for (const source of [
    "https://agentry.sh/cli?code=ABCD-EFGH",
    "https://agentry.sh/invite/token-value",
  ]) {
    const response = routeApexRequest(new Request(source));
    assert.equal(response.status, 308);
    assert.equal(response.headers.get("location"), "https://github.com/agentry-sh/agentry");
  }
});

test("authored docs point directly to GitHub and strip accidental query data", () => {
  const install = routeApexRequest(new Request("https://agentry.sh/install.md?token=secret"));
  assert.equal(install.status, 308);
  assert.equal(
    install.headers.get("location"),
    "https://raw.githubusercontent.com/agentry-sh/agentry/main/INSTALL.md",
  );

  const privacy = routeApexRequest(new Request("https://agentry.sh/privacy?utm_source=old"));
  assert.equal(
    privacy.headers.get("location"),
    "https://github.com/agentry-sh/agentry/blob/main/PRIVACY.md",
  );
});

test("known legacy workflow links retain their exact GitHub destination", () => {
  for (const [source, expected] of [
    [
      "https://agentry.sh/workflows/deploy-regression?utm_source=old",
      "https://github.com/agentry-sh/agentry/blob/main/workflows/debugging/deploy-regression.md",
    ],
    [
      "https://agentry.sh/recipes/sourcemap-coverage-audit.md",
      "https://github.com/agentry-sh/agentry/blob/main/workflows/operations/sourcemap-coverage-audit.md",
    ],
  ]) {
    const response = routeApexRequest(new Request(source));
    assert.equal(response.status, 308);
    assert.equal(response.headers.get("location"), expected);
  }
});

test("unknown workflow-like paths fall back to the reviewable collection", () => {
  const response = routeApexRequest(new Request(
    "https://agentry.sh/workflows/retired-unknown-workflow?token=secret",
  ));
  assert.equal(response.status, 308);
  assert.equal(
    response.headers.get("location"),
    "https://github.com/agentry-sh/agentry/tree/main/workflows",
  );
});

test("the retired apex API proxy fails safely with an exact next action", async () => {
  const response = routeApexRequest(new Request("https://agentry.sh/v1/projects?token=secret"));
  assert.equal(response.status, 410);
  const body = await response.json() as Record<string, string>;
  assert.equal(body.canonical_url, "https://api.agentry.sh/v1/projects");
  assert.match(body.next_action, /original method, body, credentials, and idempotency key/);
  assert.doesNotMatch(JSON.stringify(body), /secret/);

  const mutation = routeApexRequest(new Request("https://agentry.sh/v1/projects?token=secret", {
    method: "POST",
    body: "private",
  }));
  assert.equal(mutation.status, 410);
  assert.equal(mutation.headers.get("location"), null);
  assert.doesNotMatch(await mutation.text(), /secret|private/);

  const head = routeApexRequest(new Request("https://agentry.sh/v1/projects", {
    method: "HEAD",
  }));
  assert.equal(head.status, 410);
  assert.equal(await head.text(), "");
});

test("adapter redirects retain only the canonical API path", () => {
  const response = routeApexRequest(new Request(
    "https://agentry.sh/adapters/AGENTS.md?token=must-not-move",
  ));
  assert.equal(response.status, 308);
  assert.equal(
    response.headers.get("location"),
    "https://api.agentry.sh/adapters/AGENTS.md",
  );
});

test("mutation requests are never redirected across origins", async () => {
  const response = routeApexRequest(new Request("https://agentry.sh/install.md", {
    method: "POST",
    headers: { authorization: "Bearer should-not-move" },
    body: "private",
  }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("location"), null);
  assert.doesNotMatch(await response.text(), /should-not-move|private/);
});
