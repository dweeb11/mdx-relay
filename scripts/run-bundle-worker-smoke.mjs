// Production-bundle gate: starts the *built* worker (dist/processing.worker.js)
// in a real Node worker thread and drives one plan through it across a genuine
// structured-clone message boundary, transferring the source buffers. The worker
// compiles the embedded codec WASM at load and performs a real PNG decode ->
// WebP encode. No unit mocks, no runtime fetch, no DOM. Non-zero on any blocker.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";
import { Worker } from "node:worker_threads";

const root = fileURLToPath(new URL("../", import.meta.url));
const workerPath = path.join(root, "dist", "processing.worker.js");
const bootstrapPath = path.join(root, "scripts", "bundle-worker-thread.mjs");
const pngPath = path.join(root, "tests", "fixtures", "images", "gradient.png");
const notePath = path.join(
  root,
  "tests",
  "fixtures",
  "public-baseline",
  "source-note.md",
);

// Recorded in docs/adr/0001: WebP q85 / maxDimension 2000 for gradient.png.
const EXPECTED_WEBP_SHA256 =
  "56537a3799f105e50bc5e30d4723bd1b71f483ac915070f78e34d4c051dfdff6";

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

const toArrayBuffer = (buffer) =>
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

const noteBytes = toArrayBuffer(readFileSync(notePath));
const pngBytes = toArrayBuffer(readFileSync(pngPath));
const pngByteLength = pngBytes.byteLength;

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
      byteLength: pngByteLength,
      bytes: pngBytes,
    },
  ],
};

const TERMINAL = new Set(["completed", "blocked", "cancelled"]);
const events = [];

const worker = new Worker(bootstrapPath, {
  workerData: { workerPath },
});
// Captured while the thread is alive; terminate() resets it.
const threadId = worker.threadId;

const terminal = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    reject(new Error("built worker did not complete within 60s"));
  }, 60_000);
  timer.unref?.();

  worker.on("message", (event) => {
    if (event?.type === "bootstrap-ready") {
      // The built worker is loaded and listening in the other thread; only now
      // does the plan cross the boundary.
      worker.postMessage(request, [noteBytes, pngBytes]);
      return;
    }
    events.push(event);
    if (TERMINAL.has(event?.type)) {
      clearTimeout(timer);
      resolve(event);
    }
  });
  worker.on("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  worker.on("exit", (code) => {
    clearTimeout(timer);
    reject(new Error(`built worker exited early with code ${String(code)}`));
  });
});

await worker.terminate();

// The plan really crossed a thread boundary by transfer, not by reference.
assert.ok(threadId > 0, "worker must run in a separate thread");
assert.equal(noteBytes.byteLength, 0, "source note buffer must be transferred");
assert.equal(pngBytes.byteLength, 0, "image buffer must be transferred");

const types = events.map((event) => event.type);
process.stdout.write(`worker events: ${types.join(" -> ")}\n`);
assert.deepEqual(types, ["started", "progress", "completed"]);

assert.equal(
  terminal.type,
  "completed",
  `worker did not complete: ${JSON.stringify(terminal.issues ?? types)}`,
);
const result = terminal.result;
assert.ok(
  result?.ok,
  `worker returned a blocker-first error: ${(result?.error ?? [])
    .map((issue) => issue.code)
    .join(", ")}`,
);

const [image] = result.value.transformedImages;
assert.ok(image, "worker produced no transformed image");
assert.equal(image.decodedMime, "image/png", "source must decode as PNG");
assert.ok(image.width > 0 && image.height > 0, "output must have real pixels");
assert.ok(
  image.decodedWidth > 0 && image.decodedHeight > 0,
  "worker must report the decoded source size",
);
assert.ok(result.value.generatedMdx.byteLength > 0, "no generated MDX bytes");

// The returned bytes must be a real WebP container produced by the embedded
// encoder, matching the deterministic hash recorded in the ADR.
const webp = new Uint8Array(image.bytes);
assert.equal(webp.byteLength, image.byteLength);
const fourcc = (offset) =>
  String.fromCharCode(...webp.subarray(offset, offset + 4));
assert.equal(fourcc(0), "RIFF", "output is not a RIFF container");
assert.equal(fourcc(8), "WEBP", "output is not a WebP container");
const webpSha256 = createHash("sha256").update(webp).digest("hex");
assert.equal(
  webpSha256,
  EXPECTED_WEBP_SHA256,
  "embedded WASM codec produced unexpected WebP bytes",
);

process.stdout.write(
  `bundle worker smoke: dist/processing.worker.js ran in thread ${String(
    threadId,
  )}; transferred ${String(pngByteLength)}B PNG across a structured-clone ` +
    `boundary; embedded WASM produced ${String(image.byteLength)}B WebP ` +
    `${String(image.width)}x${String(image.height)} from a ` +
    `${String(image.decodedWidth)}x${String(image.decodedHeight)} decode ` +
    `(sha256 ${webpSha256.slice(0, 16)}...); ` +
    `MDX(${String(result.value.generatedMdx.byteLength)}B)\n`,
);
