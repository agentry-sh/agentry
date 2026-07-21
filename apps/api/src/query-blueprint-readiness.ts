import { and, eq, isNotNull, notLike } from "drizzle-orm";
import { errors } from "@agentrysh/shared";
import { deploys, projectCredentials } from "@agentry/db/schema";
import {
  SYNTHETIC_VERIFY_ANALYTICS_EVENTS,
  trustedCustomerDeployFilter,
} from "./customer-data.js";
import type { getDb } from "./db.js";
import { evaluateOnboardingReadiness, loadVerifiedOnboarding } from "./onboarding-readiness.js";
import type { QueryBlueprint } from "./query-blueprints.js";
import { parseOrderedFunnelEventsJson } from "./query-blueprint-catalog.js";

export interface QueryBlueprintInputReadiness {
  source: "verified_onboarding_plan";
  approved_plan_hash: string;
  verified_onboarding_etag: string;
  selected_event_params: string[];
  selected_events: string[];
  event_order: "ordered_funnel" | "not_applicable";
  onboarding_verified: true;
  selected_events_observed_by_onboarding_proof: true;
  synthetic_rows: "server_excluded";
  trusted_deploy?: "exact_ci_deploy_verified";
}

const SYNTHETIC_EVENT_NAMES = new Set<string>(
  SYNTHETIC_VERIFY_ANALYTICS_EVENTS,
);

function stringParam(
  params: Record<string, string | number>,
  name: string,
): string {
  const value = params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw errors.invalidPayload({
      reason: `required_event_params references non-string param '${name}'`,
    });
  }
  return value;
}

/**
 * Project-specific, fail-closed input gate for automation report blueprints.
 * Query output still carries its own sample/readiness gate because a verified
 * event contract cannot promise traffic inside either exact historical window.
 */
export async function assertQueryBlueprintInputReadiness(
  db: ReturnType<typeof getDb>,
  projectId: string,
  blueprint: QueryBlueprint,
  params: Record<string, string | number>,
  options: { requireTrustedDeploy?: boolean } = {},
): Promise<QueryBlueprintInputReadiness | null> {
  const requiredEventParams = blueprint.required_event_params;
  const requiredEventListParam = blueprint.required_event_list_param;
  if ((!requiredEventParams || requiredEventParams.length === 0) && !requiredEventListParam) {
    return null;
  }
  if (requiredEventParams?.length && requiredEventListParam) {
    throw errors.invalidPayload({
      reason: "blueprint cannot declare both required_event_params and required_event_list_param",
    });
  }
  const selectedEventParams = requiredEventListParam
    ? [requiredEventListParam]
    : [...requiredEventParams!];
  const selectedEvents = requiredEventListParam
    ? parseOrderedFunnelEventsJson(stringParam(params, requiredEventListParam))
    : requiredEventParams!.map((name) => stringParam(params, name));
  const uniqueEvents = new Set(selectedEvents);
  if (uniqueEvents.size !== selectedEvents.length) {
    throw errors.invalidPayload({
      reason:
        "required event params must resolve to distinct events; duplicate event roles are ambiguous",
      required_event_params: selectedEventParams,
      selected_events: selectedEvents,
    });
  }

  const syntheticEvents = selectedEvents.filter((event) =>
    SYNTHETIC_EVENT_NAMES.has(event)
  );
  if (syntheticEvents.length > 0) {
    throw errors.preconditionFailed(
      "Synthetic events cannot be used as funnel steps.",
      "Choose distinct customer product events from the verified onboarding plan. Rehearsal and test event names never satisfy onboarding or report evidence.",
      { synthetic_events: syntheticEvents },
    );
  }

  const verified = await loadVerifiedOnboarding(db, projectId);
  if (!verified) {
    throw errors.preconditionRequired(
      "This blueprint requires a verified onboarding plan.",
      "Complete onboarding through real analytics, safe-error, and deploy proof, then use its exact approved event names in funnel order.",
      { project_id: projectId, required_state: "onboarding_verified" },
    );
  }

  const approvedEvents = new Set(verified.plan.milestones.map((milestone) => milestone.event));
  const unapprovedEvents = selectedEvents.filter((event) => !approvedEvents.has(event));
  if (unapprovedEvents.length > 0) {
    throw errors.preconditionFailed(
      "One or more required events are not in the verified onboarding plan.",
      "Read the current onboarding plan and retry with its exact milestone events. Replace, approve, and re-verify the plan first if the product contract changed.",
      {
        unapproved_events: unapprovedEvents,
        selected_events: selectedEvents,
      },
    );
  }

  const readiness = evaluateOnboardingReadiness(verified);

  const proofTargets = new Map(
    verified.receipt.analytics.map((target) => [target.event, target]),
  );
  const unavailableSelectedEvents = selectedEvents.filter((event) => {
    const target = proofTargets.get(event);
    return !target || target.row_count < 1 ||
      target.required_properties.some((property) =>
        !target.observed_properties.includes(property)
      );
  });
  if (unavailableSelectedEvents.length > 0) {
    throw errors.preconditionFailed(
      "Selected funnel telemetry is absent from the current scoped onboarding proof.",
      "Restart onboarding proof and observe every selected event and required property in real product traffic. Synthetic or caller-authored evidence never counts.",
      {
        unavailable_events: unavailableSelectedEvents,
        verified_onboarding_etag: verified.etag,
      },
    );
  }

  if (
    !readiness.verified ||
    !readiness.safe_error_proved ||
    !readiness.exact_deploy_proved
  ) {
    throw errors.preconditionFailed(
      "The current onboarding receipt lacks exact real error or deploy proof.",
      "Run one fresh scoped onboarding proof through the real product funnel, its approved safe error, and the exact CI deploy bound to the post-edit source fingerprint.",
      {
        verified_onboarding_etag: verified.etag,
        safe_error_proved: readiness.safe_error_proved,
        exact_deploy_proved: readiness.exact_deploy_proved,
      },
    );
  }

  let trustedDeploy: "exact_ci_deploy_verified" | undefined;
  if (
    blueprint.automation_verification?.kind === "deploy_traffic_sample" &&
    options.requireTrustedDeploy !== false
  ) {
    const deploySha = stringParam(params, "deploy_sha");
    const deployedAtValue = stringParam(params, "deployed_at");
    const deployedAt = Date.parse(deployedAtValue) / 1_000;
    const matchingDeploys = await db
      .select({ id: deploys.id })
      .from(deploys)
      .innerJoin(projectCredentials, and(
        eq(projectCredentials.id, deploys.credentialId),
        eq(projectCredentials.projectId, deploys.projectId),
        eq(projectCredentials.kind, "ci_deploy"),
        notLike(projectCredentials.tokenHash, "legacy-disabled:%"),
      ))
      .where(and(
        eq(deploys.projectId, projectId),
        eq(deploys.sha, deploySha),
        eq(deploys.receivedAt, deployedAt),
        eq(deploys.trustLevel, "trusted_ci"),
        eq(deploys.credentialKind, "ci_deploy"),
        isNotNull(deploys.credentialId),
        trustedCustomerDeployFilter,
      ))
      .limit(2);
    if (matchingDeploys.length !== 1) {
      throw errors.preconditionFailed(
        matchingDeploys.length === 0
          ? "No exact trusted CI deploy matches the traffic-sample window."
          : "More than one trusted CI deploy matches the traffic-sample SHA and timestamp.",
        "Use the exact deploy_sha and deployed_at from one trusted CI deploy record. Stop and reconcile duplicate deploy evidence rather than choosing one arbitrarily.",
        {
          deploy_sha: deploySha,
          deployed_at: deployedAtValue,
          matches: matchingDeploys.length,
        },
      );
    }
    trustedDeploy = "exact_ci_deploy_verified";
  }

  return {
    source: "verified_onboarding_plan",
    approved_plan_hash: verified.plan_sha256,
    verified_onboarding_etag: verified.etag,
    selected_event_params: selectedEventParams,
    selected_events: selectedEvents,
    event_order: requiredEventListParam ? "ordered_funnel" : "not_applicable",
    onboarding_verified: true,
    selected_events_observed_by_onboarding_proof: true,
    synthetic_rows: "server_excluded",
    ...(trustedDeploy ? { trusted_deploy: trustedDeploy } : {}),
  };
}
