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

MDX Relay is a desktop Obsidian plugin written in TypeScript. It converts approved notes and supported inline images into profile-specific MDX, previews exact target files, then writes only approved bytes beneath a configured local target folder. It does not automate Git. ADR 0003 supersedes older Git/push requirements.

## Approved Architecture

The approved system is layered:

1. Profile schema and validation.
2. Obsidian dependency discovery.
3. Pure Markdown/image transformation core.
4. Immutable export planner with sealed bytes and a bounded target-folder snapshot.
5. Review and explicit approval UI.
6. Narrow local target-folder writer with truthful partial-failure reporting.
7. Exact local write result.

Do not collapse the planner and executor. The executor must never rediscover or regenerate after approval.

## Build & Test Commands

Follow `AGENTS.md` for the current package, test, build, and verification commands. Run `npm run verify` before claiming completion.

## External Boundaries

- Obsidian desktop APIs and the local filesystem.
- A configured local target root. Runtime Git executables, credentials, branches, remotes, commits, and pushes are forbidden.

## Key Conventions

- Pure transformation and planning logic must not perform I/O.
- Plans identify exact output bytes, targets, dependencies, and the bounded target state needed to detect stale approval.
- Any fingerprint change makes approval stale.
- No deletion, broad directory synchronization, or writes outside the approved target set.
- Partial multi-file writes are reported truthfully, never called success.

## Agent skills

### Issue tracker

Issues are tracked in **Linear** (the canonical tracker for this repo and all projects). GitHub holds code and PRs only; external PRs are **not** a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical five-role vocabulary, used as-is (`needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) as Linear labels. 'needs-triage' is not a label but a workflow state. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

The routing table lives in `AGENTS.md` under "Skill routing" — single source, not duplicated here.

Repo-specific override: skills that default to filing GitHub issues (`/spec`) must file to **Linear** instead, per the issue-tracker rule above.

## Documentation

- `PITCH.md` — human-owned product vision
- `SCRATCH.md` — human-owned runtime notes
- `WORKING_AGREEMENT.md` — development process
- `WORKING_AGREEMENT.apps.md` — app-specific conventions
- `GIT_CONVENTIONS.md` — branching and commits
- `docs/` — approved engineering specs and evidence
