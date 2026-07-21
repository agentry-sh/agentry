import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  alerts,
  cases,
  projectDeletionFences,
  webhookDeliveries,
  webhookRecipientSets,
  webhooks,
} from "@agentry/db/schema";
import { uuidv7 } from "@agentrysh/shared";
import { disposeTestEnv, getDbForUrl, makeTestEnv, type TestEnv } from "./setup.js";

vi.mock("../src/db.js", async () => {
  const { getDbForUrl } = await import("./setup.js");
  return {
    getDb: (env: { TURSO_DATABASE_URL: string }) =>
      getDbForUrl(env.TURSO_DATABASE_URL),
  };
});

const { createApp } = await import("../src/index.js");
const {
  fireWebhooks,
  prepareWebhookOutbox,
  processWebhookDelivery,
} = await import("../src/webhooks.js");
const { webhookDeliveryDrainState } = await import("../src/external-mutation-boundary.js");
const { evaluateAlertRow } = await import("../src/alert-evaluation.js");

let env: TestEnv;
let app: ReturnType<typeof createApp>;
let outboundCalls: Array<{ url: string; init: RequestInit }>;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  env = await makeTestEnv({ withEncKey: true, fileDb: true });
  app = createApp();
  outboundCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    outboundCalls.push({ url, init: init ?? {} });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
  disposeTestEnv(env);
});

async function call(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<Response> {
  const headers = new Headers(init?.headers ?? {});
  let body = init?.body;
  if (init?.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return app.fetch(new Request(`http://test${path}`, {
    method: init?.method ?? "GET",
    headers,
    body,
  }), env);
}

async function setupProject() {
  const login = await call("/v1/auth/_test/login", {
    method: "POST",
    json: { email: `webhook-atomic-${Math.random()}@example.com` },
  });
  expect(login.status).toBe(200);
  const { api_key: apiKey } = await login.json() as { api_key: string };
  const create = await call("/v1/projects", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": `webhook-atomic-project-${crypto.randomUUID()}`,
    },
    json: { name: "webhook atomicity" },
  });
  expect(create.status).toBe(200);
  const project = await create.json() as { id: string };
  return { apiKey, projectId: project.id };
}

async function createWebhook(
  apiKey: string,
  projectId: string,
  url: string,
  events: string[],
): Promise<string> {
  const response = await call(`/v1/projects/${projectId}/webhooks`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": `webhook-atomic-create-${crypto.randomUUID()}`,
    },
    json: { url, events },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

async function insertWebhook(
  projectId: string,
  id: string,
  events: string[],
): Promise<void> {
  await getDbForUrl(env.TURSO_DATABASE_URL).insert(webhooks).values({
    id,
    projectId,
    url: `https://${id}.example.com/hook`,
    description: null,
    events: JSON.stringify(events),
    signingSecretPrefix: "whsec_test",
    signingSecretHash: "test",
    signingSecretEnc: null,
    signingSecretIv: null,
    active: 1,
    createdAt: Math.floor(Date.now() / 1000),
  });
}

describe("webhook source-event outbox", () => {
  it("does not let an earlier empty lookup suppress a later durable subscription", async () => {
    const { projectId } = await setupProject();
    expect(await fireWebhooks(
      env,
      projectId,
      "case.created",
      { case_id: "case_before_subscription" },
      { sourceEventId: "case:event_before_subscription:created" },
    )).toEqual([]);

    // Insert directly so this proof does not depend on an in-process cache
    // invalidation hook in the registration route.
    await insertWebhook(projectId, "hook_after_empty_lookup", ["case.created"]);
    const ids = await fireWebhooks(
      env,
      projectId,
      "case.created",
      { case_id: "case_after_subscription" },
      { sourceEventId: "case:event_after_subscription:created" },
    );
    expect(ids).toHaveLength(1);
    const rows = await getDbForUrl(env.TURSO_DATABASE_URL)
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.sourceEventId, "case:event_after_subscription:created"));
    expect(rows).toHaveLength(1);
  });

  it("freezes an empty recipient set so the same source event cannot reach a later subscription", async () => {
    const { projectId } = await setupProject();
    const options = { sourceEventId: "case:event_empty_frozen:created" } as const;
    expect(await fireWebhooks(
      env,
      projectId,
      "case.created",
      { case_id: "case_empty_frozen" },
      options,
    )).toEqual([]);

    await insertWebhook(projectId, "hook_created_after_empty_event", ["case.created"]);
    expect(await fireWebhooks(
      env,
      projectId,
      "case.created",
      { case_id: "case_empty_frozen" },
      options,
    )).toEqual([]);
    expect(outboundCalls).toHaveLength(0);

    const sets = await getDbForUrl(env.TURSO_DATABASE_URL)
      .select()
      .from(webhookRecipientSets)
      .where(eq(webhookRecipientSets.sourceEventId, options.sourceEventId));
    expect(sets).toHaveLength(1);
    expect(JSON.parse(sets[0]!.webhookIdsJson)).toEqual([]);
  });

  it("dedupes exact retries per subscriber and rejects source-id reuse for different evidence", async () => {
    const { apiKey, projectId } = await setupProject();
    await createWebhook(apiKey, projectId, "https://one.example.com/hook", ["case.created"]);
    await createWebhook(apiKey, projectId, "https://two.example.com/hook", ["case.*"]);

    const options = { sourceEventId: "case:event_0001:created" } as const;
    const firstIds = await fireWebhooks(
      env,
      projectId,
      "case.created",
      { case_id: "case_0001", message: "boom" },
      options,
    );
    expect(firstIds).toHaveLength(2);
    expect(outboundCalls).toHaveLength(2);

    const lateWebhookId = await createWebhook(
      apiKey,
      projectId,
      "https://late.example.com/hook",
      ["case.created"],
    );

    const replayIds = await fireWebhooks(
      env,
      projectId,
      "case.created",
      { case_id: "case_0001", message: "boom" },
      options,
    );
    expect(replayIds).toEqual(firstIds);
    expect(outboundCalls).toHaveLength(2);

    const rows = await getDbForUrl(env.TURSO_DATABASE_URL)
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.sourceEventId, options.sourceEventId));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.webhookId)).size).toBe(2);
    expect(rows.map((row) => row.webhookId)).not.toContain(lateWebhookId);
    expect(rows.every((row) => row.status === "succeeded")).toBe(true);
    expect(rows.map((row) => JSON.parse(row.payloadJson).source_event_id))
      .toEqual([options.sourceEventId, options.sourceEventId]);

    await expect(fireWebhooks(
      env,
      projectId,
      "case.created",
      { case_id: "case_0001", message: "different evidence" },
      options,
    )).rejects.toMatchObject({ code: "webhook_source_event_reused" });
  });

  it("cancels a prepared delivery when its subscription is disabled before the insert transaction", async () => {
    const { apiKey, projectId } = await setupProject();
    const webhookId = await createWebhook(
      apiKey,
      projectId,
      "https://disable-before-insert.example.com/hook",
      ["case.created"],
    );
    const outbox = await prepareWebhookOutbox(
      env,
      projectId,
      "case.created",
      { case_id: "case_disable_before_insert" },
      { sourceEventId: "case:event_disable_before_insert:created" },
    );
    expect(outbox.deliveries).toHaveLength(1);

    const disabled = await call(`/v1/projects/${projectId}/webhooks/${webhookId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(disabled.status).toBe(200);

    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await db.insert(webhookDeliveries).values(outbox.deliveries);
    const delivery = (
      await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, outbox.deliveryIds[0]!))
        .limit(1)
    )[0]!;
    expect(delivery).toMatchObject({
      status: "cancelled",
      lastError: "webhook_inactive_at_enqueue",
    });
    expect(await processWebhookDelivery(env, delivery.id, "disabled-before-insert-worker"))
      .toBe("skipped");
    expect(outboundCalls).toHaveLength(0);
  });

  it("cancels a delivery when the subscription becomes inactive during acquisition", async () => {
    const { apiKey, projectId } = await setupProject();
    const webhookId = await createWebhook(
      apiKey,
      projectId,
      "https://disable-on-acquire.example.com/hook",
      ["case.created"],
    );
    const outbox = await prepareWebhookOutbox(
      env,
      projectId,
      "case.created",
      { case_id: "case_disable_on_acquire" },
      { sourceEventId: "case:event_disable_on_acquire:created" },
    );
    const deliveryId = outbox.deliveryIds[0]!;
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await db.insert(webhookDeliveries).values(outbox.deliveries);
    await db.run(sql.raw(`
      CREATE TRIGGER disable_webhook_during_delivery_acquire
      AFTER UPDATE OF status ON webhook_deliveries
      WHEN NEW.id = '${deliveryId}' AND NEW.status = 'delivering'
      BEGIN
        UPDATE webhooks SET active = 0 WHERE id = '${webhookId}';
      END
    `));

    expect(await processWebhookDelivery(env, deliveryId, "disable-on-acquire-worker"))
      .toBe("skipped");
    expect(outboundCalls).toHaveLength(0);
    const delivery = (
      await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).limit(1)
    )[0]!;
    expect(delivery).toMatchObject({
      status: "cancelled",
      lastError: "webhook_disabled_before_send",
    });
  });

  it("rolls back every subscriber row when one outbox insert fails", async () => {
    const { projectId } = await setupProject();
    await insertWebhook(projectId, "hook_good", ["case.created"]);
    await insertWebhook(projectId, "hook_rejected", ["case.created"]);
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await db.run(sql.raw(`
      CREATE TRIGGER reject_one_webhook_delivery
      BEFORE INSERT ON webhook_deliveries
      WHEN NEW.webhook_id = 'hook_rejected'
      BEGIN
        SELECT RAISE(ABORT, 'injected outbox failure');
      END
    `));

    let insertFailure: unknown;
    try {
      await fireWebhooks(
        env,
        projectId,
        "case.created",
        { case_id: "case_atomic" },
        { sourceEventId: "case:event_atomic:created" },
      );
    } catch (error) {
      insertFailure = error;
    }
    expect(insertFailure).toBeInstanceOf(Error);
    const failureMessages: string[] = [];
    let current: unknown = insertFailure;
    while (current instanceof Error) {
      failureMessages.push(current.message);
      current = current.cause;
    }
    expect(failureMessages.join("\n")).toMatch(/injected outbox failure/i);

    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.sourceEventId, "case:event_atomic:created"));
    expect(rows).toHaveLength(0);
    expect(outboundCalls).toHaveLength(0);
  });

  it("does not let a stale worker overwrite a reclaimed lease completion", async () => {
    const { apiKey, projectId } = await setupProject();
    await createWebhook(apiKey, projectId, "https://lease.example.com/hook", ["case.created"]);

    let resolveFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    let fetchCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as URL | Request).toString();
      outboundCalls.push({ url, init: init ?? {} });
      fetchCount += 1;
      if (fetchCount === 1) return firstResponse;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const pending: Array<Promise<unknown>> = [];
    const [deliveryId] = await fireWebhooks(
      env,
      projectId,
      "case.created",
      { case_id: "case_lease" },
      {
        sourceEventId: "case:event_lease:created",
        waitUntil: (promise) => pending.push(promise),
      },
    );
    expect(deliveryId).toBeTruthy();
    await waitFor(() => fetchCount === 1);

    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await db
      .update(webhookDeliveries)
      .set({ lockedAt: Math.floor(Date.now() / 1000) - 121 })
      .where(eq(webhookDeliveries.id, deliveryId!));

    expect(await processWebhookDelivery(env, deliveryId!, "replacement-worker"))
      .toBe("delivered");
    resolveFirst(new Response("late failure", { status: 500 }));
    await Promise.all(pending);

    const row = (
      await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, deliveryId!))
        .limit(1)
    )[0]!;
    expect(row).toMatchObject({
      status: "succeeded",
      attemptCount: 1,
      lastStatusCode: 200,
      lastError: null,
    });
  });

  it("fences fresh workers and drains a held pre-fence delivery before project deletion", async () => {
    const { apiKey, projectId } = await setupProject();
    await createWebhook(apiKey, projectId, "https://held-project.example.com/hook", ["case.created"]);

    let resolveReceiver!: (response: Response) => void;
    const receiver = new Promise<Response>((resolve) => { resolveReceiver = resolve; });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as URL | Request).toString();
      outboundCalls.push({ url, init: init ?? {} });
      return receiver;
    }) as typeof fetch;
    const pending: Array<Promise<unknown>> = [];
    const [deliveryId] = await fireWebhooks(
      env,
      projectId,
      "case.created",
      { case_id: "case_held_project_delete" },
      {
        sourceEventId: "case:held_project_delete:created",
        waitUntil: (promise) => pending.push(promise),
      },
    );
    await waitFor(() => outboundCalls.length === 1);

    const deleteHeaders = {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": "held-webhook-project-delete-0001",
    };
    const draining = await call(`/v1/projects/${projectId}`, {
      method: "DELETE",
      headers: deleteHeaders,
    });
    expect(draining.status).toBe(202);
    const drainingBody = await draining.json() as {
      cleanup: { blocker: string };
      retry_after_seconds: number;
      webhook_delivery_drain: { active_delivery_count: number };
    };
    expect(drainingBody).toMatchObject({
      cleanup: { blocker: "external_webhook_drain_active" },
      webhook_delivery_drain: { active_delivery_count: 1 },
    });
    expect(draining.headers.get("retry-after")).toBe(String(drainingBody.retry_after_seconds));

    // A new isolate/worker cannot reclaim or cancel the pre-fence owner while
    // its bounded network request is still the thing deletion is draining.
    expect(await processWebhookDelivery(env, deliveryId!, "fresh-worker-behind-fence"))
      .toBe("skipped");
    expect(outboundCalls).toHaveLength(1);
    expect((await getDbForUrl(env.TURSO_DATABASE_URL)
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId!)))[0]?.status).toBe("delivering");

    await expect(fireWebhooks(
      env,
      projectId,
      "case.created",
      { case_id: "case_must_not_enqueue_behind_fence" },
      { sourceEventId: "case:must_not_enqueue_behind_fence:created" },
    )).rejects.toMatchObject({ code: "project_deletion_in_progress" });

    resolveReceiver(new Response("ok", { status: 200 }));
    await Promise.all(pending);
    const deleted = await call(`/v1/projects/${projectId}`, {
      method: "DELETE",
      headers: deleteHeaders,
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({
      deleted: true,
      cleanup: {
        webhook_delivery_drain: {
          drained: true,
          known_delivered_after_fence_count: 1,
          external_follow_up: { required: true },
        },
      },
    });
    expect(await processWebhookDelivery(env, deliveryId!, "fresh-worker-after-delete"))
      .toBe("skipped");
    expect(outboundCalls).toHaveLength(1);
  });

  it("drains a held pre-fence delivery before account deletion and retains its receiver manifest", async () => {
    const { apiKey, projectId } = await setupProject();
    await createWebhook(apiKey, projectId, "https://held-account.example.com/hook", ["case.created"]);

    let resolveReceiver!: (response: Response) => void;
    const receiver = new Promise<Response>((resolve) => { resolveReceiver = resolve; });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as URL | Request).toString();
      outboundCalls.push({ url, init: init ?? {} });
      return receiver;
    }) as typeof fetch;
    const pending: Array<Promise<unknown>> = [];
    await fireWebhooks(
      env,
      projectId,
      "case.created",
      { case_id: "case_held_account_delete" },
      {
        sourceEventId: "case:held_account_delete:created",
        waitUntil: (promise) => pending.push(promise),
      },
    );
    await waitFor(() => outboundCalls.length === 1);

    const deletionHeaders = {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": "held-webhook-account-delete-0001",
    };
    const confirmation = {
      confirm: "DELETE_AGENTRY_ACCOUNT",
    };
    const draining = await call("/v1/auth/self_delete", {
      method: "POST",
      headers: deletionHeaders,
      json: confirmation,
    });
    expect(draining.status).toBe(202);
    const drainingBody = await draining.json() as {
      cleanup: { blocker: string };
      retry_after_seconds: number;
    };
    expect(drainingBody.cleanup.blocker).toBe("external_webhook_drain_active");
    expect(draining.headers.get("retry-after")).toBe(String(drainingBody.retry_after_seconds));

    resolveReceiver(new Response("ok", { status: 200 }));
    await Promise.all(pending);
    const deleted = await call("/v1/auth/self_delete", {
      method: "POST",
      headers: deletionHeaders,
      json: confirmation,
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({
      status: "deleted",
      cleanup: {
        webhook_delivery_drain: {
          drained: true,
          known_delivered_after_fence_count: 1,
          external_follow_up: { required: true },
        },
      },
    });
    expect(outboundCalls).toHaveLength(1);
  });

  it("keeps deletion-time receiver samples bounded while preserving complete counts", async () => {
    const { projectId } = await setupProject();
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const now = Math.floor(Date.now() / 1_000);
    await db.insert(projectDeletionFences).values({
      projectId,
      commandId: "bounded-webhook-manifest-delete",
      reason: "project_delete",
      actor: "test",
      createdAt: now,
    });
    await db.insert(webhookDeliveries).values(Array.from({ length: 25 }, (_, index) => ({
      id: `bounded-known-delivery-${String(index).padStart(2, "0")}`,
      projectId,
      webhookId: null,
      sourceEventId: `bounded-known-source-${index}`,
      sourceEventHash: `bounded-known-hash-${index}`,
      event: "case.created",
      payloadJson: "{}",
      status: "succeeded" as const,
      attemptCount: 1,
      maxAttempts: 8,
      nextAttemptAt: now,
      lastAttemptAt: now,
      deliveredAt: now,
      lastStatusCode: 200,
      createdAt: now,
      updatedAt: now,
    })));

    const manifest = await webhookDeliveryDrainState(db, [projectId]);
    expect(manifest).toMatchObject({
      drained: true,
      known_delivered_after_fence_count: 25,
      unknown_outcome_count: 0,
      operation_ids_truncated: true,
      external_follow_up: { required: true },
    });
    expect(manifest.known_delivered_delivery_ids).toHaveLength(20);
    expect(manifest.known_delivered_delivery_ids[0]).toBe("bounded-known-delivery-00");
  });

  it("rolls an alert transition back when its outbox cannot be committed", async () => {
    const { projectId } = await setupProject();
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await insertWebhook(projectId, "alert_hook_rejected", ["alert.triggered"]);
    await db.insert(cases).values({
      id: "case_alert_atomic",
      projectId,
      providerIssueId: "case_alert_atomic",
      providerSnapshotHash: "a".repeat(64),
      providerProjectedAt: Math.floor(Date.now() / 1000),
      providerEventClassification: "customer_exception",
      fingerprint: "alert-atomic",
      errorType: "TypeError",
      message: "boom",
      status: "active",
      eventCount: 1,
      firstSeenAt: Math.floor(Date.now() / 1000),
      lastSeenAt: Math.floor(Date.now() / 1000),
    });
    const alertId = uuidv7();
    await db.insert(alerts).values({
      id: alertId,
      projectId,
      name: "atomic alert",
      recipeId: "active_cases_top",
      paramsJson: "{}",
      thresholdColumn: "event_count",
      thresholdOp: "gt",
      thresholdValue: "0",
      webhookId: "alert_hook_rejected",
      active: 1,
      createdAt: Math.floor(Date.now() / 1000),
    });
    await db.run(sql.raw(`
      CREATE TRIGGER reject_alert_webhook_delivery
      BEFORE INSERT ON webhook_deliveries
      WHEN NEW.webhook_id = 'alert_hook_rejected'
      BEGIN
        SELECT RAISE(ABORT, 'injected alert outbox failure');
      END
    `));

    const alert = (
      await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1)
    )[0]!;
    await expect(evaluateAlertRow(env, alert, () => undefined))
      .rejects.toThrow(/injected alert outbox failure/i);

    const after = (
      await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1)
    )[0]!;
    expect(after.lastState).toBeNull();
    expect(after.lastEvaluatedAt).toBeNull();
    const deliveries = await db
      .select()
      .from(webhookDeliveries)
      .where(and(
        eq(webhookDeliveries.webhookId, "alert_hook_rejected"),
        eq(webhookDeliveries.event, "alert.triggered"),
      ));
    expect(deliveries).toHaveLength(0);
  });

  it("does not let a stale evaluator transition an alert after it is disabled", async () => {
    const { apiKey, projectId } = await setupProject();
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await insertWebhook(projectId, "stale_alert_hook", ["alert.triggered"]);
    await db.insert(cases).values({
      id: "case_stale_alert",
      projectId,
      providerIssueId: "case_stale_alert",
      providerSnapshotHash: "b".repeat(64),
      providerProjectedAt: Math.floor(Date.now() / 1000),
      providerEventClassification: "customer_exception",
      fingerprint: "stale-alert",
      errorType: "TypeError",
      message: "boom",
      status: "active",
      eventCount: 1,
      firstSeenAt: Math.floor(Date.now() / 1000),
      lastSeenAt: Math.floor(Date.now() / 1000),
    });
    const alertId = uuidv7();
    await db.insert(alerts).values({
      id: alertId,
      projectId,
      name: "stale disabled alert",
      recipeId: "active_cases_top",
      paramsJson: "{}",
      thresholdColumn: "event_count",
      thresholdOp: "gt",
      thresholdValue: "0",
      webhookId: "stale_alert_hook",
      active: 1,
      createdAt: Math.floor(Date.now() / 1000),
    });
    const stale = (
      await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1)
    )[0]!;

    const disabled = await call(`/v1/projects/${projectId}/alerts/${alertId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(disabled.status).toBe(200);
    const result = await evaluateAlertRow(env, stale, () => undefined);
    expect(result.transitionEvent).toBeNull();

    const after = (
      await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1)
    )[0]!;
    expect(after).toMatchObject({ active: 0, lastState: null, lastEvaluatedAt: null });
    expect(await db
      .select()
      .from(webhookDeliveries)
      .where(and(
        eq(webhookDeliveries.webhookId, "stale_alert_hook"),
        eq(webhookDeliveries.event, "alert.triggered"),
      ))).toHaveLength(0);
    expect(outboundCalls).toHaveLength(0);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for asynchronous webhook work");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
