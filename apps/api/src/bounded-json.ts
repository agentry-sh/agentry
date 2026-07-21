import { AgentryError, errors } from "@agentrysh/shared";
import type { Context } from "hono";
import type { AppBindings } from "./env.js";

type BoundedBodyOptions = {
  allowEmpty?: boolean;
};

/**
 * Read a request stream under a cumulative byte limit.
 *
 * Content-Length is only an early rejection hint: callers must not trust it,
 * because chunked bodies can omit it and clients can under-report it. The
 * returned Uint8Array is allocated only after the complete bounded stream has
 * been read.
 */
export async function readBoundedBytes(
  c: Context<AppBindings>,
  maxBytes: number,
  options: BoundedBodyOptions = {},
): Promise<Uint8Array | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("request body limit must be a positive safe integer");
  }

  const contentLengthHeader = c.req.header("content-length")?.trim();
  if (contentLengthHeader) {
    if (!/^\d+$/.test(contentLengthHeader)) {
      throw errors.invalidPayload({ reason: "Content-Length must be a nonnegative integer" });
    }
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength)) {
      throw errors.invalidPayload({ reason: "Content-Length is outside the supported range" });
    }
    if (contentLength > maxBytes) {
      throw errors.payloadTooLarge(maxBytes, contentLength);
    }
  }

  const body = c.req.raw.body;
  if (!body) {
    if (options.allowEmpty) return null;
    throw errors.invalidPayload({ reason: "body is empty" });
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("request body exceeds limit").catch(() => {});
        throw errors.payloadTooLarge(maxBytes, total);
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof AgentryError) throw error;
    throw errors.invalidPayload({ reason: "request body stream could not be read" });
  } finally {
    reader.releaseLock();
  }

  if (total === 0) {
    if (options.allowEmpty) return null;
    throw errors.invalidPayload({ reason: "body is empty" });
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Parse JSON under an actual byte limit even when Content-Length is absent or
 * dishonest. Telemetry endpoints must use this instead of c.req.json().
 */
export async function readBoundedJson(
  c: Context<AppBindings>,
  maxBytes: number,
): Promise<unknown> {
  const bytes = await readBoundedBytes(c, maxBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let text: string;
  try {
    text = decoder.decode(bytes!);
  } catch {
    throw errors.invalidPayload({ reason: "body is not valid UTF-8 JSON" });
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw errors.invalidPayload({ reason: "body is not valid JSON" });
  }
}

/** Parse an optional JSON body while still rejecting malformed nonempty JSON. */
export async function readOptionalBoundedJson(
  c: Context<AppBindings>,
  maxBytes: number,
): Promise<unknown | undefined> {
  const bytes = await readBoundedBytes(c, maxBytes, { allowEmpty: true });
  if (!bytes) return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw errors.invalidPayload({ reason: "body is not valid UTF-8 JSON" });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw errors.invalidPayload({ reason: "body is not valid JSON" });
  }
}

export function positiveIntOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
