import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function loadAgentryCredentials() {
  const credentialsPath = process.env.AGENTRY_CREDENTIALS ?? join(homedir(), ".agentry", "credentials.json");
  const credentials = readJson(credentialsPath);
  const apiKey =
    process.env.AGENTRY_PRIVATE_API_KEY ??
    (typeof credentials?.api_key === "string" ? credentials.api_key : null);
  const serverUrl = process.env.AGENTRY_URL ?? "https://api.agentry.sh";
  return {
    apiKey,
    serverUrl,
    credentialsPath,
  };
}
