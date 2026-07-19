# MDX Relay First Safety Slice Engineering Plan

**Date:** 2026-07-19

**Branch:** `main`

**Root issue:** APP-475

**Status:** Engineering review complete; ready for implementation

**Scope mode:** Reduced safety slice

## Goal

Prove this chain without allowing production publishing to a user repository:

```text
Active Obsidian Markdown note
        │
        ▼
Coherent capture + dependency graph
        │
        ▼
Dedicated worker: source-preserving MDX transform + portable image codec
        │
        ▼
Final capture barrier
        │
        ▼
Sealed ExportPlan + owner-only private blob store
        │
        ▼
Exact Ready / No Changes / Blocked preview
        │
        ▼
Disposable repository transaction proof
        │
        ▼
Exact local commit + local bare-remote verification
```

The production plugin does **not** connect the approval button to live repository execution in this slice.

## What already exists

- Private behavioral source: `dweeb11/dpw-mind-net` at commit `a4f915e807e34d4eccb813f0d0dbf19e02820c00`.
- Existing converter behavior in private `scripts/import-post.ts`, `lib/import-post.ts`, `lib/import-post.test.ts`, `lib/import-image.ts`, and `lib/import-image.test.ts`.
- Private real baseline fixture at `~/.gstack/projects/app-475/fixtures/dpw-mind-net-real-baseline/`, including SHA-256 manifest, generated MDX, three generated WebPs, and importer warnings.
- Approved product/architecture design at `~/.gstack/projects/app-475/bot-top-pre-repo-design-20260719-113625.md`.
- Public repository process scaffold, working agreements, verification skill, and MIT license.
- Engineering-review artifacts under `~/.gstack/projects/dweeb11-mdx-relay/` for tests, performance, failure modes, outside voice, and parallelization.

Reuse the behavioral outputs and pure transformation expectations. Do not copy Sharp/native packaging or private fixture content into the public repository.

## Locked technical baseline

- Package manager: npm with committed lockfile.
- Runtime/tooling baseline: Node 22 LTS.
- Plugin build: TypeScript 5.8.3-compatible configuration plus esbuild, following the official Obsidian sample-plugin CJS/ES2021 shape.
- Tests: Vitest with V8 coverage, JSDOM adapter tests, real disposable Git repositories, bundle inspection, and packaged macOS smoke.
- YAML: `yaml` standards library, not hand-written serialization.
- Markdown ranges: `micromark`-derived source positions; edits apply to original source bytes rather than serializing the whole document.
- Portable image spike: browser/worker-compatible jSquash packages (`@jsquash/png`, `@jsquash/jpeg`, `@jsquash/webp`, `@jsquash/resize`) behind `ImageCodec`. The spike must prove deterministic fixture output and worker packaging before adoption. No native `.node` dependency.
- Git: system executable, argument arrays only, curated environment, hooks/signing/fsmonitor/optional locks disabled, transforming attributes rejected, private index/tree plumbing, compare-and-swap ref update.

## Core contracts

### Typed issue result

Every boundary returns `Result<T, MdxRelayIssue[]>`. An issue contains:

- stable code;
- severity (`warning` or `blocker`);
- stage;
- redacted display details;
- allowed recovery actions;
- optional source range or safe path label;
- no credential-bearing URL, note bytes, image bytes, or arbitrary exception dump.

### Limits

- Markdown note: 2 MiB.
- Total sealed output files: 50.
- Source image: 25 MiB.
- Decoded image: 40 megapixels.
- Individual sealed output: 25 MiB.
- Total sealed output: 100 MiB.
- Cumulative decoded work: 400 megapixels.
- Worker wall time: 60 seconds per image, 10 minutes per plan.

### Duplicate embeds

A canonical source image is decoded/transformed once per plan. Its bytes occupy one content-addressed blob. Every source embed still produces its own approved document-order `img-N.webp` action and target path.

### Coherent capture

Immediately before a plan becomes visible, the host re-reads/re-hashes the note, each source image, candidate set, profile snapshot, and repository fingerprint. Any change discards all generated output and returns `STALE_DURING_PLANNING`.

### Preview identity

Every planning run has an immutable generation token. Worker events, persisted plan, modal contents, button state, and approval transition must share that token and exact plan ID. Late events from older generations are discarded.

### Private storage

- Outside vault, repository, Git directory, and known sync roots.
- macOS alpha root under `~/Library/Application Support/MDXRelay/`.
- Directories `0700`; files `0600`.
- Atomic temp write, fsync, rename, parent fsync, reopen/hash verification.
- Successful artifacts retained seven days; unresolved recovery artifacts retained until resolved.
- UI discloses local temporary note/image copies and does not promise secure SSD erasure.
- No custom encryption in the alpha.

### Fixture privacy

Public Git contains only sanitized synthetic fixtures. The real baseline remains external and ignored. `test:private-baseline` receives its path through `MDX_RELAY_PRIVATE_FIXTURE_ROOT`, validates the existing manifest, and never copies source content into build/test reports. Public CI runs the sanitized fixture; alpha release requires both gates locally.

## State diagrams that must exist in code comments

Add concise ASCII diagrams to:

- `src/contracts/export-plan.ts`: capture → transform → seal → verify → approve.
- `src/recovery/journal.ts`: BACKING_UP → PREPARED → WRITING → STAGED → COMMITTING → COMMITTED → PUSHING → terminal states.
- `src/worker/processing-client.ts`: generation token, progress, timeout/cancel termination, late-event discard.

## Implementation Tasks

Synthesized from the approved design and engineering review. Commit after each task.

### T0 (P1, human: ~1 day / CC: ~3–5h) — Bootstrap toolchain and freeze contracts

**Surfaced by:** Scope, architecture, and test reviews: implementation has no package/test/build system and parallel work requires stable contracts.

**Files:**

- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `esbuild.config.mjs`
- Create: `vitest.config.ts`
- Create: `eslint.config.mjs`
- Create: `manifest.json`
- Create: `versions.json`
- Create: `src/contracts/result.ts`
- Create: `src/contracts/issues.ts`
- Create: `src/contracts/export-plan.ts`
- Create: `src/contracts/worker-protocol.ts`
- Create: `src/core/limits.ts`
- Modify: `AGENTS.md`
- Modify: `.claude/skills/verify/SKILL.md`

**Implementation:**

1. Pin exact dependency versions and commit the lockfile.
2. Add `format:check`, `lint`, `typecheck`, `test:unit`, `test:integration`, `test:bundle`, `test:private-baseline`, `build`, and `verify` scripts.
3. Define immutable contract types, stable issue registry, generation token, plan ID, recovery actions, and locked limits.
4. Set `manifest.json` to `id: mdx-relay`, `isDesktopOnly: true`, and approved minimum Obsidian version.
5. Prevent downstream directories from redefining contracts or issue codes.

**Verification:**

```bash
npm ci
npm run typecheck
npm run lint
npm run test:unit
npm run build
```

Expected: every command exits 0; release output contains no native `.node` file.

### T1 (P1, human: ~2–3 days / CC: ~5–8h) — Implement portable profiles and machine-local bindings

**Surfaced by:** Architecture D4: portable publishing rules must not carry machine paths or credentials.

**Files:**

- Create: `src/profiles/profile-schema.ts`
- Create: `src/profiles/portable-profile.ts`
- Create: `src/profiles/machine-binding.ts`
- Create: `src/profiles/resolve-profile.ts`
- Create: `src/profiles/builtins/dpw-mind-net-v1.ts`
- Create: `tests/unit/profiles/profile-schema.test.ts`
- Create: `tests/unit/profiles/resolve-profile.test.ts`

**Implementation:** Validate a versioned declarative schema, reject unknown/executable fields, keep absolute repository bindings local, reject credential-bearing URLs and unsafe paths, and emit a canonical portable snapshot plus machine binding fingerprint.

**Verification:** `npm run test:unit -- tests/unit/profiles`

Expected: valid built-in profile passes; every traversal, executable field, unknown key, invalid placeholder, and credential URL blocks with a stable redacted issue.

### T2 (P1, human: ~4–6 days / CC: ~1 day) — Port the source-preserving Markdown contract

**Surfaced by:** Code-quality D5/D6: hand-written YAML and regex-only protected-code segmentation are unsafe.

**Files:**

- Create: `src/markdown/frontmatter.ts`
- Create: `src/markdown/protected-ranges.ts`
- Create: `src/markdown/transform.ts`
- Create: `src/markdown/validate-mdx.ts`
- Create: `tests/unit/markdown/frontmatter.test.ts`
- Create: `tests/unit/markdown/protected-ranges.test.ts`
- Create: `tests/unit/markdown/transform.test.ts`
- Create: `tests/fixtures/public-baseline/source-note.md`
- Create: sanitized expected MDX and metadata under `tests/fixtures/public-baseline/`

**Implementation:** Port current slug/frontmatter/wikilink/callout/MDX escaping/image JSX behavior. Derive protected source ranges from parser positions and patch the original text. Block unsupported top-level MDX, transclusions, attachments, malformed code ranges, and invalid output compilation.

**Verification:** `npm run test:unit -- tests/unit/markdown`

Expected: all compatibility rows and explicit CLI divergences pass; bytes outside approved edits remain unchanged.

### T3 (P1, human: ~1 week / CC: ~1–2 days) — Prove the portable codec and dedicated worker

**Surfaced by:** Architecture D2 and performance P17/P18/P21/P24/P28.

**Files:**

- Create: `src/images/image-codec.ts`
- Create: `src/images/image-metadata.ts`
- Create: `src/images/portable-webp-codec.ts`
- Create: `src/worker/processing.worker.ts`
- Create: `src/worker/processing-client.ts`
- Create: `tests/unit/images/portable-webp-codec.test.ts`
- Create: `tests/unit/worker/processing-client.test.ts`
- Create: sanitized image vectors under `tests/fixtures/images/`

**Implementation:** First land a spike proving PNG/JPEG/WebP decode, EXIF rotation, no-upscale 2000px resize, WebP quality 85, deterministic output, esbuild WASM packaging, and clean Obsidian worker startup. If jSquash fails any gate, retain `ImageCodec` and write an ADR before choosing another portable implementation. Then implement sequential processing, transferred buffers, intra-plan work deduplication, progress, generation binding, hard termination, and parent-enforced budgets.

**Verification:**

```bash
npm run test:unit -- tests/unit/images tests/unit/worker
npm run test:bundle
```

Expected: repeat runs hash identically; timeout/cancel kills the worker; late events are ignored; bundle includes required worker/WASM assets and no `.node` file.

### T4 (P1, human: ~4–6 days / CC: ~1 day) — Build deterministic planning and owner-only storage

**Surfaced by:** Architecture sealed-plan boundary; performance P19/P23/P25/P27; failure-mode review.

**Files:**

- Create: `src/planning/build-export-plan.ts`
- Create: `src/planning/seal-export-plan.ts`
- Create: `src/planning/plan-store.ts`
- Create: `src/planning/plan-store-types.ts`
- Create: `tests/unit/planning/build-export-plan.test.ts`
- Create: `tests/unit/planning/seal-export-plan.test.ts`
- Create: `tests/integration/planning/plan-store.test.ts`

**Implementation:** Build canonical JCS manifest, ordered actions, target modes/types, content-addressed blobs, commit-message bytes, repository/dependency fingerprints, final capture barrier, atomic publication, expiry, active-plan pinning, owner-only permissions, tamper rejection, and cleanup. Approval stores only the exact plan ID.

**Verification:** `npm run test:integration -- tests/integration/planning`

Expected: deterministic IDs; boundary limits pass/fail exactly; every injected write/fsync/rename/disk-full failure exposes no valid plan; permissions are `0700/0600` on macOS.

### T5 (P1, human: ~2 weeks / CC: ~2–3 days) — Prove the hardened Git transaction in disposable repositories

**Surfaced by:** Architecture Git contract, test D15, performance P20, failure-mode matrix.

**Files:**

- Create: `src/git/git-runner.ts`
- Create: `src/git/git-parsers.ts`
- Create: `src/git/repository-preflight.ts`
- Create: `src/git/private-index.ts`
- Create: `src/git/execute-sealed-plan.ts`
- Create: `src/git/verify-remote.ts`
- Create: `src/recovery/journal.ts`
- Create: `src/recovery/recover-operation.ts`
- Create: `tests/helpers/disposable-git-repository.ts`
- Create: `tests/integration/git/repository-preflight.test.ts`
- Create: `tests/integration/git/execute-sealed-plan.test.ts`
- Create: `tests/integration/git/verify-remote.test.ts`
- Create: `tests/integration/git/recovery.test.ts`

**Implementation:** Implement the approved repository fingerprint and unsupported-form checks; sanitized process adapter; operation lock; durable backup/write journal; private `GIT_INDEX_FILE`; batch object verification; `write-tree`; `commit-tree`; expected-old-OID `update-ref`; explicit push; exact remote classification. Fault-inject every journal/write/index/tree/commit/ref/push boundary. Do not compose this executor into live production approval.

**Verification:** `npm run test:integration -- tests/integration/git`

Expected: exact create/update/no-change proof succeeds against local bare remotes; every dirty, hostile config, race, timeout, crash, mode/type, extra path, partial batch, and ambiguous push case reaches the approved fail-closed/recovery state.

### T6 (P1, human: ~4–6 days / CC: ~1 day) — Build the Obsidian capture and exact preview shell

**Surfaced by:** User-flow tests and P26 preview identity race.

**Files:**

- Create: `src/obsidian/host-adapter.ts`
- Create: `src/obsidian/preview-command.ts`
- Create: `src/obsidian/preview-modal.ts`
- Create: `src/obsidian/preview-state.ts`
- Create: `src/main.ts`
- Create: `tests/helpers/fake-obsidian-host.ts`
- Create: `tests/jsdom/obsidian/preview-command.test.ts`
- Create: `tests/jsdom/obsidian/preview-modal.test.ts`

**Implementation:** Capture active Markdown through one host adapter; show Ready/No Changes/Blocked; display exact file list, MDX diff, asset hashes/sizes, warnings, blockers, profile/repository identity, and local-copy disclosure. Bind all state to generation token + plan ID. Default approval disabled. Approval records once but does not call live executor in this slice.

**Verification:** `npm run test:unit -- tests/jsdom/obsidian`

Expected: every transition, late response, double click, close/reopen, expiry, cancellation, and unload preserves one visible plan identity and starts no production Git mutation.

### T7 (P1, human: ~4–6 days / CC: ~1 day) — Add cross-module, private-baseline, and secret-leak gates

**Surfaced by:** Test review, failure-mode P29, fixture privacy P36.

**Files:**

- Create: `tests/integration/pipeline/create-export-plan.test.ts`
- Create: `tests/integration/security/secret-canary.test.ts`
- Create: `tests/integration/private-baseline/private-baseline.test.ts`
- Create: `scripts/resolve-private-baseline.mjs`
- Modify: `.gitignore`

**Implementation:** Exercise capture → worker → coherent barrier → store → preview using sanitized public data. Add unique credential canaries and scan profiles, plans, journals, logs, worker events, errors, receipts, and snapshots for raw/encoded leakage. Validate the external private fixture manifest and compare generated hashes without copying its source bytes into repository artifacts.

**Verification:**

```bash
npm run test:integration -- tests/integration/pipeline tests/integration/security
MDX_RELAY_PRIVATE_FIXTURE_ROOT="$HOME/.gstack/projects/app-475/fixtures/dpw-mind-net-real-baseline" npm run test:private-baseline
```

Expected: public and private output contracts pass; repository status shows no private fixture files; secret canary scan reports zero leaks.

### T8 (P1, human: ~3–5 days / CC: ~6–10h) — Package and accept the macOS safety slice

**Surfaced by:** Distribution review and packaged-test gate.

**Files:**

- Create: `scripts/inspect-bundle.mjs`
- Create: `tests/bundle/production-bundle.test.ts`
- Create: `docs/testing/macos-packaged-smoke.md`
- Create: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `.claude/skills/verify/SKILL.md`

**Implementation:** Build the production archive; enforce artifact allowlist, worker/WASM presence, no native binaries, version alignment, and clean-vault plugin load. Run the command/modal/unload smoke and disposable Git proof. Document that live publishing remains disabled and link the next milestone in `TODOS.md`.

**Verification:**

```bash
npm ci
npm run verify
MDX_RELAY_PRIVATE_FIXTURE_ROOT="$HOME/.gstack/projects/app-475/fixtures/dpw-mind-net-real-baseline" npm run test:private-baseline
```

Expected evidence:

- Tests: all pass, 0 fail.
- Coverage: 100% statements, branches, functions, and lines for pure core/contracts; approved adapter exclusions documented.
- Build: exit 0.
- Bundle inspection: exit 0; approved files only; worker/WASM present; no `.node`.
- Packaged macOS smoke: every checklist item checked with actual Obsidian version recorded.
- Git: working tree clean except the intended task commit.

## Worktree execution

Wave 0 is sequential. Then run three lanes in parallel: Profiles+Markdown, Codec+Worker, Git+Recovery. Merge and run the full available suite after each lane. Then run Planner+Store and Host+Preview in parallel. Final integration/packaging is sequential. See `~/.gstack/projects/dweeb11-mdx-relay/bot-top-main-eng-review-parallelization-20260719.md`.

## NOT in scope

- Live writes/pushes to user repositories: next milestone after disposable proof.
- Windows 11 and Ubuntu adapters: release-gate TODO after macOS alpha.
- Second production profile: post-alpha portability TODO.
- User-configurable limits: evidence-gated TODO.
- Sealed-blob encryption: pre-Community threat-model TODO.
- Persistent cross-plan conversion cache: rejected as unjustified complexity.
- Parallel image conversion: sequential processing is the V1 safety contract.
- Mobile Obsidian, cloning repositories, credentials, background sync, folder publishing, generic attachments, arbitrary profile code, deletions, pull/rebase/conflict resolution, force push, and hosted/team workflows.

## Failure-mode acceptance

All 26 mapped flows must have a test or explicit packaged-smoke owner, typed error handling, and visible recovery. There are no accepted silent failures. Full matrix: `~/.gstack/projects/dweeb11-mdx-relay/bot-top-main-eng-review-failure-modes-20260719.md`.

## Unresolved decisions

None.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | Product design was approved through `/office-hours` |
| Codex Review | `/codex review` | Independent second opinion | 0 | — | Not run; isolated subagent challenge used instead |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | Scope reduced; 30 accepted decisions; 26 failure flows; 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | Approved rough three-state interaction exists; full UI review deferred |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | Not run |

- **VERDICT:** ENG CLEARED for the first safety slice. Implementation may begin; live repository publishing remains gated.

NO UNRESOLVED DECISIONS
