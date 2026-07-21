# AGENTS.md

## Orientation

Read before acting:
1. `PITCH.md` — the human's design vision (never modify)
2. `WORKING_AGREEMENT.md` — development process
3. `WORKING_AGREEMENT.apps.md` — app-specific conventions
4. `GIT_CONVENTIONS.md` — branching and commit rules

## Project Overview

MDX Relay is a desktop Obsidian plugin written in TypeScript. It converts approved notes and supported inline images into profile-specific MDX, previews a sealed export plan, then performs narrow verified Git operations. Preserve the approved engineering plan and frozen contracts while implementation proceeds task by task.

## Conventions

- Commit after every task, not at end of session
- Use exact file paths from the spec; do not infer
- Run verification before claiming any task complete
- Never modify `PITCH.md` or `SCRATCH.md`
- Preserve the approved sealed-plan, fail-closed, and narrow-Git boundaries
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
npm run test:private-baseline
npm run build
npm run verify
```

Use `test:unit` for focused or scoped development runs. Use `test:coverage` or `verify` for the full unit and JSDOM coverage gate. `test:private-baseline` currently reports Vitest's explicit no-tests-yet result; T7 adds the external fixture resolver and tests. Set `MDX_RELAY_PRIVATE_FIXTURE_ROOT` only when those tests exist. `verify` runs every public T0 gate and excludes the private baseline because it requires machine-local data.

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
