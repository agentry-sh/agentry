import { createHash } from "node:crypto";

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizedText(value) {
  return `${String(value).replace(/\r\n/g, "\n").trimEnd()}\n`;
}

export function surfaceDigest(kind, value) {
  const canonical = kind === "json" ? canonicalJson(value) : normalizedText(value);
  return createHash("sha256").update(canonical).digest("hex");
}

export function compareAgentSurface({ id, path, kind, expected, actual, status = 200 }) {
  const expectedSha256 = surfaceDigest(kind, expected);
  const actualSha256 = status === 200 ? surfaceDigest(kind, actual) : null;
  return {
    id,
    path,
    kind,
    status,
    expected_sha256: expectedSha256,
    actual_sha256: actualSha256,
    ok: status === 200 && actualSha256 === expectedSha256,
    failure: status !== 200
      ? `live surface returned HTTP ${status}`
      : actualSha256 !== expectedSha256
        ? "live surface differs from the local release contract"
        : null,
  };
}
