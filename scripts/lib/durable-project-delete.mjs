const DEFAULT_MAX_WAIT_MS = 120_000;
const DEFAULT_RETRY_SECONDS = 1;
const MAX_SLEEP_CHUNK_MS = 30_000;

/**
 * Resume Agentry's durable project-deletion command with one exact
 * Idempotency-Key until it reaches a terminal response or the caller's cleanup
 * budget expires. The caller owns HTTP/auth so every harness can retain its
 * normal transcript and redaction behavior.
 */
export async function deleteProjectDurably({
  ...options
}) {
  return resumeDurableDeletion({
    ...options,
    operationLabel: "project deletion",
    terminalSuccess: ({ status, body, acceptNotFound }) =>
      (status === 200 && body?.deleted === true) ||
      status === 204 ||
      (acceptNotFound && status === 404),
  });
}

/** Shared retry engine for bounded 202-style destructive commands. */
export async function resumeDurableDeletion({
  idempotencyKey,
  attempt,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  acceptNotFound = false,
  sleep = defaultSleep,
  now = Date.now,
  operationLabel = "deletion",
  terminalSuccess,
}) {
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 500) {
    throw new Error(`durable ${operationLabel} requires one stable 8-500 character Idempotency-Key`);
  }
  if (typeof attempt !== "function") {
    throw new Error(`durable ${operationLabel} requires an attempt callback`);
  }
  if (typeof terminalSuccess !== "function") throw new Error("durable deletion requires a terminalSuccess predicate");
  if (!Number.isFinite(maxWaitMs) || maxWaitMs < 0) {
    throw new Error(`durable ${operationLabel} maxWaitMs must be a nonnegative finite number`);
  }

  const startedAt = now();
  const deadline = startedAt + maxWaitMs;
  const attempts = [];
  let expectedCommandId = null;
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
        command_id: expectedCommandId,
        retry_after_seconds: DEFAULT_RETRY_SECONDS,
        network_error: error instanceof Error ? error.message : String(error),
      });
      if (now() + DEFAULT_RETRY_SECONDS * 1_000 > deadline) {
        const wrapped = new Error(`${operationLabel} response was lost and the durable retry budget expired`);
        wrapped.cause = error;
        wrapped.deletion_attempts = attempts;
        throw wrapped;
      }
      await sleepBounded(DEFAULT_RETRY_SECONDS * 1_000, sleep);
      continue;
    }

    const status = Number(response?.status ?? 0);
    const body = response?.json && typeof response.json === "object" && !Array.isArray(response.json)
      ? response.json
      : null;
    const commandId = typeof body?.command_id === "string" ? body.command_id : null;
    if (commandId) {
      if (expectedCommandId && commandId !== expectedCommandId) {
        const error = new Error(`durable ${operationLabel} changed command_id across exact retries`);
        error.deletion_attempts = attempts;
        error.expected_command_id = expectedCommandId;
        error.actual_command_id = commandId;
        throw error;
      }
      expectedCommandId = commandId;
    }

    const retryAfterSeconds = retryAfterSecondsFor(response);
    attempts.push({
      attempt: attemptNumber,
      status,
      command_id: commandId ?? expectedCommandId,
      retry_after_seconds: status === 202 ? retryAfterSeconds : null,
      network_error: null,
    });

    if (terminalSuccess({ status, body, response, acceptNotFound })) {
      return {
        ...response,
        deletion_complete: true,
        already_missing: status === 404,
        deletion_attempts: attempts,
        deletion_elapsed_ms: Math.max(0, now() - startedAt),
      };
    }
    if (status !== 202) {
      return {
        ...response,
        deletion_complete: false,
        already_missing: false,
        deletion_attempts: attempts,
        deletion_elapsed_ms: Math.max(0, now() - startedAt),
      };
    }

    const delayMs = retryAfterSeconds * 1_000;
    if (now() + delayMs > deadline) {
      return {
        ...response,
        deletion_complete: false,
        deletion_retry_budget_exhausted: true,
        already_missing: false,
        deletion_attempts: attempts,
        deletion_elapsed_ms: Math.max(0, now() - startedAt),
      };
    }
    await sleepBounded(delayMs, sleep);
  }
}

export function retryAfterSecondsFor(response) {
  const bodyValue = Number(response?.json?.retry_after_seconds);
  if (Number.isFinite(bodyValue) && bodyValue > 0) return Math.max(1, Math.ceil(bodyValue));

  const rawHeader = headerValue(response?.headers, "retry-after");
  const numericHeader = Number(rawHeader);
  if (Number.isFinite(numericHeader) && numericHeader > 0) {
    return Math.max(1, Math.ceil(numericHeader));
  }
  if (typeof rawHeader === "string" && rawHeader) {
    const at = Date.parse(rawHeader);
    if (Number.isFinite(at)) return Math.max(1, Math.ceil((at - Date.now()) / 1_000));
  }
  return DEFAULT_RETRY_SECONDS;
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return match ? String(match[1]) : null;
}

async function sleepBounded(totalMs, sleep) {
  let remaining = totalMs;
  while (remaining > 0) {
    const chunk = Math.min(remaining, MAX_SLEEP_CHUNK_MS);
    await sleep(chunk);
    remaining -= chunk;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
