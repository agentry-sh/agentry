// Agent-friendly error responses.
// Every error includes a `code` (machine-readable) and `next_action` (what the agent should try).

export interface AgentryErrorBody {
  error: {
    code: string;
    message: string;
    next_action?: string;
    details?: Record<string, unknown>;
    request_id?: string;
    retryable?: boolean;
  };
}

export class AgentryError extends Error {
  status: number;
  code: string;
  nextAction?: string;
  details?: Record<string, unknown>;

  constructor(opts: {
    status: number;
    code: string;
    message: string;
    nextAction?: string;
    details?: Record<string, unknown>;
  }) {
    super(opts.message);
    this.status = opts.status;
    this.code = opts.code;
    this.nextAction = opts.nextAction;
    this.details = opts.details;
  }

  toResponseBody(): AgentryErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.nextAction ? { next_action: this.nextAction } : {}),
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const errors = {
  payloadTooLarge(limit: number, contentLength?: number) {
    return new AgentryError({
      status: 413,
      code: "payload_too_large",
      message: `Request body exceeds the ${limit}-byte limit.`,
      nextAction: "Remove large bodies, blobs, and excessive telemetry fields, then retry with bounded structured data.",
      details: {
        limit,
        ...(contentLength === undefined ? {} : { content_length: contentLength }),
      },
    });
  },
  invalidPayload(details?: Record<string, unknown>) {
    return new AgentryError({
      status: 400,
      code: "invalid_payload",
      message: "Request body did not match the expected schema.",
      nextAction: "Inspect details.zod and fix the offending fields, then retry.",
      details,
    });
  },
  unauthorized(reason: string = "Missing or invalid Authorization header.") {
    return new AgentryError({
      status: 401,
      code: "unauthorized",
      message: reason,
      nextAction:
        "If you have an api_key, send `Authorization: Bearer <api_key>`. " +
        "Read it from AGENTRY_PRIVATE_API_KEY or ~/.agentry/credentials.json. If you do not have one, run " +
        "`agentry login` in an interactive terminal and complete the one-click PostHog authorization.",
    });
  },
  invalidApiKey() {
    return new AgentryError({
      status: 401,
      code: "invalid_api_key",
      message: "API key not recognized or revoked.",
      nextAction:
        "Owner/API endpoints require `Authorization: Bearer <AGENTRY_PRIVATE_API_KEY>` using the full agentry_sk_ key. " +
        "Re-read ~/.agentry/credentials.json and make sure you are sending the full key. " +
        "If the key is lost or revoked, run `agentry login` in an interactive terminal and complete the " +
        "one-click PostHog authorization to mint a fresh key.",
    });
  },
  invalidProjectCredential() {
    return new AgentryError({
      status: 401,
      code: "invalid_project_credential",
      message: "Project-scoped credential is invalid, expired, or revoked.",
      nextAction:
        "Use AGENTRY_CI_API_KEY for trusted deploy evidence or the AGENTRY_RUNNER_API_KEY bound to this exact automation. Ask a project owner to mint a replacement if it expired or was revoked.",
    });
  },
  credentialScopeDenied(
    requiredScope: string,
    kind: string,
    details?: Record<string, unknown>,
  ) {
    return new AgentryError({
      status: 403,
      code: "credential_scope_denied",
      message: `${kind} credentials cannot perform ${requiredScope}.`,
      nextAction:
        "Do not move this credential into a broader context. Use the separately scoped credential named in the endpoint documentation or ask a project owner to create one.",
      details: { required_scope: requiredScope, credential_kind: kind, ...details },
    });
  },
  notFound(resource: string) {
    return new AgentryError({
      status: 404,
      code: "not_found",
      message: `${resource} not found.`,
      nextAction: `Verify the id. List available ${resource}s if unsure.`,
    });
  },
  forbidden(reason: string = "You do not have access to this resource.") {
    return new AgentryError({
      status: 403,
      code: "forbidden",
      message: reason,
      nextAction:
        "Confirm the resource id belongs to a project owned by the authenticated user.",
    });
  },
  conflict(code: string, message: string, nextAction: string, details?: Record<string, unknown>) {
    return new AgentryError({
      status: 409,
      code,
      message,
      nextAction,
      details,
    });
  },
  preconditionRequired(message: string, nextAction: string, details?: Record<string, unknown>) {
    return new AgentryError({
      status: 428,
      code: "precondition_required",
      message,
      nextAction,
      details,
    });
  },
  preconditionFailed(message: string, nextAction: string, details?: Record<string, unknown>) {
    return new AgentryError({
      status: 412,
      code: "precondition_failed",
      message,
      nextAction,
      details,
    });
  },
  rateLimited() {
    return new AgentryError({
      status: 429,
      code: "rate_limited",
      message: "Too many requests.",
      nextAction: "Back off and retry with exponential delay (start at 1s).",
    });
  },
  configurationMissing(code: string, message: string, nextAction: string, details?: Record<string, unknown>) {
    return new AgentryError({
      status: 503,
      code,
      message,
      nextAction,
      details,
    });
  },
  posthogConnectionRequired(details?: Record<string, unknown>) {
    return new AgentryError({
      status: 409,
      code: "posthog_connection_required",
      message: "This operation requires an active customer PostHog Cloud connection.",
      nextAction:
        "Have a project owner start or resume POST /v1/projects/:project_id/posthog-connection, complete read-only OAuth and exact project selection, then retry. Do not create an Agentry ingest key or copy a PostHog personal API key.",
      details,
    });
  },
  posthogUpstreamFailed(opts: {
    operation: string;
    status: number;
    body?: string;
    nextAction?: string;
  }) {
    const bodyExcerpt = opts.body?.slice(0, 400);
    return new AgentryError({
      status: opts.status >= 500 ? 502 : 424,
      code: "posthog_upstream_failed",
      message: `PostHog ${opts.operation} failed with status ${opts.status}.`,
      nextAction:
        opts.nextAction ??
        "Use details.operation, details.upstream_status, and details.body_excerpt to choose the repair path: fix invalid HogQL or params for 4xx query errors, reconnect PostHog OAuth for auth/not-found errors, and retry with backoff for 5xx/timeouts.",
      details: {
        operation: opts.operation,
        upstream_status: opts.status,
        ...(bodyExcerpt ? { body_excerpt: bodyExcerpt } : {}),
      },
    });
  },
  publicationProjectDeleted(publicationId?: string) {
    return new AgentryError({
      status: 410,
      code: "publication_project_deleted",
      message: "The project behind this public query publication was deleted.",
      nextAction:
        "Stop using this public query URL. Create or choose an active project, publish the query blueprint again with POST /v1/projects/:project_id/public-queries, and update the embedding page to the new public_url.",
      details: publicationId ? { publication_id: publicationId } : undefined,
    });
  },
  unsupportedOperation(message: string, nextAction: string, details?: Record<string, unknown>) {
    return new AgentryError({
      status: 422,
      code: "unsupported_operation",
      message,
      nextAction,
      details,
    });
  },
  catalogInconsistent(message: string, details?: Record<string, unknown>) {
    return new AgentryError({
      status: 500,
      code: "catalog_inconsistent",
      message,
      nextAction:
        "The request is valid, but Agentry's query-blueprint or answer-contract data is internally inconsistent. Choose another blueprint if possible, and file feedback with the blueprint/contract id and request_id so the catalog can be repaired.",
      details,
    });
  },
  persistenceFailed(message: string, nextAction: string, details?: Record<string, unknown>) {
    return new AgentryError({
      status: 500,
      code: "persistence_failed",
      message,
      nextAction,
      details,
    });
  },
  internal(message = "Internal server error.") {
    return new AgentryError({
      status: 500,
      code: "internal",
      message,
      nextAction: "Retry once. If it persists, the server has a bug — open an issue.",
    });
  },
};
