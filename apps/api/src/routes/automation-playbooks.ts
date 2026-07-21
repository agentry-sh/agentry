import { Hono } from "hono";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  AutomationContractSchema,
  errors,
  prepareTelemetryObservation,
} from "@agentrysh/shared";
import {
  automationContracts,
  posthogConnections,
  projectCredentials,
} from "@agentry/db/schema";
import {
  AUTOMATION_PLAYBOOK_BLUEPRINT_IDS,
  AUTOMATION_PLAYBOOK_IDS,
  getAutomationPlaybookTemplate,
  listAutomationPlaybookTemplates,
  renderAutomationPlaybook,
  renderRequestSchemaFor,
  serializeAutomationPlaybookTemplate,
  type AutomationPlaybookId,
  type AutomationPlaybookReadinessContext,
} from "../automation-playbooks.js";
import { automationContractEtag } from "../automation-contracts.js";
import { readBoundedJson } from "../bounded-json.js";
import { getDb } from "../db.js";
import type { AppBindings } from "../env.js";
import { evaluateOnboardingReadiness, loadVerifiedOnboarding } from "../onboarding-readiness.js";
import {
  requireApiKeyOrAutomationRunner,
  requireProjectAccess,
} from "../middleware.js";
import { getQueryBlueprint } from "../query-blueprints.js";

const router = new Hono<AppBindings>();

router.get("/v1/automation-playbooks", async (c) => {
  const playbooks = await Promise.all(
    listAutomationPlaybookTemplates().map(serializeAutomationPlaybookTemplate),
  );
  return c.json({
    kind: "automation_playbook_catalog",
    count: playbooks.length,
    version_policy: "immutable_semver",
    list_policy: "latest_version_per_template",
    playbooks,
    next_action:
      "Read one exact template version, collect its project-specific bindings without secrets or telemetry, then call its project-scoped render endpoint. Rendering is read-only and always returns a disabled candidate.",
  });
});

router.get("/v1/automation-playbooks/:id", async (c) => {
  const template = getAutomationPlaybookTemplate(
    c.req.param("id"),
    c.req.query("version") || undefined,
  );
  if (!template) throw errors.notFound("automation_playbook");
  return c.json({
    ...(await serializeAutomationPlaybookTemplate(template)),
    next_action:
      "Supply the exact immutable version, strict bindings, and readiness assertions to the project render endpoint. Never include credentials or raw telemetry. Unknown or authority-expanding fields are rejected.",
  });
});

router.post(
  "/v1/projects/:project_id/automation-playbooks/:id/render",
  requireApiKeyOrAutomationRunner(),
  async (c) => {
    const principal = c.get("projectCredential");
    if (principal) {
      throw errors.credentialScopeDenied(
        "human_project_member_required",
        principal.kind,
        { operation: "render_automation_playbook" },
      );
    }
    const projectId = c.req.param("project_id");
    await requireProjectAccess(c, projectId);
    const id = c.req.param("id");
    if (!isAutomationPlaybookId(id)) throw errors.notFound("automation_playbook");

    const body = await readBoundedJson(c, 65_536);

    // A renderer has no reason to receive credentials. Reject before schema
    // errors or output construction so an accidentally pasted token is never
    // reflected in an error, candidate, prompt, hash input, or artifact note.
    const inspection = prepareTelemetryObservation(body, {
      max_depth: 12,
      max_nodes: 5_000,
      max_object_keys: 100,
      max_array_items: 100,
      max_string_chars: 4_000,
    }).inspection;
    if (inspection.indicators.includes("potential_secret")) {
      throw errors.invalidPayload({
        reason: "automation playbook bindings must not contain secrets or credentials",
        redacted_paths: inspection.redacted_paths,
      });
    }

    const requestSchema = renderRequestSchemaFor(id);
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      throw errors.invalidPayload({
        reason: "body does not satisfy the immutable playbook render schema",
        zod: parsed.error.flatten(),
        zod_issues: parsed.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
        detail_url: `/v1/automation-playbooks/${id}`,
      });
    }

    const readiness = await loadReadinessContext(c.env, projectId);
    try {
      return c.json(await renderAutomationPlaybook(id, parsed.data, readiness));
    } catch (error) {
      throw errors.catalogInconsistent(
        `Automation playbook ${id} could not produce a canonical disabled candidate.`,
        {
          playbook_id: id,
          version: parsed.data.version,
          reason: error instanceof Error ? error.message.slice(0, 2_000) : "unknown catalog error",
        },
      );
    }
  },
);

async function loadReadinessContext(
  env: AppBindings["Bindings"],
  projectId: string,
): Promise<AutomationPlaybookReadinessContext> {
  const db = getDb(env);
  const now = Math.floor(Date.now() / 1_000);
  const [verifiedOnboarding, credentialRows, savedContract, activePosthogConnections] = await Promise.all([
    readCurrentVerifiedOnboardingWithoutMutation(db, projectId),
    db
      .select({
        kind: projectCredentials.kind,
        automationId: projectCredentials.automationId,
      })
      .from(projectCredentials)
      .where(and(
        eq(projectCredentials.projectId, projectId),
        isNull(projectCredentials.revokedAt),
        gt(projectCredentials.expiresAt, now),
      )),
    readAutomationContractWithoutMutation(db, projectId),
    db.select({ id: posthogConnections.id })
      .from(posthogConnections)
      .where(and(
        eq(posthogConnections.projectId, projectId),
        eq(posthogConnections.status, "active"),
      ))
      .limit(1),
  ]);

  const proofReadiness = evaluateOnboardingReadiness(verifiedOnboarding);

  const blueprints = Object.fromEntries(
    Object.values(AUTOMATION_PLAYBOOK_BLUEPRINT_IDS).map((blueprintId) => [
      blueprintId,
      automationBlueprintReady(blueprintId),
    ]),
  );

  return {
    signal_map: {
      saved: verifiedOnboarding !== null,
      approved_plan_hash: verifiedOnboarding?.plan_sha256 ?? null,
      approved_events: verifiedOnboarding?.plan.milestones.map((row) => row.event) ?? [],
    },
    onboarding_proof: {
      available: verifiedOnboarding !== null,
      current_for_signal_map: verifiedOnboarding !== null,
      verified: proofReadiness.verified,
      verified_onboarding_etag: verifiedOnboarding
        ? verifiedOnboarding.etag
        : null,
      observed_events: proofReadiness.observed_events,
      all_approved_events_observed: proofReadiness.all_approved_events_observed,
      safe_error_proved: proofReadiness.safe_error_proved,
      exact_deploy_proved: proofReadiness.exact_deploy_proved,
    },
    active_credentials: {
      ci_deploy: credentialRows.some((row) => row.kind === "ci_deploy"),
      automation_runner_ids: unique(
        credentialRows
          .filter((row) => row.kind === "automation_runner" && row.automationId)
          .map((row) => row.automationId as string),
      ),
    },
    posthog_connection_active: activePosthogConnections.length === 1,
    saved_contract: savedContract,
    blueprints,
  };
}

async function readAutomationContractWithoutMutation(
  db: ReturnType<typeof getDb>,
  projectId: string,
): Promise<AutomationPlaybookReadinessContext["saved_contract"]> {
  const empty: AutomationPlaybookReadinessContext["saved_contract"] = {
    valid: false,
    globally_disabled: false,
    automations: [],
  };
  try {
    const row = (
      await db
        .select()
        .from(automationContracts)
        .where(eq(automationContracts.projectId, projectId))
        .limit(1)
    )[0];
    if (!row) return empty;
    let raw: unknown;
    try {
      raw = JSON.parse(row.documentJson);
    } catch {
      return empty;
    }
    const parsed = AutomationContractSchema.safeParse(raw);
    if (!parsed.success) return empty;
    const contract = parsed.data;
    const expectedEtag = await automationContractEtag(contract);
    const valid = row.schemaVersion === contract.schema_version &&
      row.revision === contract.revision &&
      (row.enabled === 1) === contract.enabled &&
      row.etag === expectedEtag;
    return {
      valid,
      globally_disabled: valid && row.enabled === 0 && contract.enabled === false,
      automations: contract.automations.map((automation) => {
        const candidate = automation as unknown as {
          template_ref?: { id?: unknown; version?: unknown; bindings_sha256?: unknown };
        };
        const ref = candidate.template_ref;
        return {
          id: automation.id,
          enabled: automation.enabled,
          template_ref: ref &&
              typeof ref.id === "string" &&
              typeof ref.version === "string" &&
              typeof ref.bindings_sha256 === "string"
            ? { id: ref.id, version: ref.version, bindings_sha256: ref.bindings_sha256 }
            : null,
        };
      }),
    };
  } catch (error) {
    if (isMissingTable(error, "automation_contracts")) return empty;
    throw error;
  }
}

async function readCurrentVerifiedOnboardingWithoutMutation(
  db: ReturnType<typeof getDb>,
  projectId: string,
) {
  try {
    return await loadVerifiedOnboarding(db, projectId);
  } catch (error) {
    if (isMissingTable(error, "onboarding_states")) return null;
    throw error;
  }
}

function isMissingTable(error: unknown, table: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("no such table") && message.includes(table);
}

function automationBlueprintReady(blueprintId: string): boolean {
  const blueprint = getQueryBlueprint(blueprintId);
  if (!blueprint) return false;
  if (blueprintId !== AUTOMATION_PLAYBOOK_BLUEPRINT_IDS.weekly_funnel) return true;
  const candidate = blueprint as unknown as Record<string, unknown>;
  const required = candidate.required_event_list_param;
  const readiness = candidate.automation_readiness;
  if (required !== "funnel_events_json") {
    return false;
  }
  if (!readiness || typeof readiness !== "object" || Array.isArray(readiness)) return false;
  const policy = readiness as Record<string, unknown>;
  const rowIdentity = policy.row_identity;
  if (!rowIdentity || typeof rowIdentity !== "object" || Array.isArray(rowIdentity)) return false;
  const identity = rowIdentity as Record<string, unknown>;
  return policy.kind === "all_rows_boolean" &&
    policy.column === "sample_ready" &&
    policy.expected_rows === 2 &&
    identity.column === "period" &&
    Array.isArray(identity.values) &&
    identity.values.join("\u0000") === "prior\u0000current";
}

function isAutomationPlaybookId(value: string): value is AutomationPlaybookId {
  return (AUTOMATION_PLAYBOOK_IDS as readonly string[]).includes(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export default router;
