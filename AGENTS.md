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

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:

- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
