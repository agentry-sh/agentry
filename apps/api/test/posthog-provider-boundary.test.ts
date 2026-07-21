import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  }));
  return nested.flat();
}

describe("customer-owned PostHog boundary", () => {
  it("does not register telemetry proxy or PostHog mutation routes", async () => {
    const root = fileURLToPath(new URL("../src", import.meta.url));
    const files = await sourceFiles(root);
    const contents = await Promise.all(files.map(async (path) => ({
      path,
      source: await readFile(path, "utf8"),
    })));
    const index = contents.find(({ path }) => path.endsWith("/index.ts"))?.source ?? "";
    for (const removedRoute of [
      "routes/ingest",
      "routes/track",
      "routes/posthog-cli-proxy",
      "routes/posthog-config",
      "routes/posthog-features",
    ]) {
      expect(index).not.toContain(removedRoute);
    }
    expect(index).toContain("routes/posthog-connection");
    expect(index).toContain("routes/posthog-resources");
    const resourceRoutes = contents.find(({ path }) =>
      path.endsWith("/routes/posthog-resources.ts")
    )?.source ?? "";
    expect(resourceRoutes.match(/router\.get\(/g)).toHaveLength(10);
    expect(resourceRoutes).not.toMatch(/router\.(?:post|put|patch|delete)\(/);
  });

  it("uses redirect handling supported by Cloudflare Workers", async () => {
    const root = fileURLToPath(new URL("../src", import.meta.url));
    const files = await sourceFiles(root);
    const unsupported = await Promise.all(files.map(async (path) => ({
      path: path.slice(root.length + 1),
      source: await readFile(path, "utf8"),
    })));

    expect(unsupported
      .filter(({ source }) => /redirect\s*:\s*["']error["']/.test(source))
      .map(({ path }) => path)
      .sort()).toEqual([]);
  });
});
