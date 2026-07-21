import assert from "node:assert/strict";
import test from "node:test";

import { onRequestGet as billingSuccess } from "../functions/billing/success.ts";
import { onRequestGet as health } from "../functions/health.ts";
import { onRequestGet as root } from "../functions/index.ts";
import { onRequest as securityMiddleware } from "../functions/_middleware.ts";

test("auth root returns to the canonical repository without retaining query data", async () => {
  const response = await root({
    request: new Request("https://auth.agentry.sh/?code=secret"),
  } as never);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://github.com/agentry-sh/agentry");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("health route identifies the non-authenticated browser page service", async () => {
  const response = await health({} as never);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "agentry-pages" });
});

test("billing return escapes checkout identifiers and points back to GitHub", async () => {
  const response = await billingSuccess({
    request: new Request("https://auth.agentry.sh/billing/success?session_id=%3Cscript%3E"),
  } as never);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /&lt;script&gt;/);
  assert.doesNotMatch(body, /<script>/);
  assert.match(body, /github\.com\/agentry-sh\/agentry/);
});

test("auth middleware adds a restrictive browser security policy", async () => {
  const response = await securityMiddleware({
    next: async () => new Response("ok", {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  } as never);
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});
