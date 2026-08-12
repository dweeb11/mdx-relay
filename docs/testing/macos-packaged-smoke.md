# macOS packaged smoke acceptance

Manual acceptance checklist for the first local-write safety slice on macOS.
Every criterion must be checked with the actual Obsidian version recorded in the
evidence template at the end. Do not treat asset existence as proof: a
console-silent Ready preview with a converted inline image is the production
proof that the blob-URL worker spawned and a real WASM codec operation ran
through production asset resolution.

## 1. Build on the development machine

- [ ] Run `npm ci` (Node 22 LTS) and confirm exit code 0.
- [ ] Run `npm run verify` and confirm exit code 0 (includes `test:bundle` and
      `test:package`).
- [ ] Run `npm run test:private-baseline`. When
      `MDX_RELAY_PRIVATE_FIXTURE_ROOT` is set to the approved machine-local
      fixture root, the external fixture comparison must pass. When unset, the
      suite skips that external case via the resolver in
      `scripts/resolve-private-baseline.mjs` and still exits 0 for the remaining
      resolver tests. Never copy private fixture bytes into the repository.
- [ ] Run `npm run package` and confirm `release/mdx-relay-VERSION.tar.gz`
      exists (VERSION from repo-root `manifest.json`).
- [ ] Record the `inspect-archive` per-file size and sha256 lines (same style as
      `inspect-bundle`), including the closing
      `archive inspection: 3 allowed artifacts…` line.

Recorded inspect-archive output:

```
(paste lines here)
```

## 2. Install on macOS

- [ ] Transfer `release/mdx-relay-VERSION.tar.gz` to the macOS machine.
- [ ] Create a clean disposable Obsidian vault (empty folder opened as a vault).
- [ ] Create `.obsidian/plugins/mdx-relay/` inside the vault.
- [ ] Extract the archive into that directory so the three files sit at the
      archive root with **no folder prefix**. Expected entries:
      `manifest.json`, `main.js`, `processing.worker.js`.

```bash
tar -xzf mdx-relay-VERSION.tar.gz -C /path/to/vault/.obsidian/plugins/mdx-relay
```

- [ ] Enable the MDX Relay plugin in Obsidian Community plugins / installed
      plugins.
- [ ] Record the actual Obsidian version shown in the app (About / settings).

Obsidian version: _______________

## 3. No-Git proof

Runtime Git integration is out of scope (ADR 0003). Prove the packaged flow
does not invoke `git`:

- [ ] Launch Obsidian from a shell whose `PATH` has `git` removed, or prepend a
      shim directory whose `git` executable logs each invocation and exits
      nonzero.
- [ ] Complete the configure → preview → write flow below under that shell.
- [ ] Confirm the whole flow succeeds.
- [ ] Confirm the shim log shows **zero** invocations (empty log / no entries).

Shim setup notes / log path:

```
(paste here)
```

## 4. Configure

- [ ] Open MDX Relay settings.
- [ ] Confirm the **Profile** dropdown is present and a profile can be selected.
- [ ] Set **Target folder** to an absolute path pointing at a disposable empty
      directory.
- [ ] Confirm inline settings feedback shows the path as valid (no error copy
      such as missing / not a directory / symlink / inaccessible).
- [ ] Create a sentinel file inside the target folder and record its sha256.

```bash
printf 'sentinel\n' > /path/to/target/.mdx-relay-sentinel
shasum -a 256 /path/to/target/.mdx-relay-sentinel
```

Sentinel path: _______________

Sentinel sha256 (before write): _______________

## 5. Preview

- [ ] Open a test Markdown note that embeds one supported inline image.
- [ ] Run the command **Preview MDX export**.
- [ ] Assert the modal status reaches **Ready** via **Capturing note…** and
      **Building exact preview…** (or the live progress text that replaces the
      default building status).
- [ ] Assert the exact-files list renders.
- [ ] Assert the MDX diff renders.
- [ ] Open DevTools Console and confirm it stays silent during the successful
      preview. The only construction-failure signature in the codebase is the
      exact string `MDX Relay worker construction failed`. Console-silent success
      with the image converted is the proof that the blob-URL worker spawned and
      a real WASM codec operation ran through production asset resolution.

## 6. Write

- [ ] Tick **I reviewed this exact plan**.
- [ ] Click **Approve**.
- [ ] Verify each written target file byte-for-byte by sha256 against the
      preview / plan expectations.
- [ ] Re-hash the sentinel and confirm its sha256 is unchanged.
- [ ] Confirm nothing else in the target folder was touched (no extras, no
      deletions, no rewrites outside the approved set).
- [ ] Disable the MDX Relay plugin.
- [ ] Confirm DevTools shows no console error on unload.
- [ ] Confirm **Preview MDX export** is gone from the command palette.

Written-file sha256 records:

```
(paste path + sha256 lines here)
```

Sentinel sha256 (after write): _______________

## 7. Failure modes appendix

These are observational checks, not required to pass the happy-path smoke, but
record them when exercised:

- [ ] **Worker crash symptom:** modal status shows **Blocked** and the issue
      list includes a `WORKER_CRASHED` (`workerCrashed`) blocker item. A
      construction failure may also log the exact console string
      `MDX Relay worker construction failed` with a request identifier.
- [ ] **Distinct target-root blockers:** misconfigured target roots surface
      distinct codes (`TARGET_ROOT_MISSING`, `TARGET_ROOT_NOT_DIRECTORY`,
      `TARGET_ROOT_SYMLINK`, `TARGET_ROOT_INACCESSIBLE`) that name the configured
      path in `displayDetails.detail`, rather than collapsing into generic
      staleness.

## 8. Evidence record template

Copy this block into the acceptance notes. Check every criterion above and fill
every field.

| Field                                  | Value                          |
| -------------------------------------- | ------------------------------ |
| Date                                   |                                |
| Operator                               |                                |
| Obsidian version                       |                                |
| macOS version                          |                                |
| Archive path                           | `release/mdx-relay-__.tar.gz`  |
| Archive `manifest.json` sha256         |                                |
| Archive `main.js` sha256               |                                |
| Archive `processing.worker.js` sha256  |                                |
| `npm run verify` exit code             |                                |
| `npm run test:private-baseline` result | pass / skipped-external / fail |
| Sentinel sha256 before write           |                                |
| Sentinel sha256 after write            |                                |
| Written file sha256s                   | (list)                         |
| Git shim invocations                   | 0                              |
| DevTools console during Ready preview  | silent                         |
| Plugin unload console                  | silent                         |
| Command gone after disable             | yes / no                       |

Command outputs (paste):

```
(npm ci / verify / package / inspect-archive / shasum lines)
```

Checklist completion: every item in sections 1–6 checked ☐
