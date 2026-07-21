// Per-request libSQL client. Cloudflare Workers reuse isolates unpredictably,
// so we don't memoize the client globally.
//
// Use the package's conditional export instead of hard-coding the web entry.
// Workerd/Workers resolve this to the web client, while the disposable local
// onboarding API resolves it to the Node client so a throwaway file: database
// can be used without a remote Turso dependency.

import { createClient as createLibsql } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.js";

export type AgentryDb = ReturnType<typeof drizzle<typeof schema>>;

export function createClient(opts: { url: string; authToken?: string }): AgentryDb {
  const client = createLibsql({ url: opts.url, authToken: opts.authToken });
  return drizzle(client, { schema });
}
