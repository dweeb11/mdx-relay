# GEMINI.md

## Orientation

Read before acting:
1. `PITCH.md` — the human's design vision (never modify)
2. `WORKING_AGREEMENT.md` — development process
3. `WORKING_AGREEMENT.apps.md` — app-specific conventions
4. `GIT_CONVENTIONS.md` — branching and commit rules
5. `AGENTS.md` — current project state and boundaries

## Project Overview

MDX Relay is a desktop Obsidian plugin written in TypeScript. It converts approved notes and supported inline images into profile-specific MDX, previews a sealed export plan, then performs narrow verified Git operations.

## Conventions

- Do not implement before an approved engineering plan exists.
- Never modify `PITCH.md` or `SCRATCH.md`.
- Preserve exact reviewed bytes and fail closed on ambiguous state.
- Never broaden staging, delete targets, force push, pull, or rebase.
- Run verification before claiming completion.

## Build & Test

No package or test runner is configured yet. The first engineering slice must add and verify exact commands.
