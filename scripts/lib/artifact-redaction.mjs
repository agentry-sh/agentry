const MAX_ERROR_MESSAGE_CHARS = 2_000;
const MAX_REDACTION_DEPTH = 24;
const MIN_EXACT_REDACTION_CHARS = 8;
const exactArtifactValues = new Set();
let sortedExactArtifactValues = [];

function collectExactArtifactValues(value, seen = new WeakSet()) {
  if (typeof value === "string") {
    if (value.length >= MIN_EXACT_REDACTION_CHARS && value !== "<redacted-exact>") {
      exactArtifactValues.add(value);
    }
    return;
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) collectExactArtifactValues(entry, seen);
  } else {
    for (const entry of Object.values(value)) collectExactArtifactValues(entry, seen);
  }
}

/** Register opaque runtime values before any transcript or command log can persist them. */
export function registerArtifactRedactionValues(value) {
  const previousSize = exactArtifactValues.size;
  collectExactArtifactValues(value);
  if (exactArtifactValues.size !== previousSize) {
    sortedExactArtifactValues = [...exactArtifactValues].sort((left, right) => right.length - left.length);
  }
}

export function resetArtifactRedactionValuesForTests() {
  exactArtifactValues.clear();
  sortedExactArtifactValues = [];
}

export function artifactKeyIsSensitive(key) {
  const normalized = String(key).replace(/[-_]/g, "").toLowerCase();
  return [
    "apikey",
    "authorization",
    "credential",
    "credentials",
    "dsn",
    "token",
    "accesstoken",
    "refreshtoken",
    "secret",
    "clientsecret",
    "admintoken",
    "internaltoken",
  ].includes(normalized) ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("key") ||
    normalized.endsWith("credential") ||
    normalized.endsWith("credentials");
}

export function redactArtifactText(value) {
  if (typeof value !== "string") return value;
  let redacted = value;
  for (const exact of sortedExactArtifactValues) {
    redacted = redacted.split(exact).join("<redacted-exact>");
  }
  return redacted
    .replace(/agentry_sk_[A-Za-z0-9._-]+/g, "agentry_sk_<redacted>")
    .replace(/agentry_pk_[A-Za-z0-9._-]+/g, "agentry_pk_<redacted>")
    .replace(/agentry_server_[A-Za-z0-9._-]+/g, "agentry_server_<redacted>")
    .replace(/agentry_ci_[A-Za-z0-9._-]+/g, "agentry_ci_<redacted>")
    .replace(/agentry_runner_[A-Za-z0-9._-]+/g, "agentry_runner_<redacted>")
    .replace(/agp_[A-Za-z0-9._-]+/g, "agp_<redacted>")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer <redacted>")
    .replace(
      /((?:["']?)[A-Za-z0-9_-]*(?:authorization|credential|credentials|token|secret|api[_-]?key|dsn)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}\]]+)/gi,
      '$1"<redacted>"',
    );
}

export function redactArtifactValue(value, state = undefined) {
  const context = state ?? { depth: 0, seen: new WeakSet() };
  if (typeof value === "string") return redactArtifactText(value);
  if (value === null || typeof value !== "object") return value;
  if (context.depth >= MAX_REDACTION_DEPTH) return "<redacted-depth-limit>";
  if (context.seen.has(value)) return "<redacted-circular-reference>";
  context.seen.add(value);
  const childState = { depth: context.depth + 1, seen: context.seen };
  if (Array.isArray(value)) {
    const result = value.map((entry) => redactArtifactValue(entry, childState));
    context.seen.delete(value);
    return result;
  }
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = artifactKeyIsSensitive(key)
      ? "<redacted>"
      : redactArtifactValue(entry, childState);
  }
  context.seen.delete(value);
  return result;
}

export function artifactError(error) {
  const record = error && typeof error === "object" ? error : null;
  const rawMessage = error instanceof Error ? error.message : String(error);
  const rawDetail = record && "detail" in record ? record.detail : undefined;
  const rawCode = record && typeof record.code === "string" ? record.code : undefined;
  return redactArtifactValue({
    name: error instanceof Error && error.name ? error.name.slice(0, 120) : "Error",
    message: rawMessage.slice(0, MAX_ERROR_MESSAGE_CHARS),
    ...(rawCode ? { code: rawCode.slice(0, 120) } : {}),
    ...(rawDetail === undefined ? {} : { detail: rawDetail }),
  });
}
