const DEFAULT_MAX_WAIT_MS = 30_000;
const RETRY_DELAY_MS = 1_000;

/**
 * Recover the one project-create command after a transport-level lost response.
 * The caller owns HTTP/auth; this helper owns the stable key, bounded retry,
 * and exact command/project identity validation.
 */
export async function createProjectDurably({
  idempotencyKey,
  attempt,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  sleep = defaultSleep,
  now = Date.now,
}) {
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 500) {
    throw new Error("durable project creation requires one stable 8-500 character Idempotency-Key");
  }
  if (typeof attempt !== "function") {
    throw new Error("durable project creation requires an attempt callback");
  }
  if (!Number.isFinite(maxWaitMs) || maxWaitMs < 0 || maxWaitMs > 120_000) {
    throw new Error("durable project creation maxWaitMs must be between 0 and 120000");
  }

  const startedAt = now();
  const deadline = startedAt + maxWaitMs;
  const attempts = [];
  let attemptNumber = 0;

  while (true) {
    attemptNumber += 1;
    let response;
    try {
      response = await attempt({ idempotencyKey, attempt: attemptNumber });
    } catch (error) {
      attempts.push({
        attempt: attemptNumber,
        status: null,
        outcome: "response_lost",
        network_error: boundedErrorCategory(error),
      });
      if (now() + RETRY_DELAY_MS > deadline) {
        const wrapped = new Error(
          "project creation response was lost and exact-command recovery expired",
        );
        wrapped.cause = error;
        wrapped.project_create_attempts = attempts;
        throw wrapped;
      }
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    const status = Number(response?.status ?? 0);
    const body = response?.json && typeof response.json === "object" && !Array.isArray(response.json)
      ? response.json
      : null;
    const identity = projectCreateIdentity(body);
    attempts.push({
      attempt: attemptNumber,
      status,
      outcome: identity ? "identity_recovered" : "nonterminal_response",
      command_id: identity?.commandId ?? null,
      project_id: identity?.projectId ?? null,
      network_error: null,
    });

    if (status === 200 && identity) {
      return {
        ...response,
        project_create_complete: true,
        project_create_identity: identity,
        project_create_attempts: attempts,
        project_create_elapsed_ms: Math.max(0, now() - startedAt),
      };
    }

    // A successful status without the durable identity can be a truncated
    // response. Replaying the same key is safe; a persistent malformed response
    // remains bounded and never causes a second logical command.
    if (status === 200) {
      if (now() + RETRY_DELAY_MS > deadline) {
        const error = new Error(
          "project creation returned 200 without an exact command/project identity",
        );
        error.project_create_attempts = attempts;
        throw error;
      }
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    return {
      ...response,
      project_create_complete: false,
      project_create_attempts: attempts,
      project_create_elapsed_ms: Math.max(0, now() - startedAt),
    };
  }
}

function projectCreateIdentity(body) {
  if (
    !body ||
    typeof body.command_id !== "string" ||
    !body.command_id.startsWith("mutcmd_") ||
    typeof body.id !== "string" ||
    body.id.length < 1
  ) return null;
  return {
    commandId: body.command_id,
    projectId: body.id,
  };
}

function boundedErrorCategory(error) {
  const name = error instanceof Error && error.name ? error.name : "Error";
  return name.slice(0, 80);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
