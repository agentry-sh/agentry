import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { AgentryError, errors } from "@agentrysh/shared";
import authRoutes from "./routes/auth.js";
import projectRoutes from "./routes/projects.js";
import { caseRouter, projectScopedCases } from "./routes/cases.js";
import discoveryRoutes, { buildOpenApiSchema } from "./routes/discovery.js";
import deployRoutes from "./routes/deploys.js";
import analyticsRoutes from "./routes/analytics.js";
import queryBlueprintRoutes from "./routes/query-blueprints.js";
import nextStepsRoutes from "./routes/next-steps.js";
import webhookRoutes from "./routes/webhooks.js";
import healthRoutes from "./routes/health.js";
import alertRoutes from "./routes/alerts.js";
import userRoutes from "./routes/users.js";
import feedbackRoutes from "./routes/feedback.js";
import adminRoutes from "./routes/admin.js";
import billingRoutes from "./routes/billing.js";
import posthogConnectionRoutes from "./routes/posthog-connection.js";
import posthogResourceRoutes from "./routes/posthog-resources.js";
import publicQueriesRoutes, { publicRouter as publicQueryRunner } from "./routes/public-queries.js";
import auditRoutes from "./routes/audit.js";
import automationRunRoutes from "./routes/automation-runs.js";
import automationTriggerRoutes from "./routes/automation-triggers.js";
import automationVerificationRoutes from "./routes/automation-verification.js";
import projectCredentialRoutes from "./routes/project-credentials.js";
import automationControlRoutes from "./routes/automation-control.js";
import automationPlaybookRoutes from "./routes/automation-playbooks.js";
import automationWorkflowRoutes from "./routes/automation-workflows.js";
import automationWorkflowControlRoutes from "./routes/automation-workflow-controls.js";
import automationWorkflowRunRoutes from "./routes/automation-workflow-runs.js";
import onboardingRoutes from "./routes/onboarding.js";
import { evaluateAllActiveAlerts } from "./alert-evaluation.js";
import { processDueWebhookDeliveries } from "./webhooks.js";
import {
  boundedAutomationSweepErrorMessage,
  issueAllAutomationTriggers,
  sweepAutomationLifecycle,
} from "./automation-lifecycle.js";
import { applyRetention } from "./retention.js";
import type { AppBindings, Env } from "./env.js";
import { requireApiKey } from "./middleware.js";
import { canonicalRouteFor } from "./route-metadata.js";
import { sweepAutomationWorkflowTriggerEligibility } from "./automation-workflow-trigger-sweep.js";
import { PUBLIC_INSTALL_DOC_URL } from "./public-links.js";
import { sweepPosthogCaseProjections } from "./posthog-error-tracking.js";
import { sweepPosthogOauthAttempts } from "./posthog-connection.js";

type OpenApiOperation = {
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: unknown; examples?: unknown }>;
  };
};

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STABLE_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_ERROR_RESPONSE_BYTES = 16 * 1024;
const MAX_ERROR_RESPONSE_CHUNKS = 64;
const ERROR_RESPONSE_READ_TIMEOUT_MS = 25;
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function openApiPathMatches(template: string, path: string): boolean {
  const pattern = "^" + template
    .split(/(\{[^}/]+\})/g)
    .map((part) => part.startsWith("{") && part.endsWith("}") ? "[^/]+" : escapeRegExp(part))
    .join("") + "$";
  return new RegExp(pattern).test(path);
}

function extractSchemaRef(schema: unknown): string | undefined {
  return schema && typeof schema === "object" && !Array.isArray(schema) && typeof (schema as { $ref?: unknown }).$ref === "string"
    ? (schema as { $ref: string }).$ref
    : undefined;
}

function resolveLocalSchemaRef(openapi: {
  components?: { schemas?: Record<string, unknown> };
}, schemaRef: string | undefined): unknown | undefined {
  const prefix = "#/components/schemas/";
  if (!schemaRef?.startsWith(prefix)) return undefined;
  const name = schemaRef.slice(prefix.length);
  return openapi.components?.schemas?.[name];
}

function invalidPayloadSchemaDetails(
  method: string,
  pathname: string,
  existingDetails?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const openapi = buildOpenApiSchema() as {
    paths: Record<string, Record<string, OpenApiOperation>>;
    components?: { schemas?: Record<string, unknown> };
  };
  const lowerMethod = method.toLowerCase();
  const match = Object.entries(openapi.paths).find(([schemaPath, pathItem]) =>
    Boolean(pathItem[lowerMethod]) && (schemaPath === pathname || openApiPathMatches(schemaPath, pathname))
  );
  if (!match) return existingDetails;

  const [schemaPath, pathItem] = match;
  const operation = pathItem[lowerMethod];
  const media = operation?.requestBody?.content?.["application/json"];
  const bodySchema = media?.schema;
  const schemaRef = extractSchemaRef(bodySchema);
  const resolvedBodySchema = resolveLocalSchemaRef(openapi, schemaRef);
  const zod = existingDetails?.zod as
    | { fieldErrors?: Record<string, string[]>; formErrors?: string[] }
    | undefined;
  const zodIssues = Array.isArray(existingDetails?.zod_issues)
    ? existingDetails.zod_issues
        .map((issue) => {
          if (!issue || typeof issue !== "object" || Array.isArray(issue)) return null;
          const record = issue as Record<string, unknown>;
          const path = Array.isArray(record.path)
            ? record.path.map(String).join(".")
            : typeof record.path === "string"
              ? record.path
              : "";
          const message = typeof record.message === "string" ? record.message : "";
          return path && message ? { path, message } : null;
        })
        .filter((issue): issue is { path: string; message: string } => Boolean(issue))
    : [];
  const fieldErrors = zod?.fieldErrors ?? {};
  const missingFields = Object.entries(fieldErrors)
    .filter(([, messages]) => messages.some((message) => /required/i.test(message)))
    .map(([field]) => field);

  return {
    ...(existingDetails ?? {}),
    schema_path: schemaPath,
    schema_method: lowerMethod,
    schema_url: "/v1/openapi.json",
    schema_ref: schemaRef,
    request_body_required: operation?.requestBody?.required === true,
    request_body_schema: resolvedBodySchema ?? bodySchema,
    request_example: media?.examples,
    missing_fields: missingFields,
    field_errors: fieldErrors,
    issue_paths: zodIssues,
  };
}

function requestIdFrom(c: Context<AppBindings>): string {
  const incoming = c.req.header("x-agentry-request-id")?.trim();
  if (incoming && CANONICAL_UUID.test(incoming)) {
    return incoming.toLowerCase();
  }
  return crypto.randomUUID();
}

function requestIdFor(c: Context<AppBindings>): string {
  return c.get("requestId") ?? requestIdFrom(c);
}

const NON_RETRYABLE_RATE_LIMIT_CODES = new Set([
  "automation_workflow_effect_run_budget_exhausted",
  "automation_workflow_trigger_attempt_budget_exhausted",
]);

const RETRYABLE_CONFLICT_CODES = new Set([
  "automation_workflow_effect_reconciliation_not_due",
  "automation_workflow_lease_busy",
  "automation_workflow_lease_contention",
  "automation_workflow_pause_contention",
  "automation_workflow_start_contention",
  "automation_workflow_system_node_claim_active",
  "automation_workflow_system_node_claim_contention",
  "automation_workflow_system_node_claim_fence_lost",
  "automation_workflow_system_node_claim_stale",
  "automation_workflow_trigger_receipt_not_yet_available",
]);

function retryAfterSeconds(error: AgentryError): number | null {
  if (!isRetryableError(error.status, error.code)) return null;
  const details = error.details;
  if (!details) return null;
  const retryAt = ["retry_at", "next_reconcile_at", "expires_at", "available_at"]
    .map((field) => details[field])
    .find((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  if (typeof retryAt !== "number") return null;
  return Math.max(1, retryAt - Math.floor(Date.now() / 1_000));
}

function errorHeaders(requestId: string, error?: AgentryError) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-agentry-request-id": requestId,
  };
  const retryAfter = error ? retryAfterSeconds(error) : null;
  if (retryAfter !== null) headers["retry-after"] = String(retryAfter);
  return headers;
}

function isRetryableError(status: number, code: string): boolean {
  if (status === 429) return !NON_RETRYABLE_RATE_LIMIT_CODES.has(code);
  return status >= 500 || RETRYABLE_CONFLICT_CODES.has(code);
}

async function stableErrorCodeFromResponse(response: Response): Promise<string | undefined> {
  if (response.status < 400) return undefined;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) return undefined;
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null
    && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_ERROR_RESPONSE_BYTES)
  ) {
    return undefined;
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    reader = response.clone().body?.getReader();
    if (!reader) return undefined;
    const timeoutResult = Symbol("error-response-timeout");
    const readResult = (async (): Promise<string | undefined> => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader!.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (
          size > MAX_ERROR_RESPONSE_BYTES
          || chunks.length >= MAX_ERROR_RESPONSE_CHUNKS
        ) {
          void reader!.cancel().catch(() => {});
          return undefined;
        }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
        error?: { code?: unknown };
      };
      const code = parsed?.error?.code;
      return typeof code === "string" && STABLE_ERROR_CODE.test(code)
        ? code
        : undefined;
    })();
    const result = await Promise.race([
      readResult,
      new Promise<typeof timeoutResult>((resolve) => {
        timeout = setTimeout(
          () => resolve(timeoutResult),
          ERROR_RESPONSE_READ_TIMEOUT_MS,
        );
      }),
    ]);
    if (result === timeoutResult) {
      void reader.cancel().catch(() => {});
      return undefined;
    }
    return result;
  } catch {
    return undefined;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    try {
      reader?.releaseLock();
    } catch {
      // The cloned response is telemetry-only; cleanup is best-effort.
    }
  }
}

function isPrivateStatefulPath(path: string): boolean {
  return (
    path === "/v1/me" ||
    path.startsWith("/admin/") ||
    path.startsWith("/v1/auth/") ||
    path.startsWith("/v1/projects") ||
    path.startsWith("/v1/cases") ||
    path.startsWith("/v1/automation-") ||
    path.startsWith("/v1/admin/") ||
    path.startsWith("/v1/billing") ||
    path.startsWith("/v1/audit")
  );
}

function errorBodyWithRuntimeMetadata(
  body: ReturnType<AgentryError["toResponseBody"]>,
  opts: { requestId: string; retryable: boolean },
): ReturnType<AgentryError["toResponseBody"]> {
  return {
    error: {
      ...body.error,
      request_id: opts.requestId,
      retryable: opts.retryable,
    },
  };
}

export function apiObservabilityMiddleware(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const start = Date.now();
    const requestId = requestIdFrom(c);
    const path = new URL(c.req.url).pathname;
    c.set("requestId", requestId);
    c.header("x-agentry-request-id", requestId);
    if (isPrivateStatefulPath(path)) {
      c.header("cache-control", "no-store");
      c.header("vary", "Authorization");
    }
    let status = 0;
    let settledDurationMs: number | null = null;
    try {
      await next();
      status = c.res.status;
      settledDurationMs = Date.now() - start;
      if (status >= 400 && !c.get("endpointErrorCode")) {
        const directErrorCode = await stableErrorCodeFromResponse(c.res);
        if (directErrorCode) c.set("endpointErrorCode", directErrorCode);
      }
    } catch (err) {
      status = err instanceof AgentryError ? err.status : 500;
      settledDurationMs = Date.now() - start;
      c.set("endpointErrorCode", err instanceof AgentryError ? err.code : "unhandled");
      throw err;
    } finally {
      try {
        const durationMs = settledDurationMs ?? Date.now() - start;
        const route = canonicalRouteFor(c);
        const method = c.req.method.toUpperCase();
        const errorCode = c.get("endpointErrorCode");
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            request_id: requestId,
            method,
            route,
            status,
            dur_ms: durationMs,
            ...(errorCode ? { error_code: errorCode } : {}),
          }),
        );
      } catch {
        console.warn(JSON.stringify({
          ts: new Date().toISOString(),
          component: "api_observability",
          request_id: requestId,
          status,
          dropped: true,
          reason: "instrumentation_error",
        }));
      }
    }
  };
}

export async function apiErrorHandler(
  err: Error,
  c: Context<AppBindings>,
): Promise<Response> {
  const requestId = requestIdFor(c);
  if (err instanceof AgentryError) {
    c.set("endpointErrorCode", err.code);
    if (err.code === "invalid_payload") {
      const details = invalidPayloadSchemaDetails(
        c.req.method,
        new URL(c.req.url).pathname,
        err.details,
      );
      return new Response(JSON.stringify(errorBodyWithRuntimeMetadata({
        error: {
          code: err.code,
          message: err.message,
          next_action:
            "Use details.schema_path + details.schema_method to fetch the exact operation from /v1/openapi.json, fix the payload, then retry.",
          ...(details ? { details } : {}),
        },
      }, { requestId, retryable: false })), {
        status: err.status,
        headers: errorHeaders(requestId),
      });
    }
    return new Response(JSON.stringify(errorBodyWithRuntimeMetadata(
      err.toResponseBody(),
      { requestId, retryable: isRetryableError(err.status, err.code) },
    )), {
      status: err.status,
      headers: errorHeaders(requestId, err),
    });
  }
  c.set("endpointErrorCode", "unhandled");
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    request_id: requestId,
    route: canonicalRouteFor(c),
    error_code: "unhandled",
  }));
  const internal = errors.internal();
  return new Response(JSON.stringify(errorBodyWithRuntimeMetadata(
    internal.toResponseBody(),
    { requestId, retryable: true },
  )), {
    status: 500,
    headers: errorHeaders(requestId),
  });
}

export function createApp() {
  const app = new Hono<AppBindings>();

  // One settled-response boundary owns API analytics and endpoint cases.
  app.use("*", apiObservabilityMiddleware());

  // Centralized error response shaping. The outer finalizer owns case emission.
  app.onError(apiErrorHandler);

  app.notFound((c) => {
    const requestId = requestIdFor(c);
    const e = errors.notFound("route");
    return new Response(JSON.stringify(errorBodyWithRuntimeMetadata(
      e.toResponseBody(),
      { requestId, retryable: false },
    )), {
      status: 404,
      headers: errorHeaders(requestId),
    });
  });

  // Discovery / root
  app.route("/", discoveryRoutes);

  app.get("/v1/me", requireApiKey(), (c) => {
    const user = c.get("user");
    const apiKey = c.get("apiKey");
    return c.json({
      user: {
        id: user.id,
        email: user.email,
      },
      api_key: {
        id: apiKey.id,
        prefix: apiKey.prefix,
        kind: apiKey.kind,
      },
      projects_url: "/v1/projects",
      schema_url: "/v1/openapi.json",
      next_action:
        `Authentication is valid. For a first installation, POST /v1/projects to create the project for this repository, retain the response in private temporary storage until plan approval, and continue the numbered guide at ${PUBLIC_INSTALL_DOC_URL}.`,
    });
  });

  // Auth
  app.route("/v1/auth", authRoutes);

  // Scoped runner routes must be registered before the broad project router,
  // whose owner/member middleware intentionally rejects runner credentials.
  app.route("/", automationRunRoutes);
  app.route("/", automationTriggerRoutes);
  app.route("/", automationVerificationRoutes);
  app.route("/v1", projectScopedCases);
  app.route("/", projectCredentialRoutes);
  app.route("/", automationControlRoutes);
  app.route("/", automationPlaybookRoutes);
  app.route("/", automationWorkflowControlRoutes);
  app.route("/", automationWorkflowRunRoutes);
  app.route("/", automationWorkflowRoutes);
  // Onboarding owns its exact project paths before the broad project router.
  app.route("/", onboardingRoutes);

  // Projects (also nests project-scoped subroutes via path, see below)
  app.route("/v1/projects", projectRoutes);

  // Cases by id: /v1/cases/:case_id
  app.route("/v1/cases", caseRouter);

  // Deploy events (POST CI-credential auth, GET private-key auth, full paths)
  app.route("/", deployRoutes);

  // Bounded read-only queries against the customer's PostHog Cloud project.
  app.route("/", analyticsRoutes);

  // Typed, bounded reads for PostHog recordings, flags, surveys, and experiments.
  app.route("/", posthogResourceRoutes);

  // Query blueprints — deterministic templates for common asks.
  app.route("/", queryBlueprintRoutes);

  // Suggested next-steps for post-setup conversational prompts.
  app.route("/", nextStepsRoutes);

  // Webhook subscriptions (signed POST delivery on case.created / case.resolved / deploy.recorded).
  app.route("/", webhookRoutes);

  // Project health (last_event_at, usage, webhook health).
  app.route("/", healthRoutes);

  // Alerts (human configuration/read plus platform evaluation; runners consume receipts).
  app.route("/", alertRoutes);

  // User identification views (per-project + per-case).
  app.route("/", userRoutes);

  // Agent-filed feedback (POST + GET, API-key auth).
  app.route("/", feedbackRoutes);

  // User-facing usage view (api-key auth).

  // Billing status, Stripe Checkout/Portal, and Stripe webhook plan sync.
  app.route("/", billingRoutes);

  // Customer-owned PostHog Cloud OAuth connection and public OAuth callback.
  app.route("/", posthogConnectionRoutes);

  // Admin-only usage inspection (ADMIN_TOKEN auth).
  app.route("/", adminRoutes);

  // Owner-side publish/list/revoke (api-key auth).
  app.route("/", publicQueriesRoutes);

  // Visitor-side execution — open CORS, unguessable publication capability, rate-limited.
  app.route("/", publicQueryRunner);

  // Audit log of agent-driven mutations (api-key auth).
  app.route("/", auditRoutes);

  return app;
}

const app = createApp();

const CORE_DB_MAINTENANCE_RETRY_AFTER_SECONDS = 60;
const CORE_DB_MAINTENANCE_INVALID_ID = "invalid-maintenance-value";
const CORE_DB_MAINTENANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function coreDbMaintenanceId(env: Env): string | null {
  const value: unknown = env.AGENTRY_CORE_DB_MAINTENANCE;
  if (value === undefined || value === "off") return null;
  return typeof value === "string" && CORE_DB_MAINTENANCE_ID_PATTERN.test(value)
    ? value
    : CORE_DB_MAINTENANCE_INVALID_ID;
}

function coreDbMaintenanceResponse(maintenanceId: string): Response {
  return new Response(JSON.stringify({
    error: {
      code: "core_db_maintenance",
      message: "Agentry is temporarily unavailable while core database maintenance is in progress.",
      next_action: "Honor Retry-After and retry the same request without changing its credentials or payload.",
      retryable: true,
      details: {
        maintenance_id: maintenanceId,
      },
    },
  }), {
    status: 503,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "retry-after": String(CORE_DB_MAINTENANCE_RETRY_AFTER_SECONDS),
      "x-agentry-maintenance-id": maintenanceId,
    },
  });
}

type MinuteSweepName =
  | "webhook_deliveries"
  | "posthog_oauth_attempts"
  | "posthog_errors"
  | "automation_lifecycle"
  | "automation_triggers"
  | "automation_workflow_triggers";

/** Run every minute-owned subsystem independently and await every settlement. */
export async function runMinuteAutomationAndDeliverySweep(
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const jobs: Array<{ name: MinuteSweepName; run: () => Promise<unknown> }> = [
    {
      name: "webhook_deliveries",
      run: () => processDueWebhookDeliveries(env, { limit: 100 }),
    },
    {
      name: "posthog_oauth_attempts",
      run: () => sweepPosthogOauthAttempts(env, {
        expiry_limit: 50,
        purge_limit: 100,
      }),
    },
    {
      name: "posthog_errors",
      run: async () => {
        const projection = await sweepPosthogCaseProjections(env, {
          projectLimit: 50,
          issueLimit: 100,
        });
        return {
          projection,
          error_count: projection.errors.length,
          errors: projection.errors,
        };
      },
    },
    {
      name: "automation_lifecycle",
      run: () => sweepAutomationLifecycle(env),
    },
    {
      name: "automation_triggers",
      run: () => issueAllAutomationTriggers(env),
    },
    {
      name: "automation_workflow_triggers",
      run: () => sweepAutomationWorkflowTriggerEligibility(env),
    },
  ];
  const settled = await Promise.allSettled(
    jobs.map((job) => Promise.resolve().then(job.run)),
  );
  const report: Record<string, unknown> = {
    ts: new Date().toISOString(),
    cron: "minute_automation_and_delivery_sweep",
  };
  settled.forEach((outcome, index) => {
    const name = jobs[index]!.name;
    if (outcome.status === "fulfilled") {
      const value = outcome.value as {
        error_count?: unknown;
        error_limit?: unknown;
        errors?: unknown;
        errors_truncated?: unknown;
      } | null;
      const recordErrorCount = value && typeof value.error_count === "number"
        ? value.error_count
        : 0;
      report[name] = {
        status: recordErrorCount > 0 ? "fulfilled_with_errors" : "fulfilled",
        result: outcome.value,
      };
      if (recordErrorCount > 0) {
        console.error(JSON.stringify({
          ts: new Date().toISOString(),
          cron: "minute_automation_and_delivery_sweep",
          sweep: name,
          error_count: recordErrorCount,
          error_limit: value?.error_limit,
          errors: value?.errors,
          errors_truncated: value?.errors_truncated,
        }));
      }
      return;
    }
    const error = boundedAutomationSweepErrorMessage(outcome.reason);
    report[name] = { status: "rejected", error };
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      cron: "minute_automation_and_delivery_sweep",
      sweep: name,
      error,
    }));
  });
  console.log(JSON.stringify(report));
}

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
    const maintenanceId = coreDbMaintenanceId(env);
    if (maintenanceId !== null) {
      return coreDbMaintenanceResponse(maintenanceId);
    }
    return app.fetch(request, env, ctx);
  },
  // Cron-triggered background work. Schedules live in wrangler.toml [triggers]:
  // "10 1 * * *" runs bounded control-plane retention; "*/15 * * * *"
  // evaluates every active alert. Errors are
  // logged but never thrown — cron retries handle it.
  scheduled: async (event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    if (coreDbMaintenanceId(env) !== null) return;
    if (event.cron === "* * * * *") {
      ctx.waitUntil(runMinuteAutomationAndDeliverySweep(env, ctx));
      return;
    }
    if (event.cron === "*/15 * * * *") {
      ctx.waitUntil(
        (async () => {
          try {
            const sweep = await evaluateAllActiveAlerts(env, (p) => ctx.waitUntil(p));
            console.log(
              JSON.stringify({
                ts: new Date().toISOString(),
                cron: "alert_sweep",
                ...sweep,
              }),
            );
          } catch (err) {
            console.error(
              JSON.stringify({
                ts: new Date().toISOString(),
                cron: "alert_sweep",
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        })(),
      );
      return;
    }
    ctx.waitUntil(
      (async () => {
        try {
          const retention = await applyRetention(env);
          console.log(
            JSON.stringify({
              ts: new Date().toISOString(),
              cron: "control_plane_retention",
              retention_deleted: retention.deleted,
            }),
          );
        } catch (err) {
          console.error(
            JSON.stringify({
              ts: new Date().toISOString(),
              cron: "scheduled",
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
