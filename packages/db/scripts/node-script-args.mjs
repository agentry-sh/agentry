import { extname } from "node:path";

export const TYPESCRIPT_STRIP_FLAG = "--experimental-strip-types";

/**
 * Node 22.12 supports erasable TypeScript only behind an explicit flag. Keep
 * every directly executed migration compatible with the repository's declared
 * minimum instead of relying on the Node 22.18+ default.
 */
export function nodeScriptArgs(scriptPath, args = []) {
  return [
    ...(extname(scriptPath).toLowerCase() === ".ts" ? [TYPESCRIPT_STRIP_FLAG] : []),
    scriptPath,
    ...args,
  ];
}
