import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const CORE_DB_PACKAGE_ROOT = resolve(here, "..");
export const CORE_BASELINE_RELATIVE_PATH = "drizzle/0000_core_baseline.sql";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function baselineStatements(source) {
  const statements = source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  if (statements.length === 0) throw new Error("core bootstrap baseline contains no SQL statements");
  for (const statement of statements) {
    const withoutComments = statement.replace(/^\s*--.*$/gm, "").trim();
    if (!/^CREATE\s+(TABLE|(?:UNIQUE\s+)?INDEX)\b/i.test(withoutComments)) {
      throw new Error("core bootstrap baseline must contain create-only SQL");
    }
    const withoutFinalTerminator = withoutComments.replace(/;\s*$/, "");
    if (withoutFinalTerminator.includes(";")) {
      throw new Error("core bootstrap baseline statements may not contain nested SQL");
    }
  }
  return statements;
}

export async function loadCoreBaseline(root = CORE_DB_PACKAGE_ROOT) {
  const path = join(root, CORE_BASELINE_RELATIVE_PATH);
  const source = await readFile(path, "utf8");
  return {
    path,
    source,
    checksum: sha256(source),
    statements: baselineStatements(source),
  };
}
