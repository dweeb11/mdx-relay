# MDX Relay

Convert approved Obsidian notes into reviewed MDX files in a local target folder.

MDX Relay is a desktop Obsidian plugin for profile-driven Markdown-to-MDX conversion. It converts the active note and supported inline images, shows the exact output plan, and writes only the files the user approved beneath a configured local target folder. Git and deployment remain the user's responsibility.

## Status

**First safety slice in progress. Product boundary corrected by ADR 0003.**

The first engineering plan and implementation issues will be tracked in the [MDX Relay Linear project](https://linear.app/critterhaus/project/mdx-relay-fbd65a52c426). APP-475 is the approved design/root issue.

## V1 shape

- Named local target-folder and output profiles.
- Deterministic MDX and WebP generation.
- Sealed preview with file list and MDX diff.
- Explicit approval before local target writes.
- Exact approved-byte verification.
- Atomic per-file replacement and truthful partial-failure reporting.
- No runtime Git integration.
- Desktop only.

## Safety boundary

MDX Relay writes only approved files under one configured local target root. It does not delete, broadly synchronize directories, invoke Git, or silently regenerate after approval. Ambiguous paths, changed targets, or partial failures block or report the write truthfully.

## Development

Implementation exists for the worker, export planner, Obsidian host shell, settings, preview modal, production bundle gates, and release-archive packaging gates. Read these first:

1. `PITCH.md`
2. `WORKING_AGREEMENT.md`
3. `WORKING_AGREEMENT.apps.md`
4. `GIT_CONVENTIONS.md`
5. `AGENTS.md` or the orientation file for your coding tool

Build, test, package, and verify commands live in `AGENTS.md`. Manual macOS packaged acceptance is documented in `docs/testing/macos-packaged-smoke.md`.

## License

[MIT](LICENSE)
