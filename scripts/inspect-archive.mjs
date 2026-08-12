// Fail-closed release-archive gate: existence, exact three-file allowlist,
// no native `.node` binaries, non-empty payloads, byte/hash identity with
// repo-root manifest.json and freshly built dist/*.js, and version alignment
// across manifest.json, package.json, and versions.json. Prints per-file size
// and SHA-256 in the same style as scripts/inspect-bundle.mjs.
// Dependency-free: Node builtins + tar.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const ALLOWLIST = ["main.js", "manifest.json", "processing.worker.js"];
const DIST_FILES = ["main.js", "processing.worker.js"];

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

const readJson = (relativePath) => {
  const absolute = path.join(root, relativePath);
  if (!existsSync(absolute)) {
    throw new Error(`${relativePath} missing at repository root`);
  }
  return JSON.parse(readFileSync(absolute, "utf8"));
};

const buffersEqual = (left, right) => {
  if (left.length !== right.length) return false;
  return left.compare(right) === 0;
};

const manifest = readJson("manifest.json");
const packageMetadata = readJson("package.json");
const versions = readJson("versions.json");
const rootManifestBytes = readFileSync(path.join(root, "manifest.json"));

const version = manifest.version;
const minAppVersion = manifest.minAppVersion;
if (typeof version !== "string" || version.length === 0) {
  throw new Error("manifest.json.version must be a non-empty string");
}
if (typeof minAppVersion !== "string" || minAppVersion.length === 0) {
  throw new Error("manifest.json.minAppVersion must be a non-empty string");
}
if (packageMetadata.version !== version) {
  throw new Error(
    `version mismatch: manifest.json (${version}) != package.json (${packageMetadata.version})`,
  );
}
if (!Object.prototype.hasOwnProperty.call(versions, version)) {
  throw new Error(`versions.json missing key for manifest version ${version}`);
}
if (versions[version] !== minAppVersion) {
  throw new Error(
    `versions.json[${version}] (${versions[version]}) != manifest.json.minAppVersion (${minAppVersion})`,
  );
}

const archivePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, "release", `mdx-relay-${version}.tar.gz`);
if (!existsSync(archivePath)) {
  throw new Error(
    `release archive missing: ${path.relative(root, archivePath)}; run npm run package`,
  );
}

const listed = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf8" });
if (listed.status !== 0) {
  throw new Error(
    `tar list failed (${listed.status}): ${listed.stderr || listed.stdout || ""}`,
  );
}
const entries = listed.stdout
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .sort();

const expected = [...ALLOWLIST].sort();
if (
  entries.length !== expected.length ||
  entries.some((entry, index) => entry !== expected[index])
) {
  throw new Error(
    `archive allowlist violation: expected [${expected.join(", ")}], got [${entries.join(", ")}]`,
  );
}

const native = entries.filter((entry) => entry.endsWith(".node"));
if (native.length > 0) {
  throw new Error(`native .node binaries present: ${native.join(", ")}`);
}

const rows = ALLOWLIST.map((name) => {
  const extracted = spawnSync("tar", ["-xOf", archivePath, name], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (extracted.status !== 0) {
    throw new Error(
      `tar extract failed for ${name} (${extracted.status}): ${String(extracted.stderr || "")}`,
    );
  }
  const bytes = Buffer.from(extracted.stdout);
  if (bytes.length === 0) {
    throw new Error(`archived ${name} is empty (0 bytes)`);
  }
  return {
    name,
    bytes: bytes.length,
    sha256: sha256Hex(bytes),
    content: bytes,
  };
});

for (const row of rows) {
  process.stdout.write(
    `${row.name.padEnd(24)} ${String(row.bytes).padStart(9)}  sha256:${row.sha256}\n`,
  );
}

const byName = Object.fromEntries(rows.map((row) => [row.name, row]));

if (!buffersEqual(byName["manifest.json"].content, rootManifestBytes)) {
  throw new Error(
    "archived manifest.json is not byte-identical to repository-root manifest.json",
  );
}

for (const name of DIST_FILES) {
  const distPath = path.join(root, "dist", name);
  if (!existsSync(distPath)) {
    throw new Error(`dist/${name} missing; run npm run package`);
  }
  const distSha256 = sha256Hex(readFileSync(distPath));
  if (byName[name].sha256 !== distSha256) {
    throw new Error(
      `archived ${name} sha256 (${byName[name].sha256}) != dist/${name} sha256 (${distSha256})`,
    );
  }
}

const archivedManifest = JSON.parse(
  byName["manifest.json"].content.toString("utf8"),
);
if (archivedManifest.version !== version) {
  throw new Error(
    `archived manifest.json.version (${archivedManifest.version}) != root (${version})`,
  );
}
if (archivedManifest.minAppVersion !== minAppVersion) {
  throw new Error(
    `archived manifest.json.minAppVersion (${archivedManifest.minAppVersion}) != root (${minAppVersion})`,
  );
}

process.stdout.write(
  `archive inspection: ${rows.length} allowed artifacts, 0 native .node files; version ${version}\n`,
);
