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
- use same-directory temporary files and atomic file-level landing for each output — a conditional hard link plus owned-temporary cleanup for a create, a `rename` for an update;
- preserve unrelated files and report partial multi-file failure truthfully;
- prevent private source content from leaking through profiles, plans, logs, errors, snapshots, or any destination outside the sealed approved outputs; and
- reject credentials from written output even when they appear in approved source content.

These rules protect the actual irreversible surface without rebuilding a deployment platform around it.

## Threat and concurrency boundary

MDX Relay is a Node-only desktop plugin. Node's filesystem API is addressed by
pathname: it exposes no `openat`, `mkdirat`, `renameat`, or conditional rename,
and the alternatives that would supply them — a native addon, a helper
subprocess, `process.chdir`, or any other global-process-state trick — are
rejected as disproportionate for a local conversion tool. That constraint sets
the boundary below.

**Protected against:**

- path traversal out of the configured target root;
- symlinked roots, symlinked ancestors, and symlinked targets;
- unsupported target types and ambiguous case collisions in any segment;
- stale approval state observed during the final revalidation immediately before
  each replacement;
- accidental concurrent changes to an approved target between planning and
  writing; and
- mutation of any file that is not an approved target.

**Known gap — output credential rejection is not yet implemented.** The
requirement above to reject credentials from written output still stands, but
the writer does not currently enforce it: a credential reaching the output from
approved source content is written. The first implementation was an ad hoc
scanner over sealed bytes, and nine review rounds found nine distinct bypasses
in it. The cause is structural rather than incidental — a delimiter-splitting
scanner and the canonical `isCredentialBearingUrl` rule cannot be made to agree
on where a URL begins and ends across arbitrary Markdown, MDX, and HTML
wrappers, because the canonical rule's scheme-less path class admits the very
characters the scanner treats as boundaries. Closing it needs a decision
recorded here first: adopt syntax-aware Markdown/MDX tokenization for credential
scanning, or narrow the canonical output-credential contract and state the
accepted false-positive boundary. Until then the profile-level credential gate
is the only one in force, and it does not cover note content.

**Not protected against:** a hostile local process that races individual
filesystem syscalls. Because Node's pathname APIs cannot make ancestor directory
creation or check-then-rename descriptor-relative or conditional, a sufficiently
precise local attacker can change what a pathname names inside the window
between a check and the syscall that follows it. The configured target folder is
a user-owned local directory, not an adversarial multi-writer boundary, so this
is accepted and outside V1's threat model. A user who does not trust other
processes on their own machine with that directory should not configure it as a
target root.

**What the writer therefore guarantees:**

- Landing stays atomic at the file level. Each approved output is written to a
  same-directory temporary file, synced, and closed, and only then made visible
  at its target, so a reader or a crash sees either the whole prior file or the
  whole approved file — never a partial or truncated one. The two landing shapes
  differ:
  - An approved **create** lands conditionally: a same-directory hard link
    publishes the staged bytes at the target only if nothing occupies it, so a
    target that appeared during staging is refused rather than overwritten. The
    invocation-owned temporary is then removed, and the create is complete only
    once that removal succeeds.
  - An approved **update** lands atomically: a same-directory `rename` replaces
    the target in one step, which also consumes the temporary.
- A create whose owned-temporary cleanup fails is reported as a failed action,
  never as success, because an unapproved pathname still holds the sealed bytes.
  No rollback is claimed: the approved target may already hold its correct
  approved bytes, the leftover temporary stays visible, and the remaining
  actions are reported unattempted. Cleanup only ever unlinks a path that is
  still the exact entry this invocation created.
- The live prior state and the parent directory are rechecked immediately before
  that link or rename, so an approval that went stale while the bytes were
  staged fails closed instead of overwriting.
- Missing parent directories are created one level at a time. Each level is
  created only into a parent whose identity and real path were just verified,
  those checks are repeated after the `mkdir`, and a level that resolves outside
  its verified parent is removed again — `rmdir`, so only an empty directory the
  writer itself created — and the invocation fails closed before any deeper
  level, temporary file, or sealed byte follows it. This bounds the blast radius
  of an escape to one empty directory and makes it detectable; it does not make
  the creation atomic.

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
