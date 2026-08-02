# ADR 0003: Local target-folder output, no Git automation

**Status:** Accepted  
**Date:** 2026-08-01  
**Decision source:** Dave's APP-623 Triage Council ruling and product-scope correction  
**Issues:** APP-475, APP-565, APP-566, APP-567, APP-568, APP-592, APP-623

## Context

MDX Relay began as a portable version of Dave's existing Markdown-to-MDX script: read one approved Obsidian Markdown source plus its inline images, convert them, preview the result, and write the approved output to a chosen local folder.

The first engineering plan expanded that intent into a deployment system. It added repository fingerprints, branch and remote state, private Git indexes, commit construction, push classification, remote-tip verification, and Git-specific crash recovery. Those controls are coherent for an automated publisher, but MDX Relay does not need to own source control or deployment.

## Decision

MDX Relay is a local file-conversion tool.

Its product flow is:

```text
approved Obsidian Markdown + inline images
                    ↓
deterministic MDX and transformed image bytes
                    ↓
exact preview of target paths and content
                    ↓
explicit approval
                    ↓
write only the approved files beneath one configured local target folder
```

MDX Relay does not invoke or manage Git. It does not stage, commit, create or validate branches, inspect or update refs, classify remotes, push, verify remote tips, or use Git as its recovery mechanism.

The user's normal Git and deployment tools remain responsible for everything after the files are written.

## Proportionate safety boundary

The plugin still must:

- keep every output beneath the configured target root;
- reject traversal, symlinks, unsupported target types, and ambiguous case collisions;
- show exact target paths and output bytes before approval;
- invalidate approval when source dependencies or approved target files change;
- write only sealed approved bytes and never delete or broadly synchronize a directory;
- use same-directory temporary files and atomic replacement for each output;
- preserve unrelated files and report partial multi-file failure truthfully;
- prevent private source content from leaking through profiles, plans, logs, errors, snapshots, or any destination outside the sealed approved outputs; and
- reject credentials from written output even when they appear in approved source content.

These rules protect the actual irreversible surface without rebuilding a deployment platform around it.

## Consequences

- T5 becomes a disposable target-folder writer proof.
- T6 previews and approves local target-folder writes rather than repository transactions.
- T7 tests the complete conversion-to-write pipeline and its privacy boundary.
- T8 packages and smoke-tests local writes on macOS without requiring Git.
- APP-592 is canceled because branch refs are no longer product input.
- Git-specific profile fields, repository fingerprints, executor contracts, tests, and documentation are legacy scaffolding. T5 owns their bounded removal or replacement with a small target-folder snapshot.
- Git remains the development workflow for this repository. That is separate from MDX Relay's runtime behavior.

## Superseded material

This decision supersedes Git staging, commit, push, remote-verification, repository-fingerprint, and Git-recovery requirements in `PITCH.md`, `docs/plans/2026-07-19-mdx-relay-first-safety-slice.md`, and older issue descriptions.

`PITCH.md` remains human-owned and is not modified by agents. Where it conflicts with this accepted ADR and current Linear issues, this ADR is the current implementation authority.
