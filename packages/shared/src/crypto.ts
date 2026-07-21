// Web Crypto helpers — compatible with Cloudflare Workers and Node 20+.

import { base64url } from "./ids.js";

const enc = new TextEncoder();

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? enc.encode(input) : input;
  const buf = await globalThis.crypto.subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(buf));
}

export async function sha1Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? enc.encode(input) : input;
  const buf = await globalThis.crypto.subtle.digest("SHA-1", data);
  return toHex(new Uint8Array(buf));
}

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return s;
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// Private owner/member API keys: prefix `agentry_sk_` + 32 random base64url chars.

export const API_KEY_PREFIX = "agentry_sk_";

export interface MintedKey {
  raw: string;
  hash: string;
  prefix: string; // first 12 chars including the prefix, used for display + DB lookup
}

export async function mintApiKey(): Promise<MintedKey> {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  const tail = base64url(bytes);
  const raw = `${API_KEY_PREFIX}${tail}`;
  const hash = await sha256Hex(raw);
  return { raw, hash, prefix: raw.slice(0, API_KEY_PREFIX.length + 8) };
}
