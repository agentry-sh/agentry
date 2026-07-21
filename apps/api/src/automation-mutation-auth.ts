import type { Context } from "hono";
import type { ProjectCredentialScope } from "@agentrysh/shared";
import type { AppBindings } from "./env.js";
import { requireProjectOwner } from "./middleware.js";
import {
  requireCredentialScope,
  type ProjectCredentialPrincipal,
} from "./project-credential-auth.js";

/**
 * Authorize a mutation performed either by the exact automation runner or by a
 * human project owner. Private API keys have no project-credential principal,
 * so they must pass the explicit owner-role check instead of inheriting member
 * read access as mutation authority.
 */
export async function requireAutomationMutationAuthority(
  c: Context<AppBindings>,
  scope: ProjectCredentialScope,
  projectId: string,
  automationId: string,
): Promise<ProjectCredentialPrincipal | null> {
  const credential = requireCredentialScope(c, scope, projectId, automationId);
  if (!credential) await requireProjectOwner(c, projectId);
  return credential;
}
