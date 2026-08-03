# ADR 0003: Local target-folder output, no Git automation

**Status:** Accepted  
**Date:** 2026-08-01  
**Decision source:** Dave's APP-623 Triage Council ruling and product-scope correction  
**Issues:** APP-475, APP-565, APP-566, APP-567, APP-568, APP-592, APP-623, APP-646, APP-651, APP-652

**Amended:** 2026-08-03 — threat model recorded as a first-class section; stored-plan reseal (APP-651) accepted; output credential gate decided and implemented in the transform core (APP-652)

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
- reject credentials from written output even when they appear in approved source content, enforced at parsed link destinations, image sources, autolinks, and frontmatter values — see the threat model and the output credential guarantee below for the scope this deliberately excludes.

These rules protect the actual irreversible surface without rebuilding a deployment platform around it.

## Threat model

This section is the authority for whether a proposed defense is in scope. A
finding that falls outside it is not a defect, and review that continues past it
is not finding bugs.

**Who owns what.** MDX Relay converts the user's own notes, in the user's own
vault, into the user's own local folder. The Obsidian vault, the owner-only plan
store, and the configured target root are all the user's property on a
single-user desktop. There is no multi-user boundary, no network input, and no
untrusted submitter anywhere in the flow.

**The governing rule: inputs are trusted, output leaves the trust domain.**

Source notes and inline images are trusted input. Ordinary source edits still
invalidate approval when live bytes are revalidated. MDX Relay does not,
however, claim to preserve approval against a hostile local process that can
jointly rewrite both those source bytes and the owner-only stored plan and
approval state. Such a coordinated rewrite can cause bytes the user did not
preview to be written even when the process cannot write the target folder
directly; that bypass is accepted explicitly as local-adversary tampering below,
not treated as equivalent to an ordinary source edit. Written output is
different in kind: the user publishes it, so it leaves the machine and stops
being private.

That asymmetry, not a generic hardening instinct, decides where effort belongs.

**In scope — data safety.** Every guarantee in the "Proportionate safety
boundary" above defends against *defects*, not adversaries: a malformed note
title producing a bad path, a crash mid-write, an approval applied after the
target changed, a partial multi-file write misreported as success. Containment
of a bug is worth its cost even when no attacker exists, and the traversal,
symlink, case-collision, and stale-state checks are justified on exactly that
basis rather than as security controls.

**In scope — what leaves the trust domain.** Because output is published,
credentials reaching a link destination and private source content escaping
through profiles, plans, logs, errors, or snapshots are real harms. The adversary
there is ordinary inattention, not a hostile process. Credential-bearing parsed
link destinations, image sources, autolinks, and frontmatter values must be
blocked in the transform core before output is sealed; approval cannot override
that block. This is a structural guard over those parsed output-bearing fields,
not an exhaustive scan of prose or binary content.

**Out of scope — resisting a local adversary.** MDX Relay does not claim generic
tamper-resistance against hostile local processes. The capabilities required by
each accepted case are stated separately rather than collapsed into one actor:
the filesystem-race case requires access to the configured target path, while
the coordinated stored-plan reseal requires write access to both vault source
bytes and the distinct owner-only plan store. Write access to only one of those
locations is not assumed to imply access to the other and is insufficient for
the reseal described below.

**When this expires.** The vault and plan store are distinct locations: the plan
store is deliberately outside the vault, repository, and known sync roots. The
decision rests on both remaining local, owner-controlled inputs, not on their
being co-located. Revisit this section, and every decision resting on it, if any
of the following becomes true:

- the plan store stops being local owner-only private storage, or becomes
  writable by a principal that cannot also write the vault;
- vault content arrives from a source the user does not control, including
  sync from an untrusted peer or import of third-party notes; or
- MDX Relay gains a non-local input, a second writer, or any multi-user mode.

Until then, a proposed defense that only pays off against a local adversary is
declined by this ADR rather than deferred.

## Concurrency boundary

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

**Output credential rejection.** Credentials reaching a published link are
refused in the pure transform core before bytes are sealed. The gate runs over
micromark-parsed source destinations — link destinations, image sources,
autolinks, and typed frontmatter metadata values — never over undifferentiated
output bytes. Destination text is decoded for character references and
percent-escapes, then checked with the canonical `isCredentialBearingUrl`
predicate; a hit is a transform-time blocker and surfaces as a Blocked preview.
Raw HTML that carries a URL attribute (`href` or `src`) is refused as
unsupported markdown rather than scanned: notes should use Markdown links,
which the destination gate already covers, and blocking on the attribute name
avoids any attribute-value parsing surface. Prose text and image binaries are
deliberately not scanned, because the approval preview shows the exact bytes
and the published-link path is where a credential travels without the user
seeing it. The writer does not re-check credentials: sealed bytes have already
passed this structural gate.

**Not protected against — filesystem races.** A hostile local process that races
individual filesystem syscalls. Because Node's pathname APIs cannot make
ancestor directory creation or check-then-rename descriptor-relative or
conditional, a sufficiently precise local attacker can change what a pathname
names inside the window between a check and the syscall that follows it. Per the
threat model above, the configured target folder is a user-owned local
directory, not an adversarial multi-writer boundary, so this is accepted. A user
who does not trust other processes on their own machine with that directory
should not configure it as a target root.

**Not protected against — coordinated stored-plan reseal.** A sealed plan
records source identity (`sourceImages[].transformedOutputSha256`) and target
identity (`actions[].sealedOutput`) as two halves that no stored field joins:
asset filenames come from the positional template `img-{index}.webp`, so a
target path carries no source identity, and `sourceOccurrence` is a per-source
counter that reads `[1, 1]` for two distinct images embedded once each —
identical under swap. An actor who rewrites the stored plan to exchange two
image outputs, mirrors the change into the approval fingerprint, recomputes the
plan ID, *and* swaps the corresponding live vault images will have approval and
the write proceed against the exchanged mapping.

This is accepted, and no further self-asserted plan field will close it.
`planId` is a plain hash over plan content, so any such binding is restated by
the same reseal. Non-forgeable authority such as a keyed MAC would be a different
contract with key-management requirements; that option was considered and was
not chosen. The out-of-plan check already exists — approval re-verifies live
source bytes — which is precisely why the attack must also swap the live vault
images. An ordinary image edit still fails that check; jointly rewriting the
images and stored approval state bypasses it and can write an exchanged mapping
the user did not preview. That exact approval bypass is the accepted local-
adversary behavior, and its payoff is limited to exchanging two of the user's
own images. Per the threat model above it is declined rather than deferred;
APP-651 carries the regression asserting this documented behavior.

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
