import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { errors, sha256Hex } from "@agentrysh/shared";
import { onboardingProofSessions } from "@agentry/db/schema";
import { getDb } from "./db.js";
import type { AppBindings } from "./env.js";
import {
  loadOnboardingProofSession,
  ONBOARDING_CI_PROOF_HEADER,
} from "./onboarding-proof-sessions.js";
import type { SignalCredentialPrincipal } from "./project-credential-auth.js";

export interface OnboardingProofStamp {
  proofSessionId: string;
  proofCredentialId: string;
}

function invalidMarker(reason: string): never {
  throw errors.conflict(
    "onboarding_proof_marker_invalid",
    "The supplied onboarding CI proof marker is invalid, expired, terminal, or does not match the authenticated CI credential boundary.",
    "Use the current proof session's CI marker only on the trusted deploy request. It never replaces Authorization.",
    { reason },
  );
}

/**
 * Resolve a non-authorizing CI marker only after durable deploy authentication.
 * The returned identity is server-derived; caller-authored provenance is never
 * trusted. A bearer request's physical origin is intentionally not inferred.
 */
export async function resolveOnboardingProofMarker(
  c: Context<AppBindings>,
  principal: SignalCredentialPrincipal,
): Promise<OnboardingProofStamp | null> {
  const raw = c.req.header(ONBOARDING_CI_PROOF_HEADER)?.trim();
  if (!raw) return null;
  if (principal.kind !== "ci_deploy") {
    invalidMarker("ci_credential_required");
  }
  if (raw.length < 32 || raw.length > 1_000 || !/^agentry_proof_ci_[A-Za-z0-9_-]+$/.test(raw)) {
    invalidMarker("malformed");
  }
  const markerHash = await sha256Hex(raw);
  const db = getDb(c.env);
  const row = (
    await db.select().from(onboardingProofSessions).where(and(
      eq(onboardingProofSessions.projectId, principal.projectId),
      eq(onboardingProofSessions.ciMarkerHash, markerHash),
    )).limit(1)
  )[0];
  if (!row) invalidMarker("not_found_for_project_and_purpose");
  const session = await loadOnboardingProofSession(db, principal.projectId, row.id);
  if (!session || session.status !== "active") invalidMarker("session_not_active");

  if (principal.credentialId !== session.ci_deploy.credential_id) {
    invalidMarker("ci_binding_mismatch");
  }
  return {
    proofSessionId: session.session_id,
    proofCredentialId: session.ci_deploy.credential_id,
  };
}
