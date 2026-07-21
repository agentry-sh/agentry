import { z } from "zod";
import { sha256Hex } from "./crypto.js";
import { base64url } from "./ids.js";

export const ProjectCredentialKindSchema = z.enum([
  "ci_deploy",
  "automation_runner",
]);

export const ProjectCredentialScopeSchema = z.enum([
  "deploys:write",
  "automation_proofs:write",
  "cases:read",
  "triggers:read",
  "triggers:issue",
  "claims:write",
  "runs:read",
  "runs:write",
  "approvals:request",
]);

export const CreateProjectCredentialRequestSchema = z.object({
  kind: ProjectCredentialKindSchema,
  name: z.string().min(1).max(200),
  automation_id: z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/).optional(),
  expires_in_seconds: z.number().int().min(300).max(31_536_000).optional(),
}).strict().superRefine((request, ctx) => {
  if (request.kind === "automation_runner" && !request.automation_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["automation_id"],
      message: "automation_runner credentials must be bound to one automation_id",
    });
  }
  if (request.kind !== "automation_runner" && request.automation_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["automation_id"],
      message: "automation_id is valid only for automation_runner credentials",
    });
  }
});

const PROJECT_CREDENTIAL_PREFIXES = {
  ci_deploy: "agentry_ci_",
  automation_runner: "agentry_runner_",
} as const;

export interface MintedProjectCredential {
  raw: string;
  hash: string;
  prefix: string;
  token: string;
}

export async function mintProjectCredential(
  projectId: string,
  kind: ProjectCredentialKind,
): Promise<MintedProjectCredential> {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  const token = base64url(bytes);
  const keyPrefix = PROJECT_CREDENTIAL_PREFIXES[kind];
  const raw = `${keyPrefix}${projectId}.${token}`;
  return {
    raw,
    hash: await sha256Hex(raw),
    prefix: raw.slice(0, keyPrefix.length + 11),
    token,
  };
}

export function parseProjectCredential(
  raw: string,
): { projectId: string; token: string; kind: ProjectCredentialKind } | null {
  for (const [kind, prefix] of Object.entries(PROJECT_CREDENTIAL_PREFIXES) as Array<
    [ProjectCredentialKind, string]
  >) {
    if (!raw.startsWith(prefix)) continue;
    const rest = raw.slice(prefix.length);
    const separator = rest.indexOf(".");
    if (separator <= 0 || separator === rest.length - 1) return null;
    return {
      kind,
      projectId: rest.slice(0, separator),
      token: rest.slice(separator + 1),
    };
  }
  return null;
}

export function scopesForProjectCredential(kind: ProjectCredentialKind): ProjectCredentialScope[] {
  if (kind === "ci_deploy") return ["deploys:write", "automation_proofs:write"];
  return [
    "cases:read",
    "triggers:read",
    "triggers:issue",
    "claims:write",
    "runs:read",
    "runs:write",
    "approvals:request",
  ];
}

export type ProjectCredentialKind = z.infer<typeof ProjectCredentialKindSchema>;
export type ProjectCredentialScope = z.infer<typeof ProjectCredentialScopeSchema>;
export type CreateProjectCredentialRequest = z.infer<typeof CreateProjectCredentialRequestSchema>;
