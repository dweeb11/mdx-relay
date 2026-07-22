// Production-bundle gate: starts the *built* worker (dist/processing.worker.js)
// inside a minimal DedicatedWorker global scope and drives one real plan through
// it. The worker compiles the embedded codec WASM at load and performs a genuine
// PNG decode -> WebP encode — no unit mocks. Fails non-zero on any blocker.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const workerPath = path.join(root, "dist", "processing.worker.js");
const pngPath = path.join(root, "tests", "fixtures", "images", "gradient.png");
const notePath = path.join(
  root,
  "tests",
  "fixtures",
  "public-baseline",
  "source-note.md",
);

const messageHandlers = [];
const events = [];
globalThis.self = {
  addEventListener(type, listener) {
    if (type === "message") messageHandlers.push(listener);
  },
  postMessage(event) {
    events.push(event);
  },
};

// Loading the built artifact compiles the embedded WASM and registers the
// worker's message handler — this is the worker starting up.
require(workerPath);
if (messageHandlers.length === 0) {
  throw new Error("built worker did not register a message handler");
}

const profile = {
  schemaVersion: 1,
  id: "dpw-mind-net-v1",
  name: "DPW Mind Net",
  repository: { remote: "origin", branch: "main" },
  output: {
    contentRoot: "content/posts",
    assetRoot: "public/posts",
    assetUrlTemplate: "/posts/{slug}/{assetFile}",
  },
  document: {
    preset: "dpw-mind-net-v1",
    wikilinks: "flatten",
    callouts: "blockquote",
    frontmatterPreset: "dpw-post-v1",
  },
  images: {
    component: "PostImage",
    filenameTemplate: "img-{index}.webp",
    maxDimension: 2000,
    webpQuality: 85,
  },
  commit: { message: "Publish {title}" },
};

const noteBytes = new Uint8Array(readFileSync(notePath)).buffer;
const pngBytes = new Uint8Array(readFileSync(pngPath)).buffer;

const request = {
  type: "process-plan",
  generationToken: "smoke-generation",
  planStartedAtMs: Date.now(),
  planDeadlineMs: Date.now() + 600_000,
  imageTimeoutMs: 60_000,
  sourceNote: {
    vaultRelativePath: "notes/example.md",
    safePathLabel: "notes/example.md",
    byteLength: noteBytes.byteLength,
    contentSha256: "sha256:note",
    bytes: noteBytes,
  },
  profileSnapshot: JSON.stringify(profile),
  profileSnapshotSha256: "sha256:profile",
  dependencySnapshot: "{}",
  dependencySnapshotSha256: "sha256:deps",
  images: [
    {
      sourceId: "image-1",
      safePathLabel: "assets/image.png",
      contentSha256: "sha256:image",
      byteLength: pngBytes.byteLength,
      bytes: pngBytes,
    },
  ],
};

for (const handler of messageHandlers) handler({ data: request });

const deadline = Date.now() + 15_000;
const terminal = new Set(["completed", "blocked", "cancelled"]);
while (!events.some((event) => terminal.has(event.type))) {
  if (Date.now() > deadline) throw new Error("worker did not complete in time");
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const types = events.map((event) => event.type);
process.stdout.write(`worker events: ${types.join(" -> ")}\n`);

const completed = events.find((event) => event.type === "completed");
if (!completed) {
  const blocked = events.find((event) => event.type === "blocked");
  throw new Error(
    `worker did not complete: ${JSON.stringify(blocked?.issues ?? types)}`,
  );
}
const result = completed.result;
if (!result?.ok) {
  const codes = (result?.error ?? []).map((issue) => issue.code);
  throw new Error(`worker returned a blocker-first error: ${codes.join(", ")}`);
}

const [image] = result.value.transformedImages;
if (!image || image.decodedMime !== "image/png" || image.byteLength <= 0) {
  throw new Error("worker did not produce a WebP image from the PNG source");
}
if (result.value.generatedMdx.byteLength <= 0) {
  throw new Error("worker did not produce generated MDX bytes");
}

process.stdout.write(
  `bundle worker smoke: real WASM codec ran; PNG(${pngBytes.byteLength}B) -> ` +
    `WebP(${image.byteLength}B) ${image.width}x${image.height}; ` +
    `MDX(${result.value.generatedMdx.byteLength}B)\n`,
);
