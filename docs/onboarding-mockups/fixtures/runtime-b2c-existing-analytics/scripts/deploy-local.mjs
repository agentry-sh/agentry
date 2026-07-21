import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(root, "dist");
const manifestFile = path.join(buildDir, "build-manifest.json");
if (!existsSync(manifestFile)) {
  throw new Error("build manifest missing; run npm run build before deploy completion");
}

const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
const deployDir = path.join(root, "out", "local-deploy");
const currentDir = path.join(deployDir, "current");
rmSync(currentDir, { recursive: true, force: true });
mkdirSync(deployDir, { recursive: true });
cpSync(buildDir, currentDir, { recursive: true });

const receipt = {
  schema_version: 1,
  provider: "notespark-pipeline",
  environment: "local",
  status: "completed",
  release_sha256: manifest.source_sha256,
  deploy_sha: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  entrypoint: "current/src/server.js",
  build_manifest: "current/build-manifest.json",
  completion_command: "npm run deploy",
};
writeFileSync(
  path.join(deployDir, "deployment.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
console.log(`LOCAL_DEPLOY_COMPLETE ${receipt.release_sha256}`);
