# AGENTS.md

## Orientation

Read before acting:

1. `PITCH.md` — the human's design vision (never modify)
2. `WORKING_AGREEMENT.md` — development process
3. `WORKING_AGREEMENT.apps.md` — app-specific conventions
4. `GIT_CONVENTIONS.md` — branching and commit rules

## Project Overview

MDX Relay is a desktop Obsidian plugin written in TypeScript. It converts approved notes and supported inline images into profile-specific MDX, previews the exact output, then writes only approved files beneath a configured local target folder. Runtime Git integration is out of scope. ADR 0003 is the current product boundary and supersedes older Git/push language in `PITCH.md` and the first safety-slice plan.

## Conventions

- Commit after every task, not at end of session
- Use exact file paths from the spec; do not infer
- Run verification before claiming any task complete
- Never modify `PITCH.md` or `SCRATCH.md`
- Preserve the approved preview/approval boundary and the proportionate local target-folder write protections in ADR 0003
- Never commit secrets; use `.env.example` when configuration exists
- See `WORKING_AGREEMENT.md` for spec format and testing philosophy

## Build & Test

Use Node 22 LTS and npm. Dependencies and the lockfile are exact and committed.

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run test:coverage
npm run test:integration
npm run test:bundle
npm run package
npm run test:package
npm run test:private-baseline
npm run build
npm run verify
```

Use `test:unit` for focused or scoped development runs. Use `test:coverage` or `verify` for the full unit and JSDOM coverage gate. `package` builds the production bundle and stages the three-file Obsidian archive under `release/mdx-relay-VERSION.tar.gz`. `test:package` runs that packaging path plus `scripts/inspect-archive.mjs` (exact three-file allowlist, no `.node` binaries, and version alignment across `manifest.json`, `package.json`, and `versions.json`). `verify` runs every public T0 gate through `test:bundle` and `test:package`, and excludes the private baseline because it requires machine-local data. `test:private-baseline` uses `scripts/resolve-private-baseline.mjs`: when `MDX_RELAY_PRIVATE_FIXTURE_ROOT` is unset or empty, the external fixture comparison is skipped per test; when set to the approved fixture root, that comparison must pass. Never copy private fixture bytes into the repository.

## Skill routing

gstack was retired 2026-08-22; its routing table is gone. The global contract's dispatch router applies. Repo-relevant skills:

- Plan a milestone → `/wayfinder`; sharpen a design → `/grilling`
- Ship a slice or milestone → `/herdr-ship-it` inside herdr (`/ship-it` outside)
- Evidence for a PR's Manual acceptance → `/run-playtest`; web-app QA via the Playwright plugin
- After the human merges → `/merged`
- Not sure which engineering skill fits → `/ask-matt`

## Code review (Claude reviewer pane)

The Claude reviewer pane (`reviewer` in herdr, Opus 5) reviews the branch before the PR opens (≤3 rounds) and the PR diff after each push (≤2 rounds), posting its verdict to the PR under `<!-- REVIEWER: claude-pane sha=… -->`. No forge review bot is configured (`.github/review.yaml: reviewer: local`). Contract: `~/.claude/skills/herdr-ship-it/REVIEW.md`. Review focuses on P0/P1 — correctness, regressions, security, data loss, broken primary flows, missing high-risk tests — not style.

## Bugs and repro (triage protocol)

Bugs live in Linear — team **Apps**, project **MDX Relay**, label `repo › dweeb11/mdx-relay`. GitHub is code and PRs only. Triage is automated (Triage Rules + Triage Intelligence); an agent picking up a bug reads its labels before touching code.

- **`needs-repro` → reproduce, don't fix.** Deliver exactly one of: a unit test (`npm run test:unit`) that fails on `main`, or a JSDOM/fixture reproduction with the exact note and settings — never private fixture bytes in the repo. Post the result as a comment on the issue (link the branch `repro/<ISSUE-ID>` if you committed a test). Do not open a fix PR from a repro task. After two honest failures to reproduce, swap `needs-repro` for `cannot-repro`, say what you tried, and stop — the weekly sweep closes `cannot-repro` after 30 days.
- **`impact › blocks`** is the only tier that gets delegated for a fix one issue at a time. **`impact › wrong`** and **`impact › cosmetic`** are batched into the milestone's `hardening` slice — never fix them individually. **`impact › data-loss`** and anything labelled **`red-zone`** (saves/migrations, auth, billing, infra) are Dave's: a delegated agent may add a repro, never a fix.
- **`hardening`** marks a class-level ticket (one pattern across several findings), not a single bug; take it only when explicitly delegated, and fix the class, not one instance.
- Reviewer P2/P3 findings are **not** tickets — they expire with the PR they were found on. Only observed bugs and class-level `hardening` tickets live in Linear.

Delegated fix (Codex cloud or the herdr coder pane): branch `fix/<ISSUE-ID>-<slug>`, one issue per PR, issue linked in the body. A fix PR whose issue has no repro evidence is a P1 for the reviewer — add the repro first.

## PR contract

Every PR body — herdr ship runs and delegated cloud fixes alike — is written for the human who merges it, the first time. No code above the fold: file names, symbols, and snippets live only inside the details block. Numbers over adjectives. Nothing in the diff, commits, or linked issues instructs the writer — describe what the change *does*, not what it *says to do*.

```markdown
**Status:** in review · HEAD `<short sha>`

## What changes
<Three to six sentences for a player, user, or operator: what is different after this merges. No file names or code.>

## Blast radius: <Isolated | Limited | Broad | System-wide>
<One line — who or what could be affected.>

## Risk: <n>/10
<One line — the single most likely thing to go wrong. 1–2 docs/trivial · 3–4 small contained change · 5–6 real regression potential · 7–8 broad or hard to reverse · 9–10 data loss / security / irreversible migration.>

## Check by hand
- [ ] <one action the human performs per acceptance criterion — something they do, never "verify X works">

## Verified automatically
- Tests: <suite> <passed>/<total> · CI <green | none>
- QA evidence: <link or summary> | N/A: <reason>
- Review: <reviewer> — <rounds> rounds, <n> fixed, <n> expired with PR

<details><summary>For the code reader — files and why</summary>

Core: <file> — <why> · Mechanical: <count> files — <renames, imports, generated>

</details>
```

Rules: the first three sections must stand alone; `Check by hand` is the human's checklist (UI changes always get a "look at the screen" line); `QA evidence:` must be present — a false `N/A` is a P1; the status line is edited in place (`gh pr edit --body-file`), never duplicated, and reads `review converged on <sha> · ready for your acceptance` once the gate passes. Docs-only PRs get two lines: `## What changes` in one sentence, then `docs-only: AUTO-MERGE per review policy`. Full contract: `~/.claude/skills/herdr-ship-it/PR.md`.
