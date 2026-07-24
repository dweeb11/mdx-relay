# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring
the codebase. This repo is **single-context**.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, if it exists — the project's glossary / ubiquitous
  language.
- **`docs/adr/`** — read the ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't
suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs`
and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually
get resolved.

## File structure (single-context)

```
/
├── CONTEXT.md              ← created lazily by /domain-modeling; may not exist yet
├── docs/adr/
│   └── 0001-portable-image-codec-and-worker.md
└── src/
```

If this repo ever grows into multiple bounded contexts, switch to a multi-context layout by
adding a `CONTEXT-MAP.md` at the root pointing at per-context `CONTEXT.md` files, and
update the "Domain docs" line in `CLAUDE.md` to say multi-context.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a
hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms
the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're
inventing language the project doesn't use (reconsider) or there's a real gap (note it for
`/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently
overriding:

> _Contradicts ADR-0001 (portable image codec and worker) — but worth reopening because…_
