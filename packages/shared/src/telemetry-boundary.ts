/**
 * Telemetry is observation, never instruction.
 *
 * Authentication can prove which credential emitted an event. It cannot prove
 * that strings copied from requests, users, third parties, or exception text
 * are safe to follow. Agent-facing surfaces use this module to keep that
 * distinction explicit and to make hostile values bounded and inert enough for
 * display. The original event may still be retained by the service as evidence.
 *
 * Indicators are deliberately heuristic. They help a caller decide how much
 * review is warranted; absence of an indicator is never a safety verdict.
 */

export const TELEMETRY_BOUNDARY_SCHEMA_VERSION = "1" as const;

export const TELEMETRY_DATA_BOUNDARY = {
  schema_version: TELEMETRY_BOUNDARY_SCHEMA_VERSION,
  classification: "untrusted_observation",
  content_role: "evidence_only",
  instruction_authority: "none",
  trusted_provenance_does_not_mean_trusted_content: true,
  external_url_policy: "do_not_fetch",
  command_policy: "do_not_execute",
  authority_source: "enabled_automation_contract_and_server_policy_only",
} as const;

export type TelemetryIndicator =
  | "instruction_like_text"
  | "shell_like_text"
  | "external_url"
  | "potential_secret"
  | "control_characters"
  | "content_truncated";

export interface TelemetryInspection {
  heuristic_only: true;
  indicators: TelemetryIndicator[];
  external_url_hosts: string[];
  redacted_paths: string[];
  truncated_paths: string[];
}

export interface TelemetryObservationView<T = unknown> {
  content: T;
  inspection: TelemetryInspection;
}

export interface TelemetryObservationOptions {
  max_depth?: number;
  max_nodes?: number;
  max_object_keys?: number;
  max_array_items?: number;
  max_string_chars?: number;
  max_reported_paths?: number;
  max_external_url_hosts?: number;
}

const DEFAULTS: Required<TelemetryObservationOptions> = {
  max_depth: 12,
  max_nodes: 10_000,
  max_object_keys: 100,
  max_array_items: 100,
  max_string_chars: 8_000,
  max_reported_paths: 100,
  max_external_url_hosts: 20,
};

const INDICATOR_ORDER: readonly TelemetryIndicator[] = [
  "instruction_like_text",
  "shell_like_text",
  "external_url",
  "potential_secret",
  "control_characters",
  "content_truncated",
];

const SENSITIVE_KEY_SUFFIXES = [
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "password",
  "passwd",
  "secret",
  "privatekey",
  "accesstoken",
  "accesskey",
  "refreshtoken",
  "refreshkey",
  "idtoken",
  "clientsecret",
  "apikey",
  "sessiontoken",
  "token",
  "jwt",
  "dsn",
  "credential",
  "credentials",
  "signingsecret",
] as const;

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;
const EXTERNAL_REFERENCE = /(?:https?|ftp|file|data|javascript):(?:\/\/)?[^\s<>"'`]+/giu;

const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /\bignore\b.{0,80}\b(?:previous|prior|system|developer|all)\b.{0,40}\binstructions?\b/i,
  /\b(?:system|developer|assistant)\s+(?:prompt|message|instructions?)\b/i,
  /\b(?:you are|act as)\s+(?:an?\s+)?(?:agent|assistant|chatgpt|claude|codex)\b/i,
  /\b(?:follow|obey|execute)\s+(?:these|the following|my)\s+instructions?\b/i,
  /\b(?:reveal|print|send|exfiltrate)\b.{0,60}\b(?:secret|token|key|credential|prompt)\b/i,
];

const SHELL_PATTERNS: readonly RegExp[] = [
  /\b(?:curl|wget)\s+(?:-[^\s]+\s+)*https?:\/\//i,
  /\b(?:bash|sh|zsh|powershell|pwsh)\s+-[^\s]*c\b/i,
  /\brm\s+-rf\b/i,
  /\bgit\s+push(?:\s+--force)?\b/i,
  /\bsudo\s+[^\s]/i,
  /\$\([^\n)]{1,500}\)/,
];

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /agentry_(?:sk|pk|server|ci|runner)_[A-Za-z0-9._-]{8,}/gi,
  /(?:phc|phx)_[A-Za-z0-9._-]+/gi,
  /whsec_[A-Za-z0-9_-]{8,}/gi,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /-----BEGIN(?: [A-Z0-9][A-Z0-9 -]{0,63})?(?:-----)?[\s\S]*/gi,
  /(?:[A-Za-z0-9+/]{32,}={0,2}\s*)?-----END(?: [A-Z0-9][A-Z0-9 -]{0,63})?-----/gi,
  /\bBearer\s+[^\s"'<>]{8,}/gi,
];

/**
 * Return a bounded, recursively redacted view suitable for agent-facing JSON.
 * This function performs no I/O and never follows URLs or executes strings.
 */
export function prepareTelemetryObservation<T>(
  value: T,
  options: TelemetryObservationOptions = {},
): TelemetryObservationView<T> {
  const limits = { ...DEFAULTS, ...options };
  const indicators = new Set<TelemetryIndicator>();
  const externalHosts = new Set<string>();
  const redactedPaths = new Set<string>();
  const truncatedPaths = new Set<string>();
  const ancestors = new WeakSet<object>();
  let visitedNodes = 0;

  const reportPath = (target: Set<string>, path: string) => {
    if (target.size < limits.max_reported_paths) target.add(path);
  };

  const truncate = (path: string, marker = "[TRUNCATED]") => {
    indicators.add("content_truncated");
    reportPath(truncatedPaths, path);
    return marker;
  };

  const inspectText = (text: string) => {
    if (INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text))) {
      indicators.add("instruction_like_text");
    }
    if (SHELL_PATTERNS.some((pattern) => pattern.test(text))) {
      indicators.add("shell_like_text");
    }
    EXTERNAL_REFERENCE.lastIndex = 0;
    for (const match of text.matchAll(EXTERNAL_REFERENCE)) {
      indicators.add("external_url");
      if (externalHosts.size >= limits.max_external_url_hosts) continue;
      try {
        const parsed = new URL(match[0]);
        externalHosts.add(parsed.hostname ? parsed.hostname.toLowerCase() : `${parsed.protocol}//`);
      } catch {
        // A malformed match is still an external-URL indicator. It does not
        // need to be normalized or followed.
      }
    }
  };

  const safeText = (raw: string, path: string): string => {
    let text = raw.replace(CONTROL_CHARACTERS, (character) => {
      indicators.add("control_characters");
      return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
    });

    for (const pattern of SECRET_VALUE_PATTERNS) {
      pattern.lastIndex = 0;
      text = text.replace(pattern, () => {
        indicators.add("potential_secret");
        reportPath(redactedPaths, path);
        return "[REDACTED_SECRET]";
      });
    }
    text = text.replace(
      /([?&](?:access_token|api_key|apikey|key|password|secret|signature|token)=)[^&#\s]*/gi,
      (_match, prefix: string) => {
        indicators.add("potential_secret");
        reportPath(redactedPaths, path);
        return `${prefix}[REDACTED_SECRET]`;
      },
    );

    inspectText(text);
    if (text.length > limits.max_string_chars) {
      const omitted = text.length - limits.max_string_chars;
      text = `${text.slice(0, limits.max_string_chars)}…[TRUNCATED ${omitted} CHARS]`;
      truncate(path, text);
    }
    return text;
  };

  const visit = (input: unknown, path: string, depth: number): unknown => {
    visitedNodes += 1;
    if (visitedNodes > limits.max_nodes) return truncate(path, "[TRUNCATED NODE BUDGET]");
    if (input === null || typeof input === "boolean" || typeof input === "number") return input;
    if (typeof input === "string") return safeText(input, path);
    if (typeof input === "bigint") return safeText(input.toString(), path);
    if (typeof input === "undefined") return null;
    if (typeof input === "symbol" || typeof input === "function") {
      return safeText(String(input), path);
    }
    if (depth >= limits.max_depth) return truncate(path, "[TRUNCATED DEPTH]");

    const object = input as object;
    if (ancestors.has(object)) return truncate(path, "[CIRCULAR]");
    ancestors.add(object);
    try {
      if (Array.isArray(input)) {
        const count = Math.min(input.length, limits.max_array_items);
        const output = input.slice(0, count).map((item, index) => visit(item, `${path}[${index}]`, depth + 1));
        if (input.length > count) output.push(truncate(`${path}[${count}]`, `[TRUNCATED ${input.length - count} ITEMS]`));
        return output;
      }

      const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const entries = Object.entries(input as Record<string, unknown>);
      const count = Math.min(entries.length, limits.max_object_keys);
      for (let index = 0; index < count; index++) {
        const [rawKey, child] = entries[index]!;
        const key = safeText(rawKey, `${path}.$key`).slice(0, 300);
        const childPath = path === "$" ? `$.${key}` : `${path}.${key}`;
        const normalizedKey = rawKey.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
        const isSensitiveKey = SENSITIVE_KEY_SUFFIXES.some((suffix) =>
          normalizedKey === suffix || normalizedKey.endsWith(suffix)
        );
        const isRequestBody = /(?:^|\.)request(?:\.|$)/i.test(path) &&
          ["body", "data", "form", "payload"].includes(normalizedKey);
        if (isSensitiveKey || isRequestBody) {
          indicators.add("potential_secret");
          reportPath(redactedPaths, childPath);
          output[key] = "[REDACTED_SECRET]";
        } else {
          output[key] = visit(child, childPath, depth + 1);
        }
      }
      if (entries.length > count) {
        output["[TRUNCATED_KEYS]"] = truncate(path, `${entries.length - count} keys omitted`);
      }
      return output;
    } finally {
      ancestors.delete(object);
    }
  };

  const content = visit(value, "$", 0) as T;
  return {
    content,
    inspection: {
      heuristic_only: true,
      indicators: INDICATOR_ORDER.filter((indicator) => indicators.has(indicator)),
      external_url_hosts: [...externalHosts].sort(),
      redacted_paths: [...redactedPaths].sort(),
      truncated_paths: [...truncatedPaths].sort(),
    },
  };
}

export function containsUnsafeTelemetryControls(value: string): boolean {
  CONTROL_CHARACTERS.lastIndex = 0;
  return CONTROL_CHARACTERS.test(value);
}

export function mergeTelemetryInspections(
  inspections: readonly TelemetryInspection[],
): TelemetryInspection {
  const indicators = new Set<TelemetryIndicator>();
  const hosts = new Set<string>();
  const redacted = new Set<string>();
  const truncated = new Set<string>();
  for (const inspection of inspections) {
    inspection.indicators.forEach((value) => indicators.add(value));
    inspection.external_url_hosts.forEach((value) => hosts.add(value));
    inspection.redacted_paths.forEach((value) => redacted.add(value));
    inspection.truncated_paths.forEach((value) => truncated.add(value));
  }
  return {
    heuristic_only: true,
    indicators: INDICATOR_ORDER.filter((indicator) => indicators.has(indicator)),
    external_url_hosts: [...hosts].sort().slice(0, DEFAULTS.max_external_url_hosts),
    redacted_paths: [...redacted].sort().slice(0, DEFAULTS.max_reported_paths),
    truncated_paths: [...truncated].sort().slice(0, DEFAULTS.max_reported_paths),
  };
}
