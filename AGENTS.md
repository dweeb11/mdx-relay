# AGENTS.md

## Orientation

Read before acting:
1. `PITCH.md` — the human's design vision (never modify)
2. `WORKING_AGREEMENT.md` — development process
3. `WORKING_AGREEMENT.apps.md` — app-specific conventions
4. `GIT_CONVENTIONS.md` — branching and commit rules

## Project Overview

MDX Relay is a desktop Obsidian plugin written in TypeScript. It converts approved notes and supported inline images into profile-specific MDX, previews a sealed export plan, then performs narrow verified Git operations. Implementation has not started; do not invent build commands or architecture beyond an approved engineering plan.

## Conventions

- Commit after every task, not at end of session
- Use exact file paths from the spec; do not infer
- Run verification before claiming any task complete
- Never modify `PITCH.md` or `SCRATCH.md`
- Preserve the approved sealed-plan, fail-closed, and narrow-Git boundaries
- Never commit secrets; use `.env.example` when configuration exists
- See `WORKING_AGREEMENT.md` for spec format and testing philosophy

## Build & Test

No package or test runner is configured in the pre-implementation scaffold. The first approved engineering slice must add exact commands here and in `.claude/skills/verify/SKILL.md`.
