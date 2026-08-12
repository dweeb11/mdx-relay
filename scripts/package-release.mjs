// Stages the three-file Obsidian release directory and packs it with the
// system tar CLI. Reads VERSION from repo-root manifest.json (never dist/).
// No npm dependencies: Node builtins plus tar only.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifestPath = path.join(root, "manifest.json");
const distMain = path.join(root, "dist", "main.js");
const distWorker = path.join(root, "dist", "processing.worker.js");

if (!existsSync(manifestPath)) {
  throw new Error("manifest.json missing at repository root");
}
if (!existsSync(distMain) || !existsSync(distWorker)) {
  throw new Error("dist/ artifacts missing; run npm run build first");
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const version = manifest.version;
if (typeof version !== "string" || version.length === 0) {
  throw new Error("manifest.json.version must be a non-empty string");
}

const releaseDir = path.join(root, "release");
const stageDir = path.join(releaseDir, "mdx-relay");
const archiveName = `mdx-relay-${version}.tar.gz`;
const archivePath = path.join(releaseDir, archiveName);

rmSync(stageDir, { recursive: true, force: true });
rmSync(archivePath, { force: true });
mkdirSync(stageDir, { recursive: true });

cpSync(manifestPath, path.join(stageDir, "manifest.json"));
cpSync(distMain, path.join(stageDir, "main.js"));
cpSync(distWorker, path.join(stageDir, "processing.worker.js"));

const packed = spawnSync(
  "tar",
  [
    "-czf",
    archivePath,
    "-C",
    stageDir,
    "manifest.json",
    "main.js",
    "processing.worker.js",
  ],
  { encoding: "utf8" },
);
if (packed.status !== 0) {
  throw new Error(
    `tar failed (${packed.status}): ${packed.stderr || packed.stdout || ""}`,
  );
}

process.stdout.write(`release archive: ${path.relative(root, archivePath)}\n`);
