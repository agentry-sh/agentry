import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { sha256Hex } from "@agentrysh/shared";
import {
  accountDeletionFences,
  auditLog,
  billingMutationSecrets,
  billingMutationTargets,
  billingWebhookEvents,
  mutationCommands,
  users,
} from "@agentry/db/schema";
import {
  AUTH_BILLING_SUCCESS_URL,
  PUBLIC_PRICING_URL,
  PUBLIC_REPOSITORY_URL,
} from "../src/public-links.js";
import {
  disposeTestEnv,
  getDbForUrl,
  makeTestEnv,
  TEST_ENC_KEY,
  type TestEnv,
} from "./setup.js";

vi.mock("../src/db.js", async () => {
  const { getDbForUrl } = await import("./setup.js");
  return {
    getDb: (env: { TURSO_DATABASE_URL: string }) =>
      getDbForUrl(env.TURSO_DATABASE_URL),
  };
});

const { createApp } = await import("../src/index.js");

let env: TestEnv;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  env = {
    ...(await makeTestEnv({ withEncKey: true, fileDb: true })),
    STRIPE_SECRET_KEY: "sk_test_agentry",
    STRIPE_WEBHOOK_SECRET: "whsec_agentry",
    STRIPE_PRICE_NERVE: "price_nerve",
    BILLING_SUCCESS_URL: AUTH_BILLING_SUCCESS_URL,
    BILLING_CANCEL_URL: PUBLIC_PRICING_URL,
    AGENTRY_TOKEN_ENC_KEY: TEST_ENC_KEY,
  };
  app = createApp();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  disposeTestEnv(env);
});

async function call(
  path: string,
  init?: RequestInit & { json?: unknown },
  overrideEnv: TestEnv = env,
): Promise<Response> {
  const headers = new Headers(init?.headers ?? {});
  let body = init?.body;
  if (init?.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return app.fetch(
    new Request(`http://test${path}`, {
      method: init?.method ?? "GET",
      headers,
      body,
    }),
    overrideEnv,
  );
}

async function signup(email: string): Promise<{ apiKey: string; userId: string }> {
  const res = await call("/v1/auth/_test/login", {
    method: "POST",
    json: { email },
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { api_key: string; user_id: string };
  return { apiKey: data.api_key, userId: data.user_id };
}

async function createProject(apiKey: string, name: string): Promise<{ id: string }> {
  const res = await call("/v1/projects", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": `billing-project-${crypto.randomUUID()}`,
    },
    json: { name },
  });
  expect(res.status).toBe(200);
  return await res.json() as { id: string };
}

function signStripePayload(payload: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

describe("billing", () => {
  it("reports the unmetered free and Nerve billing contract without creating Stripe state", async () => {
    const user = await signup("billing-status@example.com");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const free = await call("/v1/billing/status", {
      headers: { authorization: `Bearer ${user.apiKey}` },
    });
    expect(free.status).toBe(200);
    const freeBody = await free.json() as {
      plan: string;
      plan_name: string;
      price_cents: number;
      continuous_automation_enabled: boolean;
      evidence_retention_days: number;
      billing: { status: string };
      upgrade: {
        configured: boolean;
        recommended_plan: string | null;
        checkout: { path: string; body: { plan: string } } | null;
      };
      billing_notice?: unknown;
    };
    expect(freeBody).toMatchObject({
      plan: "free",
      plan_name: "Open source",
      price_cents: 0,
      continuous_automation_enabled: false,
      evidence_retention_days: 90,
      upgrade: {
        configured: true,
        recommended_plan: "nerve",
        checkout: {
          path: "/v1/billing/checkout",
          body: { plan: "nerve" },
        },
      },
    });
    expect(freeBody.billing_notice).toBeUndefined();

    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await db.update(users).set({
      plan: "nerve",
      stripeCustomerId: "cus_status",
      stripeSubscriptionId: "sub_status",
      stripePriceId: "price_nerve",
      billingStatus: "active",
    }).where(eq(users.id, user.userId));

    const nerve = await call("/v1/billing/status", {
      headers: { authorization: `Bearer ${user.apiKey}` },
    });
    expect(nerve.status).toBe(200);
    expect(await nerve.json()).toMatchObject({
      plan: "nerve",
      plan_name: "Nerve",
      price_cents: 1_900,
      continuous_automation_enabled: true,
      evidence_retention_days: 90,
      billing: {
        stripe_customer_id: "cus_status",
        stripe_subscription_id: "sub_status",
        stripe_price_id: "price_nerve",
        status: "active",
      },
      upgrade: {
        recommended_plan: null,
        checkout: null,
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts only the Nerve checkout plan", async () => {
    const user = await signup("checkout-plan-boundary@example.com");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await call("/v1/billing/checkout", {
      method: "POST",
      headers: {
        authorization: `Bearer ${user.apiKey}`,
        "idempotency-key": "billing-checkout-invalid-plan-0001",
      },
      json: { plan: "pro" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "invalid_payload", details: { reason: "plan must be: nerve" } },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getDbForUrl(env.TURSO_DATABASE_URL).select().from(mutationCommands))
      .toHaveLength(0);
  });

  it("gates hosted automation enable on Nerve without metering customer events", async () => {
    const user = await signup("nerve-automation-gate@example.com");
    const project = await createProject(user.apiKey, "nerve-automation-gate");

    const gated = await call(`/v1/projects/${project.id}/automation-contract/enable`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.apiKey}` },
    });
    expect(gated.status).toBe(402);
    const gatedBody = await gated.json() as {
      error: {
        code: string;
        message: string;
        next_action: string;
        details: {
          plan: string;
          metered_by_events: boolean;
          bundled_inference: boolean;
        };
      };
    };
    expect(gatedBody.error).toMatchObject({
      code: "nerve_required",
      details: {
        plan: "free",
        metered_by_events: false,
        bundled_inference: false,
      },
    });
    expect(JSON.stringify(gatedBody)).not.toMatch(/quota|event cap|per.event/i);

    await getDbForUrl(env.TURSO_DATABASE_URL)
      .update(users)
      .set({ plan: "nerve" })
      .where(eq(users.id, user.userId));

    const admitted = await call(`/v1/projects/${project.id}/automation-contract/enable`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.apiKey}` },
    });
    expect(admitted.status).toBe(404);
    expect(await admitted.json()).toMatchObject({
      error: { code: "not_found", message: "automation_contract not found." },
    });
  });

  it("creates a Stripe checkout session and stores customer metadata", async () => {
    delete env.BILLING_SUCCESS_URL;
    delete env.BILLING_CANCEL_URL;
    const user = await signup("checkout@example.com");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const params = new URLSearchParams(String(init?.body ?? ""));
      if (url.endsWith("/v1/customers")) {
        expect(params.get("metadata[user_id]")).toBe(user.userId);
        return Response.json({ id: "cus_agentry" });
      }
      if (url.endsWith("/v1/checkout/sessions")) {
        expect(params.get("customer")).toBe("cus_agentry");
        expect(params.get("line_items[0][price]")).toBe("price_nerve");
        expect(params.get("metadata[plan]")).toBe("nerve");
        expect(params.get("success_url")).toBe(AUTH_BILLING_SUCCESS_URL);
        expect(params.get("cancel_url")).toBe(PUBLIC_PRICING_URL);
        return Response.json({
          id: "cs_agentry",
          url: "https://checkout.stripe.com/c/pay/cs_agentry",
          customer: "cus_agentry",
          subscription: null,
        });
      }
      return new Response("unexpected Stripe URL", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await call("/v1/billing/checkout", {
      method: "POST",
      headers: {
        authorization: `Bearer ${user.apiKey}`,
        "idempotency-key": "billing-checkout-create-0001",
      },
      json: { plan: "nerve" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checkout_url: string; session_id: string; plan: string };
    expect(body.checkout_url).toBe("https://checkout.stripe.com/c/pay/cs_agentry");
    expect(body.session_id).toBe("cs_agentry");
    expect(body.plan).toBe("nerve");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const row = (await db.select().from(users).where(eq(users.id, user.userId)).limit(1))[0];
    expect(row?.stripeCustomerId).toBe("cus_agentry");
    expect(row?.stripePriceId).toBe("price_nerve");
    expect(row?.billingStatus).toBe("checkout_started");
    expect(row?.plan).toBe("free");
  });

  it("rejects oversized checkout JSON before reserving or calling Stripe", async () => {
    const user = await signup("checkout-body-bound@example.com");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await call("/v1/billing/checkout", {
      method: "POST",
      headers: {
        authorization: `Bearer ${user.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": "billing-checkout-oversized-0001",
      },
      body: JSON.stringify({ plan: "nerve", padding: "x".repeat(17_000) }),
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: "payload_too_large" } });
    expect(fetchMock).not.toHaveBeenCalled();
    const commands = await getDbForUrl(env.TURSO_DATABASE_URL)
      .select().from(mutationCommands);
    expect(commands).toHaveLength(0);
  });

  it("returns an agent-readable configuration error when Stripe is not configured", async () => {
    const user = await signup("missing-stripe@example.com");
    const unconfigured: TestEnv = {
      ...env,
      STRIPE_SECRET_KEY: undefined,
      STRIPE_PRICE_NERVE: undefined,
    };

    const res = await call("/v1/billing/checkout", {
      method: "POST",
      headers: { authorization: `Bearer ${user.apiKey}` },
      json: { plan: "nerve" },
    }, unconfigured);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; next_action: string } };
    expect(body.error.code).toBe("billing_not_configured");
    expect(body.error.next_action).toContain("STRIPE_SECRET_KEY");
  });

  it("updates the user's plan from a signed Stripe subscription webhook", async () => {
    const user = await signup("webhook-plan@example.com");
    const payload = JSON.stringify({
      id: "evt_agentry",
      created: 1_799_999_999,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_agentry",
          customer: "cus_agentry",
          status: "active",
          current_period_end: 1_800_000_000,
          cancel_at_period_end: false,
          metadata: { user_id: user.userId, plan: "nerve" },
          items: { data: [{ price: { id: "price_nerve" } }] },
        },
      },
    });

    const res = await call("/v1/billing/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signStripePayload(payload, env.STRIPE_WEBHOOK_SECRET!),
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { handled: boolean; user_id: string; plan: string };
    expect(body.handled).toBe(true);
    expect(body.user_id).toBe(user.userId);
    expect(body.plan).toBe("nerve");

    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const row = (await db.select().from(users).where(eq(users.id, user.userId)).limit(1))[0];
    expect(row?.plan).toBe("nerve");
    expect(row?.stripeCustomerId).toBe("cus_agentry");
    expect(row?.stripeSubscriptionId).toBe("sub_agentry");
    expect(row?.stripePriceId).toBe("price_nerve");
    expect(row?.billingStatus).toBe("active");
    expect(row?.billingCurrentPeriodEnd).toBe(1_800_000_000);
    expect(row?.billingCancelAtPeriodEnd).toBe(0);
  });

  it("replays the same encrypted checkout URL without another Stripe effect", async () => {
    const user = await signup("checkout-replay@example.com");
    const providerKeys: Array<{ path: string; key: string | null; redirect: string | undefined }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      providerKeys.push({
        path: new URL(url).pathname,
        key: new Headers(init?.headers).get("idempotency-key"),
        redirect: init?.redirect,
      });
      if (url.endsWith("/v1/customers")) return Response.json({ id: "cus_replay" });
      if (url.endsWith("/v1/checkout/sessions")) {
        return Response.json({
          id: "cs_replay",
          url: "https://checkout.stripe.com/c/pay/cs_replay_secret",
          customer: "cus_replay",
          subscription: null,
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const headers = {
      authorization: `Bearer ${user.apiKey}`,
      "idempotency-key": "checkout-exact-replay-0001",
    };
    const first = await call("/v1/billing/checkout", {
      method: "POST",
      headers,
      json: {
        plan: "nerve",
        success_url: "https://example.com/billing/success?token=must-not-persist",
        cancel_url: "https://example.com/pricing?state=must-not-persist",
      },
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { checkout_url: string; command_id: string; idempotent_replay: boolean };
    expect(firstBody.checkout_url).toContain("cs_replay_secret");
    expect(firstBody.idempotent_replay).toBe(false);

    const replay = await call("/v1/billing/checkout", {
      method: "POST",
      headers,
      json: {
        plan: "nerve",
        success_url: "https://example.com/billing/success?token=must-not-persist",
        cancel_url: "https://example.com/pricing?state=must-not-persist",
      },
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as typeof firstBody;
    expect(replayBody.checkout_url).toBe(firstBody.checkout_url);
    expect(replayBody.command_id).toBe(firstBody.command_id);
    expect(replayBody.idempotent_replay).toBe(true);
    const changed = await call("/v1/billing/checkout", {
      method: "POST",
      headers,
      json: {
        plan: "nerve",
        success_url: "https://example.com/billing/different",
      },
    });
    expect(changed.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(providerKeys.map((entry) => entry.key)).toEqual([
      expect.stringMatching(/^agentry_customer_/),
      expect.stringMatching(/^agentry_checkout_/),
    ]);
    expect(providerKeys.every((entry) => entry.redirect === "manual")).toBe(true);

    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const command = (await db.select().from(mutationCommands)
      .where(eq(mutationCommands.id, firstBody.command_id)).limit(1))[0];
    const secret = (await db.select().from(billingMutationSecrets)
      .where(eq(billingMutationSecrets.commandId, firstBody.command_id)).limit(1))[0];
    const target = (await db.select().from(billingMutationTargets)
      .where(eq(billingMutationTargets.commandId, firstBody.command_id)).limit(1))[0];
    const audits = await db.select().from(auditLog)
      .where(eq(auditLog.resourceId, firstBody.command_id));
    expect(command?.responseJson).not.toContain("checkout.stripe.com");
    expect(command?.responseJson).not.toContain("cs_replay_secret");
    expect(secret?.responseEnc).not.toContain("checkout.stripe.com");
    expect(target?.targetJson).not.toContain("must-not-persist");
    expect(target?.targetJson).toContain("url_hash");
    expect(audits.map((row) => row.metadataJson).join("\n")).not.toContain("checkout.stripe.com");
  });

  it("retries a lost Stripe response with the same provider key and customer", async () => {
    const user = await signup("checkout-lost-response@example.com");
    const checkoutKeys: string[] = [];
    let customerCalls = 0;
    let checkoutCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/customers")) {
        customerCalls += 1;
        return Response.json({ id: "cus_lost" });
      }
      if (url.endsWith("/v1/checkout/sessions")) {
        checkoutCalls += 1;
        checkoutKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        if (checkoutCalls === 1) throw new TypeError("socket reset after provider persisted response");
        return Response.json({
          id: "cs_lost",
          url: "https://checkout.stripe.com/c/pay/cs_lost",
          customer: "cus_lost",
          subscription: null,
        });
      }
      return new Response("unexpected", { status: 500 });
    }));
    const headers = {
      authorization: `Bearer ${user.apiKey}`,
      "idempotency-key": "checkout-lost-response-0001",
    };
    const lost = await call("/v1/billing/checkout", {
      method: "POST",
      headers,
      json: { plan: "nerve" },
    });
    expect(lost.status).toBe(502);
    const recovered = await call("/v1/billing/checkout", {
      method: "POST",
      headers,
      json: { plan: "nerve" },
    });
    expect(recovered.status).toBe(200);
    expect(checkoutKeys).toHaveLength(2);
    expect(new Set(checkoutKeys).size).toBe(1);
    expect(customerCalls).toBe(1);
  });

  it("replays an encrypted portal URL without persisting the bearer value", async () => {
    const user = await signup("portal-replay@example.com");
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await db.update(users).set({ stripeCustomerId: "cus_portal" })
      .where(eq(users.id, user.userId));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/v1/billing_portal/sessions");
      expect(new Headers(init?.headers).get("idempotency-key")).toMatch(/^agentry_portal_/);
      const params = new URLSearchParams(String(init?.body ?? ""));
      expect(params.get("return_url")).toBe(PUBLIC_REPOSITORY_URL);
      return Response.json({
        id: "bps_replay",
        url: "https://billing.stripe.com/p/session/portal_secret",
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const headers = {
      authorization: `Bearer ${user.apiKey}`,
      "idempotency-key": "portal-exact-replay-0001",
    };
    const first = await call("/v1/billing/portal", { method: "POST", headers, json: {} });
    const replay = await call("/v1/billing/portal", { method: "POST", headers, json: {} });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    const firstBody = await first.json() as { url: string; command_id: string };
    const replayBody = await replay.json() as { url: string; idempotent_replay: boolean };
    expect(replayBody.url).toBe(firstBody.url);
    expect(replayBody.idempotent_replay).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const command = (await db.select().from(mutationCommands)
      .where(eq(mutationCommands.id, firstBody.command_id)).limit(1))[0];
    expect(command?.responseJson).not.toContain("billing.stripe.com");
  });

  it("serializes different checkout keys so concurrent requests cannot duplicate customers", async () => {
    const user = await signup("checkout-concurrency@example.com");
    let releaseCustomer!: () => void;
    let customerStarted!: () => void;
    const customerGate = new Promise<void>((resolve) => { releaseCustomer = resolve; });
    const started = new Promise<void>((resolve) => { customerStarted = resolve; });
    let customerCalls = 0;
    let sessionCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/customers")) {
        customerCalls += 1;
        customerStarted();
        await customerGate;
        return Response.json({ id: "cus_serial" });
      }
      if (url.endsWith("/v1/checkout/sessions")) {
        sessionCalls += 1;
        return Response.json({
          id: `cs_serial_${sessionCalls}`,
          url: `https://checkout.stripe.com/c/pay/cs_serial_${sessionCalls}`,
          customer: "cus_serial",
          subscription: null,
        });
      }
      return new Response("unexpected", { status: 500 });
    }));
    const firstPromise = call("/v1/billing/checkout", {
      method: "POST",
      headers: {
        authorization: `Bearer ${user.apiKey}`,
        "idempotency-key": "checkout-concurrent-first-0001",
      },
      json: { plan: "nerve" },
    });
    await started;
    const competing = await call("/v1/billing/checkout", {
      method: "POST",
      headers: {
        authorization: `Bearer ${user.apiKey}`,
        "idempotency-key": "checkout-concurrent-second-0001",
      },
      json: { plan: "nerve" },
    });
    expect(competing.status).toBe(202);
    expect(competing.headers.get("retry-after")).toBeTruthy();
    releaseCustomer();
    expect((await firstPromise).status).toBe(200);

    const second = await call("/v1/billing/checkout", {
      method: "POST",
      headers: {
        authorization: `Bearer ${user.apiKey}`,
        "idempotency-key": "checkout-concurrent-second-0001",
      },
      json: { plan: "nerve" },
    });
    expect(second.status).toBe(200);
    expect(customerCalls).toBe(1);
    expect(sessionCalls).toBe(2);
  });

  it("rolls back checkout completion when deterministic terminal audit evidence is poisoned", async () => {
    const user = await signup("checkout-audit-collision@example.com");
    let releaseCustomer!: () => void;
    let customerStarted!: () => void;
    const customerGate = new Promise<void>((resolve) => { releaseCustomer = resolve; });
    const started = new Promise<void>((resolve) => { customerStarted = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/customers")) {
        customerStarted();
        await customerGate;
        return Response.json({ id: "cus_audit_collision" });
      }
      if (url.endsWith("/v1/checkout/sessions")) {
        return Response.json({
          id: "cs_audit_collision",
          url: "https://checkout.stripe.com/c/pay/cs_audit_collision",
          customer: "cus_audit_collision",
          subscription: null,
        });
      }
      return new Response("unexpected", { status: 500 });
    }));

    const checkoutPromise = call("/v1/billing/checkout", {
      method: "POST",
      headers: {
        authorization: `Bearer ${user.apiKey}`,
        "idempotency-key": "checkout-audit-collision-0001",
      },
      json: { plan: "nerve" },
    });
    await started;
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const [intent] = await db.select().from(auditLog).where(and(
      eq(auditLog.userId, user.userId),
      eq(auditLog.action, "billing.checkout_session.created"),
      eq(auditLog.phase, "intent"),
    ));
    expect(intent).toBeDefined();
    const poisonedAuditId = `audit_${await sha256Hex(`${intent!.operationId}:succeeded`)}`;
    await db.insert(auditLog).values({
      ...intent!,
      id: poisonedAuditId,
      phase: "succeeded",
      requestHash: "poisoned-terminal-request-hash",
      metadataJson: "{}",
    });

    releaseCustomer();
    const response = await checkoutPromise;
    expect(response.status).toBe(500);
    const [command] = await db.select().from(mutationCommands).where(and(
      eq(mutationCommands.actorUserId, user.userId),
      eq(mutationCommands.action, "billing.checkout"),
    ));
    expect(command?.status).not.toBe("succeeded");
    expect(await db.select().from(billingMutationSecrets)
      .where(eq(billingMutationSecrets.commandId, command!.id))).toHaveLength(0);
    const [storedUser] = await db.select().from(users).where(eq(users.id, user.userId));
    expect(storedUser?.billingStatus).not.toBe("checkout_started");
    const [poisoned] = await db.select().from(auditLog)
      .where(eq(auditLog.id, poisonedAuditId));
    expect(poisoned?.requestHash).toBe("poisoned-terminal-request-hash");
  });

  it("deduplicates Stripe event ids and rejects stale subscription delivery order", async () => {
    const user = await signup("webhook-order@example.com");
    const send = async (event: Record<string, unknown>) => {
      const payload = JSON.stringify(event);
      return call("/v1/billing/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": signStripePayload(payload, env.STRIPE_WEBHOOK_SECRET!),
        },
        body: payload,
      });
    };
    const activeEvent = {
      id: "evt_order_z",
      created: 200,
      type: "customer.subscription.updated",
      data: { object: {
        id: "sub_order",
        customer: "cus_order",
        status: "active",
        cancel_at_period_end: false,
        current_period_end: 500,
        metadata: { user_id: user.userId, plan: "nerve" },
        items: { data: [{ price: { id: "price_nerve" } }] },
      } },
    };
    const active = await send(activeEvent);
    expect(active.status).toBe(200);
    expect((await active.json() as { applied: boolean }).applied).toBe(true);

    const sameSecond = await send({
      ...activeEvent,
      id: "evt_order_same_second",
      type: "customer.subscription.deleted",
      data: { object: { ...activeEvent.data.object, status: "canceled" } },
    });
    expect(sameSecond.status).toBe(200);
    const sameSecondBody = await sameSecond.json() as { delivery_status: string; applied: boolean; next_action: string };
    expect(sameSecondBody.delivery_status).toBe("ambiguous_order");
    expect(sameSecondBody.applied).toBe(false);
    expect(sameSecondBody.next_action).toContain("did not guess their order");

    const stale = await send({
      ...activeEvent,
      id: "evt_order_a",
      created: 100,
      type: "customer.subscription.deleted",
      data: { object: {
        ...(activeEvent.data.object),
        status: "canceled",
      } },
    });
    expect(stale.status).toBe(200);
    const staleBody = await stale.json() as { delivery_status: string; applied: boolean };
    expect(staleBody.delivery_status).toBe("stale");
    expect(staleBody.applied).toBe(false);

    const replay = await send(activeEvent);
    expect(replay.status).toBe(200);
    expect((await replay.json() as { idempotent_replay: boolean }).idempotent_replay).toBe(true);
    const changedReuse = await send({
      ...activeEvent,
      data: { object: { ...activeEvent.data.object, status: "past_due" } },
    });
    expect(changedReuse.status).toBe(409);

    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const row = (await db.select().from(users).where(eq(users.id, user.userId)).limit(1))[0];
    expect(row?.billingStatus).toBe("active");
    expect(row?.plan).toBe("nerve");
    expect(await db.select().from(billingWebhookEvents)).toHaveLength(3);
    const deletion = await call("/v1/auth/self_delete", {
      method: "POST",
      headers: {
        authorization: `Bearer ${user.apiKey}`,
        "idempotency-key": "webhook-order-delete-check-0001",
      },
      json: { confirm: "DELETE_AGENTRY_ACCOUNT" },
    });
    expect(deletion.status).toBe(409);
    const deletionBody = await deletion.json() as { error: { details: { billing: { blockers: string[] } } } };
    expect(deletionBody.error.details.billing.blockers).toContain("stripe_webhook_order_ambiguous");
  });

  it("caps Stripe webhook bodies and fences user updates during account deletion", async () => {
    const user = await signup("webhook-fence@example.com");
    const hugePayload = JSON.stringify({
      id: "evt_huge",
      created: 1,
      type: "noop",
      data: { object: { padding: "x".repeat(300_000) } },
    });
    const tooLarge = await call("/v1/billing/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signStripePayload(hugePayload, env.STRIPE_WEBHOOK_SECRET!),
      },
      body: hugePayload,
    });
    expect(tooLarge.status).toBe(413);

    const chunk = new TextEncoder().encode("x".repeat(100_000));
    const chunkedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const chunkedInit: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=1,v1=invalid",
      },
      body: chunkedBody,
      duplex: "half",
    };
    const chunked = await app.fetch(new Request("http://test/v1/billing/webhook", chunkedInit), env);
    expect(chunked.status).toBe(413);

    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await db.insert(accountDeletionFences).values({
      userId: user.userId,
      commandId: "account-delete-test",
    });
    const payload = JSON.stringify({
      id: "evt_fenced",
      created: 300,
      type: "customer.subscription.updated",
      data: { object: {
        id: "sub_fenced",
        customer: "cus_fenced",
        status: "active",
        cancel_at_period_end: false,
        current_period_end: 600,
        metadata: { user_id: user.userId, plan: "nerve" },
        items: { data: [{ price: { id: "price_nerve" } }] },
      } },
    });
    const fenced = await call("/v1/billing/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signStripePayload(payload, env.STRIPE_WEBHOOK_SECRET!),
      },
      body: payload,
    });
    expect(fenced.status).toBe(200);
    const fencedBody = await fenced.json() as { applied: boolean; delivery_status: string };
    expect(fencedBody.applied).toBe(false);
    expect(fencedBody.delivery_status).toBe("account_deletion_fenced");
    const row = (await db.select().from(users).where(eq(users.id, user.userId)).limit(1))[0];
    expect(row?.billingStatus).toBe("none");
  });

  it("blocks deletion while billing can charge, then preserves the safe Stripe snapshot", async () => {
    const user = await signup("billing-delete@example.com");
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await db.update(users).set({
      plan: "nerve",
      stripeCustomerId: "cus_delete",
      stripeSubscriptionId: "sub_delete",
      stripePriceId: "price_nerve",
      billingStatus: "active",
      billingCancelAtPeriodEnd: 0,
    }).where(eq(users.id, user.userId));

    const deletionHeaders = {
      authorization: `Bearer ${user.apiKey}`,
      "idempotency-key": "billing-account-delete-0001",
    };
    const blocked = await call("/v1/auth/self_delete", {
      method: "POST",
      headers: deletionHeaders,
      json: { confirm: "DELETE_AGENTRY_ACCOUNT" },
    });
    expect(blocked.status).toBe(409);
    const blockedBody = await blocked.json() as { error: { code: string; details: { billing: { billing_status: string } } } };
    expect(blockedBody.error.code).toBe("billing_cleanup_required");
    expect(blockedBody.error.details.billing.billing_status).toBe("active");
    expect(await db.select().from(accountDeletionFences)).toHaveLength(0);

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/v1/billing_portal/sessions")) {
        return Response.json({
          id: "bps_delete",
          url: "https://billing.stripe.com/p/session/delete_secret",
        });
      }
      return new Response("unexpected", { status: 500 });
    }));
    const portal = await call("/v1/billing/portal", {
      method: "POST",
      headers: {
        authorization: `Bearer ${user.apiKey}`,
        "idempotency-key": "billing-delete-portal-0001",
      },
      json: {},
    });
    expect(portal.status).toBe(200);

    const cancelPayload = JSON.stringify({
      id: "evt_delete_cancel",
      created: 700,
      type: "customer.subscription.updated",
      data: { object: {
        id: "sub_delete",
        customer: "cus_delete",
        status: "active",
        cancel_at_period_end: true,
        current_period_end: 900,
        metadata: { user_id: user.userId, plan: "nerve" },
        items: { data: [{ price: { id: "price_nerve" } }] },
      } },
    });
    const cancelled = await call("/v1/billing/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signStripePayload(cancelPayload, env.STRIPE_WEBHOOK_SECRET!),
      },
      body: cancelPayload,
    });
    expect(cancelled.status).toBe(200);

    const deleted = await call("/v1/auth/self_delete", {
      method: "POST",
      headers: deletionHeaders,
      json: { confirm: "DELETE_AGENTRY_ACCOUNT" },
    });
    expect(deleted.status).toBe(200);
    const deletedBody = await deleted.json() as {
      cleanup: { billing: { stripe_customer_id: string; stripe_subscription_id: string; billing_status: string; billing_cancel_at_period_end: boolean; snapshot_hash: string } };
    };
    expect(deletedBody.cleanup.billing).toMatchObject({
      stripe_customer_id: "cus_delete",
      stripe_subscription_id: "sub_delete",
      billing_status: "active",
      billing_cancel_at_period_end: true,
    });
    expect(deletedBody.cleanup.billing.snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(deletedBody)).not.toContain("billing.stripe.com");
  });

  it("makes account deletion lose cleanly to an already reserved checkout", async () => {
    const user = await signup("billing-delete-race@example.com");
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const customerStarted = new Promise<void>((resolve) => { started = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/v1/customers")) {
        started();
        await gate;
        return Response.json({ id: "cus_delete_race" });
      }
      if (String(input).endsWith("/v1/checkout/sessions")) {
        return Response.json({
          id: "cs_delete_race",
          url: "https://checkout.stripe.com/c/pay/cs_delete_race",
          customer: "cus_delete_race",
          subscription: null,
        });
      }
      return new Response("unexpected", { status: 500 });
    }));
    const checkout = call("/v1/billing/checkout", {
      method: "POST",
      headers: {
        authorization: `Bearer ${user.apiKey}`,
        "idempotency-key": "billing-delete-race-checkout-0001",
      },
      json: { plan: "nerve" },
    });
    await customerStarted;
    const deletion = await call("/v1/auth/self_delete", {
      method: "POST",
      headers: {
        authorization: `Bearer ${user.apiKey}`,
        "idempotency-key": "billing-delete-race-delete-0001",
      },
      json: { confirm: "DELETE_AGENTRY_ACCOUNT" },
    });
    expect(deletion.status).toBe(409);
    const deletionBody = await deletion.json() as { error: { code: string; details: { billing: { blockers: string[] } } } };
    expect(deletionBody.error.code).toBe("billing_cleanup_required");
    expect(deletionBody.error.details.billing.blockers).toContain("billing_mutation_nonterminal");
    release();
    expect((await checkout).status).toBe(200);
  });
});
