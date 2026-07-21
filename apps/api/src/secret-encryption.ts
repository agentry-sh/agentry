import { base64url, errors, fromBase64url } from "@agentrysh/shared";
import type { Env } from "./env.js";

async function importEncryptionKey(rawBase64Url: string): Promise<CryptoKey> {
  const raw = fromBase64url(rawBase64Url);
  if (raw.byteLength !== 32) {
    throw errors.configurationMissing(
      "token_encryption_key_invalid",
      `AGENTRY_TOKEN_ENC_KEY must be 32 bytes base64url, got ${raw.byteLength}.`,
      "Regenerate AGENTRY_TOKEN_ENC_KEY as a 32-byte base64url secret, update the Agentry deployment, redeploy, then retry the operation.",
      { expected_bytes: 32, actual_bytes: raw.byteLength },
    );
  }
  return await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

function encryptionKey(env: Env): string {
  if (!env.AGENTRY_TOKEN_ENC_KEY) {
    throw errors.configurationMissing(
      "token_encryption_key_missing",
      "AGENTRY_TOKEN_ENC_KEY missing.",
      "Set AGENTRY_TOKEN_ENC_KEY to a 32-byte base64url secret on the Agentry deployment, redeploy, then retry the operation.",
    );
  }
  return env.AGENTRY_TOKEN_ENC_KEY;
}

export async function encryptSecret(
  env: Env,
  plaintext: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await importEncryptionKey(encryptionKey(env));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    ciphertext: base64url(new Uint8Array(ciphertext)),
    iv: base64url(iv),
  };
}

export async function decryptSecret(
  env: Env,
  ciphertext: string,
  iv: string,
): Promise<string> {
  const key = await importEncryptionKey(encryptionKey(env));
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64url(iv) },
    key,
    fromBase64url(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

// Transitional internal names for existing encrypted command stores. New code
// should use the storage-neutral encryptSecret/decryptSecret names.
export async function encryptToken(
  env: Env,
  plaintext: string,
): Promise<{ enc: string; iv: string }> {
  const encrypted = await encryptSecret(env, plaintext);
  return { enc: encrypted.ciphertext, iv: encrypted.iv };
}

export async function decryptToken(
  env: Env,
  enc: string,
  iv: string,
): Promise<string> {
  return await decryptSecret(env, enc, iv);
}
