// Inspects the production bundle: enforces the artifact allowlist, rejects any
// native `.node` binary, and records exact file names, sizes, and SHA-256
// hashes. Codec WASM is embedded inside dist/processing.worker.js (proven live
// by scripts/run-bundle-worker-smoke.mjs), so the worker is the WASM asset.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = "dist";
const ALLOWLIST = new Set(["main.js", "processing.worker.js"]);

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(path.join(dir, entry.name))
      : [path.join(dir, entry.name)],
  );

const files = walk(ROOT).sort();
if (files.length === 0) throw new Error("dist/ is empty; run npm run build");

const rows = files.map((file) => {
  const bytes = readFileSync(file);
  return {
    name: path.relative(ROOT, file),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
});

for (const row of rows) {
  process.stdout.write(
    `${row.name.padEnd(24)} ${String(row.bytes).padStart(9)}  sha256:${row.sha256}\n`,
  );
}

const native = rows.filter((row) => row.name.endsWith(".node"));
if (native.length > 0) {
  throw new Error(
    `native .node binaries present: ${native.map((r) => r.name).join(", ")}`,
  );
}

const disallowed = rows.filter((row) => !ALLOWLIST.has(row.name));
if (disallowed.length > 0) {
  throw new Error(
    `bundle allowlist violation: ${disallowed.map((r) => r.name).join(", ")}`,
  );
}

const required = [...ALLOWLIST].filter(
  (name) => !rows.some((row) => row.name === name),
);
if (required.length > 0) {
  throw new Error(`required bundle artifacts missing: ${required.join(", ")}`);
}

process.stdout.write(
  `bundle inspection: ${rows.length} allowed artifacts, 0 native .node files\n`,
);
