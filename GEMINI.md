# GEMINI.md

## Orientation

Read before acting:

1. `PITCH.md` — the human's design vision (never modify)
2. `WORKING_AGREEMENT.md` — development process
3. `WORKING_AGREEMENT.apps.md` — app-specific conventions
4. `GIT_CONVENTIONS.md` — branching and commit rules
5. `AGENTS.md` — current project state and boundaries

## Project Overview

MDX Relay is a desktop Obsidian plugin written in TypeScript. It converts approved notes and supported inline images into profile-specific MDX, previews exact target files, then writes only approved bytes beneath a configured local target folder. It does not automate Git. ADR 0003 supersedes older Git/push requirements.

## Conventions

- Do not implement before an approved engineering plan exists.
- Never modify `PITCH.md` or `SCRATCH.md`.
- Preserve exact reviewed bytes and fail closed on ambiguous state.
- Never delete, broadly synchronize directories, or write outside the approved target set.
- Never invoke Git from the product runtime.
- Run verification before claiming completion.

## Build & Test

Follow `AGENTS.md` for the current package, test, build, and verification commands. Run `npm run verify` before claiming completion.
