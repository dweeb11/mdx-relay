# CLAUDE.md

## First Session Orientation

Before doing anything, read these files in order:
1. `PITCH.md` — the human's design vision (never modify)
2. `WORKING_AGREEMENT.md` — how we work together
3. `WORKING_AGREEMENT.apps.md` — app-specific conventions
4. `GIT_CONVENTIONS.md` — branching and commit rules
5. `AGENTS.md` — current project state and boundaries
6. This file — project-specific architecture

## Project Overview

MDX Relay is a desktop Obsidian plugin written in TypeScript. It converts approved notes and supported inline images into profile-specific MDX, previews a sealed export plan, then performs narrow verified Git operations.

## Approved Architecture

The approved system is layered:

1. Profile schema and validation.
2. Obsidian dependency discovery.
3. Pure Markdown/image transformation core.
4. Immutable export planner with sealed bytes and repository fingerprint.
5. Review and explicit approval UI.
6. Narrow filesystem/Git executor with journaled recovery.
7. Verified publication receipt.

Do not collapse the planner and executor. The executor must never rediscover or regenerate after approval.

## Build & Test Commands

No package or test runner is configured in the pre-implementation scaffold. The first approved engineering slice must establish exact install, check, test, build, and packaged-plugin smoke commands before implementation expands.

## External Boundaries

- Obsidian desktop APIs and local filesystem.
- System Git through argument arrays, never shell commands.
- Existing Git credential helper may execute; other hooks/program filters are disabled or rejected.
- Remote verification uses the effective push destination.

## Key Conventions

- Pure transformation and planning logic must not perform I/O.
- Plans identify exact output bytes, targets, dependencies, Git state, and commit message.
- Any fingerprint change makes approval stale.
- No broad staging, deletion, force push, pull/rebase, or automatic conflict handling.
- Post-commit ambiguity is a truthful recovery state, not success.

## Documentation

- `PITCH.md` — human-owned product vision
- `SCRATCH.md` — human-owned runtime notes
- `WORKING_AGREEMENT.md` — development process
- `WORKING_AGREEMENT.apps.md` — app-specific conventions
- `GIT_CONVENTIONS.md` — branching and commits
- `docs/` — approved engineering specs and evidence
