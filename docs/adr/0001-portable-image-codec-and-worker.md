# ADR 0001: Portable image codec and dedicated worker

**Status:** Accepted
**Date:** 2026-07-22
**Issue:** APP-563 (T3 — prove the portable codec and dedicated worker)
**Root:** APP-475 first safety slice

## Context

Native Sharp and any `.node` binary are forbidden: an ordinary Obsidian
Community plugin ships browser-safe code only. The image pipeline (decode
PNG/JPEG/WebP, apply EXIF orientation, no-upscale resize to 2000px, encode WebP
quality 85) must run off the UI thread with deterministic output, hard budgets,
and production WASM asset loading. This ADR records the decisions made while
proving the portable codec and the dedicated worker behind the frozen
`ImageCodec` and worker-protocol contracts.

## Decisions

### 1. jSquash codecs behind the frozen `ImageCodec`

Pinned exactly: `@jsquash/png@3.1.1`, `@jsquash/jpeg@1.6.0`,
`@jsquash/webp@1.5.0`. Decode uses each package's WASM decoder; encode uses the
WebP encoder. All jSquash codecs pass their mandatory gates, so the frozen
`ImageCodec` abstraction is retained and jSquash is adopted behind it (no
fallback implementation required).

### 2. Explicit non-SIMD WebP encoder for determinism

`@jsquash/webp`'s default `encode` calls `wasm-feature-detect` and dynamically
imports a SIMD build when available. SIMD vs. scalar builds can differ in output
bytes and availability differs across runtimes, which would make output
non-deterministic. We bypass the auto-selection and drive the non-SIMD
`webp_enc.wasm` encoder directly via `initEmscriptenModule`, so encoding never
depends on runtime SIMD detection.

### 3. EXIF orientation and resize implemented in-tree

EXIF orientation parsing/application and the no-upscale area-average resize are
pure TypeScript (`image-metadata.ts`, `pixel-ops.ts`). `@jsquash/resize` is not
used and not a dependency. Rationale: fixed-order IEEE-754 arithmetic is defined
by ECMAScript and identical across architectures, giving full determinism under
our control while removing three additional WASM modules (resize/hqx/magic-kernel)
from the bundle. The orientation remap was validated pixel-identical (0 diff for
all 8 orientations) against mozjpeg's own EXIF rotation as a reference.

JPEG is decoded with `preserveOrientation: false` (raw stored pixels) and
oriented in-tree; PNG is treated as upright; WebP EXIF chunks are parsed. All
parsing fails closed to orientation 1.

### 4. WASM inlined into the worker bundle via the esbuild `binary` loader

Each codec's WASM is imported with esbuild's `binary` loader and instantiated
from a precompiled `WebAssembly.Module` (jSquash `init(module)` /
`initEmscriptenModule(factory, module)`). The worker performs no runtime
`fetch`/`locateFile`/URL resolution — robust for Obsidian's Blob/worker model
and deterministic. Consequence: there are no separate `.wasm` files on disk; the
required WASM assets are embedded inside `dist/processing.worker.js` and proven
live by the production-bundle smoke, which instantiates and runs them. The bundle
allowlist is `{main.js, processing.worker.js}` and rejects any `.node` file.

The smoke starts the built artifact in a real Node worker thread
(`scripts/bundle-worker-thread.mjs` supplies only the
`DedicatedWorkerGlobalScope` surface — `addEventListener`/`postMessage` over
`parentPort` — and stubs nothing else), transfers the note and PNG buffers across
a genuine structured-clone boundary, and asserts the returned bytes are a real
WebP container whose sha256 matches the recorded deterministic hash. Loading the
bundle in the parent process and calling its handler directly would prove none of
that, so it is not an acceptable substitute.

### 5. Worker built with the `"worker"` export condition

esbuild builds the worker with `conditions: ["worker"]`. This makes DOM-less
package builds win — notably `decode-named-character-reference` resolves to its
table-based module instead of the `document`-based browser build. Without this
the worker crashed at load in a DOM-less scope. This is the correct signal: the
artifact is a Web Worker.

### 6. The worker generates MDX and transforms images

Per the approved flow the dedicated worker runs both the source-preserving
Markdown transform (T2) and the portable image codec, emitting one
`WorkerCompletion`. The parent client is the T3 decoder: it gates events by
generation token (stale/late events discarded), enforces plan and per-image
budgets by terminating the worker, synthesizes blocked events on
timeout/cancel/crash, and re-verifies byte lengths, hashes, and severity
channels before branding a `DecodedWorkerEvent`.

### 7. Codecs report decoded source dimensions

`MDX_RELAY_LIMITS.cumulativeDecodedPixels` (400 MP) bounds the decode work one
plan may perform, but neither side could measure it: `TransformedImage` exposed
only the *output* size, which resize has already reduced to at most
2000px on the long edge. `TransformedImage` and `WorkerImageOutput` therefore
gain `decodedWidth`/`decodedHeight` — the raw decoded source size, before EXIF
orientation and resize. That is the decode cost actually paid, and it is the
only honest unit for the budget.

The budget is charged once per canonical source, matching the existing duplicate
embed dedupe. The parent recomputes the same total from the reported dimensions
using its own request hashes, so the worker's accounting is never taken on
trust; a disagreement fails closed on `DECODED_WORK_LIMIT_EXCEEDED`. Repeat
embeds are compared on their exact decoded edges rather than their area — 2x6
and 3x4 are the same twelve pixels but cannot be the same decode — and any
disagreement is a malformed report.

### 8. A bounded header probe makes the cumulative cap a real work cap

Charging the budget from the *reported* decoded size can only ever report an
overshoot after paying for it: the worker decoded the next source, added its
cost, and blocked afterwards, so a plan could perform up to 440 MP against a
400 MP limit. A cap enforced after the work is a reporting threshold, not a cap.

`readImageHeader` (`src/images/image-metadata.ts`) therefore probes only
fixed-position container header fields — PNG `IHDR`, the JPEG `SOFn` frame
header, and the WebP `VP8 `/`VP8L`/`VP8X` chunks — and never touches pixel data.
It returns the raw stored size, which is exactly the `decodedWidth`/
`decodedHeight` a decode reports, so the cost of a source is known before the
decode that would spend it. Truncated, malformed, and unrecognized inputs fail
closed on the same `UNSUPPORTED_IMAGE`/`IMAGE_DECODE_FAILED` channels the codec
uses.

Consequences in `processPlan`: dedupe by parent-owned content hash happens
before probing *and* charging; each edge is bounded against the 40 MP per-image
ceiling before the two are multiplied, so a header declaring `0xFFFFFFFF` edges
cannot overflow the charge; a source that would push the plan past 400 MP is
refused without doing its work; and a decoder that disagrees with the header it
was charged for fails the plan closed rather than leaving the accounting wrong.
The probe is proven against the real WASM codec for every fixture, including the
EXIF-orientation-6 source whose output is transposed but whose decode is not.

### 9. The parent enforces the emission order and bounds its own verification

`started -> progress* -> terminal` is a trust boundary, not documentation.
`progress` is the only wire signal that arms the per-image clock, so a
completion trusted without it buys image work no timer ever governed. A success
completion is accepted only after `started` and exactly all expected image
progress events in ascending order; zero-image plans still require `started`; an
error arm may still stop at the image that failed, because it carries no trusted
output. Anything arriving after an accepted terminal fails closed.

Parent-side hash verification is asynchronous and is itself a place the run can
hang or throw. The per-image clock stops when the completion arrives — image
work really is over and must not govern parent hashing — but the plan deadline
stays armed through verification as the hard bound, and a digest that rejects
settles once on the redacted `MALFORMED_WORKER_RESPONSE` channel. `process()`
never rejects, and both paths release the worker through the single `settle`
funnel.

## Determinism and architecture verification

Repeated runs produce byte-identical WebP. Recorded output hashes (WebP q85,
maxDimension 2000) for the synthetic gradient fixtures:

| source        | sha256 (WebP output)                                               |
| ------------- | ------------------------------------------------------------------ |
| gradient.png  | `56537a3799f105e50bc5e30d4723bd1b71f483ac915070f78e34d4c051dfdff6` |
| gradient.jpg  | `dd84baffebaa6ef929bff9aafa935159b4225c49bb51561a3ebdf1517997ad0d` |
| gradient.webp | `9ab4e6ae4eb722cba49a33360ea03ae0857d8f51e4be9e07cee3e61e47a087fe` |

Embedded codec WASM (exact pinned bytes):

| module              |   bytes | sha256 |
| ------------------- | ------: | ------ |
| squoosh_png_bg.wasm | 181088 | `263d6e658808a74b72a1a99c5cc1d619237e70c150db6e41d5d84d3d117ab9be` |
| mozjpeg_dec.wasm    | 166470 | `a7c4b12169817e779ff4af137981393ae924944e167ad1bd95747c9199162d3e` |
| webp_dec.wasm       | 137960 | `30fb52fa2a80166d25ba7debf902218904ba1f05ccce9f959f722beff9e2f344` |
| webp_enc.wasm       | 281261 | `b6085bb6702f144e9dc6016d58d230b34a84976bf0d080b7390b4b4b137d6ab7` |

**Architecture verified: arm64 macOS (Darwin) only**, in this environment. The
x86_64 hash could not be produced here. WebAssembly execution is deterministic by
specification and both the codec WASM and the in-tree resize/orientation math use
defined integer/IEEE-754 operations, so identical output is *expected* on x86_64
— but that is not yet independently verified. We therefore keep a **single**
fixture/hash set rather than pretending cross-architecture proof. If a future CI
run on x86_64 shows any divergence, the fixtures and recorded hashes will be
scoped by architecture and this ADR updated; until then the hashes above are
labelled arm64-recorded.

## Alternatives considered

- **`@jsquash/resize` (Lanczos/Catmull-Rom WASM):** higher-fidelity resampling,
  still deterministic, but adds three WASM modules and cross-arch surface. Rejected
  in favour of in-tree determinism control for this proof slice.
- **Separate on-disk `.wasm` assets loaded at runtime:** would give file-level
  allowlist entries but requires runtime fetch/URL resolution that is fragile in a
  Blob-based Obsidian worker. Rejected in favour of inlining; the smoke proves the
  embedded assets execute.

## Consequences

- Deterministic, browser/worker-safe conversion with no native binaries.
- `npm run test:bundle` builds the real bundle and runs a genuine embedded-WASM
  codec operation through the started worker.
- Cross-architecture hash parity is expected but unverified; tracked as a narrow
  follow-up for x86_64 CI.
