import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { cases, deploys } from "@agentry/db/schema";
import { getDb } from "../db.js";
import { INSTALL_COMPLETE_USER_HANDOFF } from "../install-handoff.js";
import { requireApiKey, requireProjectAccess } from "../middleware.js";
import {
  DEFAULT_NEXT_STEP_SIGNAL_TYPES,
  normalizeNextStepSignalTypes,
  selectApplicableNextSteps,
} from "../next-steps.js";
import { evaluateOnboardingReadiness, loadVerifiedOnboarding } from "../onboarding-readiness.js";
import { isPosthogConfigured } from "../posthog.js";
import type { AppBindings } from "../env.js";
import { customerCaseFilter, trustedCustomerDeployFilter } from "../customer-data.js";

const router = new Hono<AppBindings>();

router.get(
  "/v1/projects/:project_id/next-steps",
  requireApiKey(),
  async (c) => {
    const projectId = c.req.param("project_id");
    await requireProjectAccess(c, projectId);

    // The current verified onboarding plan is the signal map. No duplicate
    // implementation or signal-map artifact is required for readiness.
    const db = getDb(c.env);
    const [stateRows, verifiedOnboarding] = await Promise.all([
      db.all<{
        case_count: number | string | null;
        deploy_count: number | string | null;
      }>(sql`
        SELECT
          (SELECT count(*) FROM ${cases} WHERE ${cases.projectId} = ${projectId} AND ${customerCaseFilter}) AS case_count,
          (SELECT count(*) FROM ${deploys} WHERE ${deploys.projectId} = ${projectId} AND ${trustedCustomerDeployFilter}) AS deploy_count
      `),
      loadVerifiedOnboarding(db, projectId),
    ]);
    const stateRow = stateRows[0];
    const proofReadiness = evaluateOnboardingReadiness(verifiedOnboarding);
    const verifiedEvents = verifiedOnboarding?.plan.milestones.map((target) => target.event) ?? [];
    const installVerified = proofReadiness.verified;
    const readinessGaps: string[] = [];
    const readinessComplete = installVerified;
    const answerReady = installVerified && verifiedEvents.length > 0;
    const pendingRealDataCount = 0;
    const signalTypes = installVerified
      ? normalizeNextStepSignalTypes([...DEFAULT_NEXT_STEP_SIGNAL_TYPES])
      : [];

    const state = {
      signal_types: signalTypes,
      analytics_scope: signalTypes.includes("analytics"),
      errors_scope: signalTypes.includes("errors"),
      deploys_scope: signalTypes.includes("deploys"),
      analytics_configured: isPosthogConfigured(c.env),
      has_events:
        installVerified &&
        signalTypes.includes("analytics") &&
        (verifiedOnboarding?.receipt.analytics.reduce((sum, row) => sum + row.row_count, 0) ?? 0) > 0,
      has_cases: Number(stateRow?.case_count ?? 0) > 0,
      has_deploys: Number(stateRow?.deploy_count ?? 0) > 0,
      install_verified: installVerified,
      minimum_install_complete: installVerified,
      readiness_complete: readinessComplete,
      answer_ready: answerReady,
      readiness_gaps_count: readinessGaps.length,
      pending_real_data_count: pendingRealDataCount,
    };

    const applicable = selectApplicableNextSteps(state);
    const scopePhrase = signalTypes.length > 0 ? signalTypes.join(", ") : "not approved yet";
    const nextAction = state.install_verified
      ? `Start with this user-facing handoff: ${INSTALL_COMPLETE_USER_HANDOFF} ` +
        `The approved signal scope is ${scopePhrase}. Then surface these to the user as numbered follow-up options. Include ` +
        "`go_live_deployment_checklist` first when present: " +
        "name the detected host, required env vars, and whether you can set them or need user action; copy/redeploy/trigger real data only when immediately available or explicitly requested. " +
        (state.analytics_scope && state.answer_ready
          ? "After that, ask which product question, report, interface, or automation to handle first. Answer from the saved signal map and live reads before building UI. If the user explicitly wants a browser-facing/shareable analytics view, prefer query-blueprint-backed public-query publications over custom app UI, and do not add `AGENTRY_PRIVATE_API_KEY` to client code or app runtime just to show metrics. Include the open-ended custom interface and custom question options as optional follow-up; do not stop with a generic installed message. "
          : state.analytics_scope
          ? "After that, do not claim product questions, reports, or dashboards are answer-ready yet. Name the exact missing event/property and product flow, then complete a fresh scoped onboarding proof before building confident analytics output. Custom questions should return Ready, Needs more data, or Needs instrumentation before querying. "
          : "After that, ask which cases, deploys, verified onboarding receipt, or operational automation view to build first. Do not suggest analytics dashboards, public-query publications, or custom analytics query work unless the user widens the signal scope to analytics. ") +
        "Each suggestion has a `prompt_template` the agent should adapt using the saved signal map, current verified onboarding receipt, live signal data, and listed endpoints."
      : "Do not surface post-setup reports, interfaces, automations, or custom build prompts yet. Follow the current onboarding state's one next_action until the exact real proof session reaches status=verified for the active signal map; legacy verify reports and synthetic traffic do not count.";

    return c.json({
      project_state: state,
      count: applicable.length,
      suggestions: applicable,
      next_action: nextAction,
    });
  },
);

export default router;
