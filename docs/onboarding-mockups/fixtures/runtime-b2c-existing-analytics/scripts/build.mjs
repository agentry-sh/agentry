import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "src");
const outputDir = path.join(root, "dist");

function sourceFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = path.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(absolute, relative) : [relative];
    })
    .sort();
}

const files = sourceFiles(sourceDir);
const digest = createHash("sha256");
for (const file of files) {
  digest.update(file);
  digest.update("\0");
  digest.update(readFileSync(path.join(sourceDir, file)));
  digest.update("\0");
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
cpSync(sourceDir, path.join(outputDir, "src"), { recursive: true });
const manifest = {
  schema_version: 1,
  application: "notespark",
  artifact: "node-http-bundle",
  entrypoint: "src/server.js",
  source_sha256: digest.digest("hex"),
  files: files.map((file) => `src/${file}`),
};
writeFileSync(
  path.join(outputDir, "build-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(`LOCAL_BUILD_COMPLETE ${manifest.source_sha256}`);
