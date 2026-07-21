/**
 * Serialize JSON-compatible data deterministically for hashes, ETags, and
 * idempotency fingerprints. Object keys are sorted recursively while array
 * order is preserved because array order is part of the JSON value.
 *
 * This intentionally rejects values that JSON cannot represent instead of
 * silently dropping or coercing them. Callers use parsed HTTP JSON or Zod
 * output, so encountering one of these values is a programming error.
 */
export function canonicalJsonStringify(value: unknown): string {
  return serializeCanonicalJson(value, new Set<object>());
}

function serializeCanonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON cannot serialize a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Canonical JSON cannot serialize ${typeof value}.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError("Canonical JSON cannot serialize a circular value.");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => serializeCanonicalJson(item, ancestors)).join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON can only serialize plain objects and arrays.");
    }
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        const item = (value as Record<string, unknown>)[key];
        return `${JSON.stringify(key)}:${serializeCanonicalJson(item, ancestors)}`;
      });
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
