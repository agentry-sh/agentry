import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const ROUTES_DIR = join(ROOT, "apps/api/src/routes");
export const INDEX_FILE = join(ROOT, "apps/api/src/index.ts");

const METHOD_NAMES = ["get", "post", "put", "patch", "delete", "options"];
const IMPORT_RE =
  /import\s+(.+?)\s+from\s+["']\.\/routes\/([A-Za-z0-9_-]+)\.js["'];/g;
const ROUTE_MOUNT_RE = /app\.route\(\s*["']([^"']+)["']\s*,\s*([A-Za-z0-9_]+)\s*\)/g;
const HONO_EXPORT_RE =
  /(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*new\s+Hono<[^>]+>\(\s*\)/g;
const HONO_LOCAL_RE =
  /const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*new\s+Hono<[^>]+>\(\s*\)/g;
const DEFAULT_EXPORT_RE = /export\s+default\s+([A-Za-z_][A-Za-z0-9_]*)\s*;?/g;

function parseImportedBindings(clause) {
  const bindings = [];
  const trimmed = clause.trim();
  if (!trimmed) return bindings;

  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.indexOf("}");

  if (braceStart !== -1 && braceEnd !== -1 && braceEnd > braceStart) {
    const before = trimmed.slice(0, braceStart).trim().replace(/,\s*$/, "");
    const inside = trimmed.slice(braceStart + 1, braceEnd);
    if (before) bindings.push({ local: before, imported: "default", isDefault: true });
    for (const raw of inside.split(",")) {
      const part = raw.trim();
      if (!part) continue;
      const aliasMatch = part.match(/^([A-Za-z0-9_]+)\s+as\s+([A-Za-z0-9_]+)$/);
      bindings.push(
        aliasMatch
          ? { local: aliasMatch[2], imported: aliasMatch[1], isDefault: false }
          : { local: part, imported: part, isDefault: false },
      );
    }
    return bindings;
  }

  bindings.push({
    local: trimmed.replace(/,$/, "").trim(),
    imported: "default",
    isDefault: true,
  });
  return bindings.filter(Boolean);
}

function collectRouterVars(filePath) {
  const text = readFileSync(filePath, "utf8");
  const vars = new Set();
  for (const match of text.matchAll(HONO_EXPORT_RE)) vars.add(match[1]);
  for (const match of text.matchAll(HONO_LOCAL_RE)) vars.add(match[1]);
  const defaultExports = [];
  for (const match of text.matchAll(DEFAULT_EXPORT_RE)) defaultExports.push(match[1]);
  return { text, vars, defaultExports };
}

function joinMount(base, path) {
  if (path === "/") return base;
  if (base === "/") return path;
  if (!path.startsWith("/")) {
    return `${base}/${path}`.replace(/\/+/g, "/");
  }
  return `${base}${path}`.replace(/\/+/g, "/");
}

export function collectMountedRoutes() {
  const indexText = readFileSync(INDEX_FILE, "utf8");
  const importMap = new Map();

  for (const match of indexText.matchAll(IMPORT_RE)) {
    const [, clause, routeFileBase] = match;
    for (const binding of parseImportedBindings(clause)) {
      importMap.set(binding.local, {
        routeFile: `${routeFileBase}.ts`,
        imported: binding.imported,
        isDefault: binding.isDefault,
      });
    }
  }

  const mounts = [];
  for (const match of indexText.matchAll(ROUTE_MOUNT_RE)) {
    const [, mountPath, binding] = match;
    const imported = importMap.get(binding);
    if (!imported) continue;
    mounts.push({ mountPath, binding, ...imported });
  }

  const routeFiles = new Map();
  for (const file of readdirSync(ROUTES_DIR).filter((name) => name.endsWith(".ts")).sort()) {
    const filePath = join(ROUTES_DIR, file);
    routeFiles.set(file, collectRouterVars(filePath));
  }

  const routes = [];
  for (const mount of mounts) {
    const routeFile = routeFiles.get(mount.routeFile);
    if (!routeFile) continue;
    const routerVar =
      mount.isDefault
        ? routeFile.defaultExports[0]
        : mount.imported;
    if (!routerVar || !routeFile.vars.has(routerVar)) continue;

    const routeCall = new RegExp(
      String.raw`(?:^|[^\w.])${routerVar}\.(get|post|put|patch|delete|options)\(\s*["']([^"']+)["']`,
      "gm",
    );
    for (const match of routeFile.text.matchAll(routeCall)) {
      const [, method, localPath] = match;
      if (!METHOD_NAMES.includes(method)) continue;
      routes.push({
        method: method.toUpperCase(),
        path: joinMount(mount.mountPath, localPath),
        mountPath: mount.mountPath,
        routerBinding: routerVar,
        routeFile: mount.routeFile,
        localPath,
      });
    }
  }

  return routes.sort((a, b) =>
    a.path === b.path
      ? a.method.localeCompare(b.method)
      : a.path.localeCompare(b.path),
  );
}
