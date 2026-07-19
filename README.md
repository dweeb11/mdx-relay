# MDX Relay

Review and publish Obsidian notes as repository-ready MDX.

MDX Relay is a desktop Obsidian plugin for profile-driven Markdown-to-MDX publishing. It converts the active note and supported inline images, shows the exact export plan, and only touches Git after explicit approval.

## Status

**Approved design, pre-implementation scaffold.**

The first engineering plan and implementation issues will be tracked in the [MDX Relay Linear project](https://linear.app/critterhaus/project/obsidian-publishing-plugin-fbd65a52c426). APP-475 is the approved design/root issue.

## V1 shape

- Named repository and output profiles.
- Deterministic MDX and WebP generation.
- Sealed preview with file list and MDX diff.
- Explicit approval before repository writes.
- Exact staged-byte verification.
- Crash-safe journal and recovery states.
- Narrow commit/push with remote-tip verification.
- Desktop only.

## Safety boundary

MDX Relay does not broadly stage, delete, force push, pull, rebase, resolve conflicts, or silently regenerate after approval. Ambiguous state blocks publication and explains why.

## Development

Implementation has not started. Read these first:

1. `PITCH.md`
2. `WORKING_AGREEMENT.md`
3. `WORKING_AGREEMENT.apps.md`
4. `GIT_CONVENTIONS.md`
5. `AGENTS.md` or the orientation file for your coding tool

Build and test commands will be added by the first approved engineering slice.

## License

[MIT](LICENSE)
