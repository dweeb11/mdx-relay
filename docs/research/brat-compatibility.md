# BRAT compatibility and release-asset layout

Research summary for Linear ticket [APP-678](https://linear.app/critterhaus/issue/APP-678/brat-compatibility-and-release-asset-layout), part of the "MDX Relay shareable macOS beta" wayfinder map (APP-677).

**Verdict: GO on BRAT — conditional on one packaging change.** BRAT cannot deliver `processing.worker.js`, so the worker must stop being a separate release asset. The tarball-instructions fallback is not needed.

## What BRAT actually fetches

Evidence: current BRAT source at [TfTHacker/obsidian42-brat](https://github.com/TfTHacker/obsidian42-brat), `src/features/BetaPlugins.ts` @ `e0908d3` (read 2026-08-15).

- The `ReleaseFiles` interface is exactly `{ mainJs, manifest, styles }`. `getAllReleaseFiles()` fetches release assets **by exact filename**: `main.js`, `manifest.json`, `styles.css`. There is no mechanism for arbitrary extra assets, and BRAT never unpacks archives — a `.tar.gz` asset is ignored.
- `writeReleaseFilesToPluginFolder()` writes only those three files into `.obsidian/plugins/<id>/` (`styles.css` only if present in the release).
- Install fails only if `main.js` is missing from the release. A missing `processing.worker.js` would **not** fail install — the plugin would install cleanly and then break at runtime when `plugin-composition.ts` does `new Worker(`${manifest.dir}/processing.worker.js`)`.
- Obsidian's official community-plugin installer has the same three-file contract, so fixing this now also removes a future graduation blocker (community listing itself stays out of scope for this map).

## Release layout BRAT requires

- A GitHub **release whose tag equals `manifest.json`'s `version`**. BRAT semver-coerces the tag and, on mismatch, the tag **overrides** the manifest version — keep them byte-identical to avoid surprises.
- `manifest.json` and `main.js` attached as **individual release assets** (not only inside the tarball). MDX Relay ships no `styles.css`; BRAT treats it as optional.
- The existing `mdx-relay-<version>.tar.gz` can remain an additional asset — BRAT ignores it; it stays as the archival / manual-install artifact.
- Optional beta channel: a `manifest-beta.json` at the repo root lets BRAT track pre-releases. Not needed for the first beta.

## versions.json

BRAT does **not** read `versions.json` at any point. It enforces `minAppVersion` by comparing the release manifest's value against the running Obsidian `apiVersion` (hard block, or a confirm dialog if the user enabled incompatible installs). `versions.json` matters only to the official community catalog — keep maintaining it (the `inspect-archive.mjs` gate already enforces manifest/package/versions alignment), but it has no interaction with the BRAT flow.

BRAT's update flow: on launch (or manual command) it fetches the latest release, semver-compares the release manifest version against the locally installed one, and on a newer remote redownloads the three files, overwrites, and reloads the plugin. Stale extra files in the plugin folder are never cleaned up — another reason not to ship loose files BRAT doesn't manage.

## Required change: eliminate the separate worker file

**Recommended: inline the worker bundle into `main.js` and instantiate it via a Blob URL.** The worker bundle is already fully self-contained (its codec WASM is inlined as bytes per `esbuild.config.mjs`), so this is one more level of inlining: embed the built worker source as text in the main bundle and do `new Worker(URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" })))`. This is the standard technique for worker-using Obsidian plugins. The release then has the canonical two-file layout (`manifest.json` + `main.js`) and works identically under BRAT, manual install, and any future community install.

Rejected alternative: have `main.js` self-extract `processing.worker.js` into the plugin folder on load. It works under BRAT, but adds a write surface outside the approved target folder, plus a stale-file hazard on update (BRAT overwrites `main.js` but never removes or refreshes files it doesn't manage).

Execution-milestone verification item: confirm `new Worker(blobUrl)` behaves under Obsidian's Electron renderer CSP on macOS before deleting the file-based path (expected to work; verify, don't assume).

## Packaging-machinery adaptation (T8 follow-ups)

- `esbuild.config.mjs`: keep building the worker bundle, then embed its output text into the main bundle (build worker first, inject as a define/loader input to the main build). `dist/processing.worker.js` may survive as an intermediate; it stops being a shipped artifact.
- `scripts/package-release.mjs`: stage `manifest.json` + `main.js` only; keep producing the tarball; additionally leave the loose staged files in `release/mdx-relay/` for upload as individual assets.
- `scripts/inspect-archive.mjs`: allowlist shrinks to `["main.js", "manifest.json"]`; extend the gate to also hash the **loose** release assets and require byte-identity with the archive contents, so the BRAT-served files and the tarball can never diverge.
- Release publish step: `gh release create <version> manifest.json main.js mdx-relay-<version>.tar.gz` with the tag exactly matching the manifest version.
