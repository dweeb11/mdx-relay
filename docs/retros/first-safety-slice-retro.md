# First Safety Slice (T0–T8) Retrospective

**Date:** 2026-08-14
**Milestone span:** 2026-07-19 (plan approved, repo scaffolded) → 2026-08-14 (T8 packaged macOS acceptance)
**Features completed:** T0 toolchain + frozen contracts (APP-560), profiles + machine bindings, source-preserving Markdown contract, T3 portable codec + worker (APP-563), T4 deterministic planning + owner-only storage (APP-564), M2 canonical byte rules (APP-622), target-folder rebaseline (APP-565), approved writer (APP-646), credential parse-time gating (APP-652), T6 preview shell (APP-566), T7 pipeline/canary/private-baseline gates, preview wiring, T8 packaging + archive gates + macOS smoke (APP-568)
**Total commits:** 69 on main (12 feat, 16 fix, 7 refactor, 3 test, 9 docs — including the runtime-scope reset and agent-config docs — 21 chore/deps, 1 CI)

## What went well

- **The planner/executor split held under pressure.** Sealed plans, digest-bound previews, and the recapture-before-write guard were designed up front and survived every review round intact; mutation checks (disable a guard → named tests fail) turned architectural claims into evidence.
- **The mid-slice scope reset was handled cleanly.** ADR 0003 (local target folder, no runtime Git) superseded the original Git/push design halfway through, with the old plan preserved as provenance rather than rewritten. T5–T8 re-targeted without churning T0–T4 work, and the no-Git guarantee became testable (git-shim proof in the packaged smoke).
- **Review pressure found real bugs, not style nits.** The 16 fix commits are dominated by review-surfaced correctness issues (tokenless worker messages, tampered plan IDs, blob-dedupe counting, EXIF walk fill bytes, empty-archive payloads). Cross-model review (codex on Claude/cursor code) plus mutation checks was the highest-yield quality mechanism in the slice.
- **Acceptance was evidence-first end to end.** The T8 packaged smoke recorded byte-level hashes, a sentinel, an empty git-shim log, and a real PNG→WebP WASM conversion in a clean disposable vault — "works on my machine" never appeared. The filled evidence record lives on [PR #77](https://github.com/dweeb11/mdx-relay/pull/77#issuecomment-5300844483); the committed `docs/testing/macos-packaged-smoke.md` is the reusable blank template, by design.
- **The `verify` gate grew with the code.** Bundle inspection, secret canary, and archive inspection were appended to one command that CI and local acceptance both run. The private baseline deliberately stays a separate lane (`test:private-baseline`) because it needs machine-local fixture data — a boundary, not an omission.

## What could improve

- **Fix-to-feature ratio was high (16 fix vs 12 feat PRs).** Most fixes were review findings landing *after* a feature merged conceptually complete. Several (worker-message validation, plan-ID tampering) were foreseeable contract edges — adversarial "how do I forge this input" passes during spec review would have caught them a round earlier.
- **The original plan's Git scope cost real work.** T0–T4 carried Git-oriented requirements (repository fingerprints, disposable repos in tests) that ADR 0003 later deleted. The signal (publishing needs ≠ Git automation) was arguably visible at plan time; the grill/office-hours stage should stress *runtime side-effect scope* explicitly, not just data flow.
- **Async-UI tests are timing-fragile.** The settings target-feedback test flaked during T8 acceptance (APP-676): fixed `flush()` helpers racing a real fs probe under parallel coverage. Pattern risk for every future settings/modal test.
- **Dependabot noise was a third of all commits.** 21 chore bumps, several needing manual grouping fixes (#8, #62). Coupled-group config improved late; earlier grouping would have saved review cycles.
- **Deferred debt is tracked but growing:** APP-660–663 (T6 P2s), APP-675 (archive filename validation), APP-676 (flaky test). None blocking, all should be burned down before the platform-adapter milestone multiplies surfaces.

## Lessons to carry forward

1. **Add an adversarial-input pass to spec review** for any new contract or protocol message: enumerate forgeable/tampered/absent-field cases before implementation, not in review round 2.
2. **In design interrogation, ask "what process side effects does this *runtime* perform?" explicitly.** The Git descope is the template: prefer writing bytes + letting existing user tooling act on them.
3. **Ban fixed-delay flushes in async UI tests.** Await a deterministic signal (exposed promise, `vi.waitFor` on the DOM state) — apply when fixing APP-676 and in all new jsdom tests.
4. **Keep the evidence-record pattern from the T8 smoke doc** (fill-in template, hashes, environment versions) for every future manual acceptance, including the platform-adapter milestone.
5. **Schedule a small debt-burn slice** (APP-660–663, 675, 676) before starting Windows/Ubuntu adapters — cheaper to fix on one platform than three.
