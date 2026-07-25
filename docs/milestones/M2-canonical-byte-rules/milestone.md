# M2: Canonical byte rules

> Collapse every implementation of "turn a value into canonical bytes" into one audited module.

## Tasks

- [ ] S1 — extract `src/core/predicates.ts`; unify `isRecord` ×6, `hasExactKeys` ×4, `isNonnegativeInteger` on `Number.isSafeInteger` (APP-628)
- [ ] S2 — `src/canonical/index.ts`: one self-guarding `canonicalizeJcs`, Node-free, at 100% coverage (APP-629)
- [ ] S3 — `src/canonical/hash.ts`: move sha256 helpers out of the planner, add `sha256OfCanonical` (APP-630) — blocked by S2

Umbrella: APP-622. Sequenced before APP-620 (single owner for plan verification), which also needs the `export-plan.ts` split first.

## Notes

Design resolved 2026-07-25 via `/grill-with-docs`. Decisions live in
`docs/adr/0002-one-canonical-module-node-free.md`; vocabulary in `CONTEXT.md`.

Three findings from the audit that shaped the slicing:

1. **The three canonicalizers already agree.** They accept and reject identical
   values — cycles were the only true gap, and `canonicalizeMachineBinding`'s
   hand-written field order is byte-identical to JCS. Consolidation is
   behaviour-preserving, so it can land before APP-620 rather than alongside it.
2. **Nothing persists canonical bytes across versions.** Sealed plans store the
   snapshot text and re-hash *that*; machine-binding digests are recomputed in
   process. There is no compatibility constraint to design around.
3. **The worker bundle is the binding constraint.** Node built-ins are `external`
   in `dist/processing.worker.js`, so a `node:crypto` import reachable from the
   worker survives the build and fails only at runtime. This is why hashing is a
   sibling file rather than part of `canonical/index.ts`, and it is the single
   most important thing to preserve in this milestone.

One deliberate behaviour change: `isNonnegativeInteger` tightens to
`Number.isSafeInteger`, rejecting absurd `byteLength` claims from a tampered
stored plan.

S1 and S2 are independent; S3 is blocked by S2. Multi-issue milestone run —
one branch, one PR, one commit per slice.

## Retro

_Filled at milestone close (`/merged`). The metric lines are the outcome baseline._

- Review rounds: —
- P0/P1 findings: —
- Human interventions: —
- Post-merge fix PRs: —

- Worked: —
- Didn't: —
- Change one thing: —
