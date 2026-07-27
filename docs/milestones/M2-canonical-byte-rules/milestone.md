# M2: Canonical byte rules

> Collapse every implementation of "turn a value into canonical bytes" into one audited module.

## Tasks

- [x] S1 — extract `src/core/predicates.ts`; unify `isRecord` ×6, `hasExactKeys` ×4, `isNonnegativeInteger` on `Number.isSafeInteger` (APP-628)
- [x] S2 — `src/canonical/index.ts`: one self-guarding `canonicalizeJcs`, Node-free, at 100% coverage (APP-629)
- [x] S3 — `src/canonical/hash.ts`: move sha256 helpers out of the planner, add `sha256OfCanonical` (APP-630) — blocked by S2

Umbrella: APP-622. Sequenced before APP-620 (single owner for plan verification), which also needs the `export-plan.ts` split first.

## Notes

Design resolved 2026-07-25 via `/grill-with-docs`. Decisions live in
`docs/adr/0002-one-canonical-module-node-free.md`; vocabulary in `CONTEXT.md`.

Three findings from the audit that shaped the slicing:

1. **The three canonicalizers already agree.** They accept and reject identical
   values — cycles were the only true gap, and `canonicalizeMachineBinding`'s
   hand-written field order is byte-identical to JCS. Consolidation is
   behaviour-preserving, so it can land before APP-620 rather than alongside it.
2. **Published sealed plans persist canonical bytes across versions.**
   `publishSealedPlan` writes `canonicalizeJcs(envelope.plan)` as the on-disk
   document; load-time verification re-canonicalizes with the current
   canonicalizer and rejects the plan when `planId` no longer matches.
   Cross-version byte-compatibility is therefore required; incompatible
   canonicalizer changes need a separate migration decision. Machine-binding
   digests remain recomputed in process.
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

Closed 2026-07-27 with umbrella APP-622. Full write-up:
`docs/retros/M2-canonical-byte-rules-retro.md`.

- Review rounds: 7 M2-scoped PRs (#25–#30, #34)
- P0/P1 findings: none mid-slice; sealed-plan persistence called out as a
  docs follow-up (APP-631/633), not a production hash mismatch
- Human interventions: design approval via `/grill-with-docs` before S1
- Post-merge fix PRs: #29, #34 (ADR/milestone wording for byte compat)

- Worked: ADR-first cuts; behaviour-preserving extraction; 100% canonical coverage
- Didn't: umbrella auto-closure after last slice; Linear MCP for agents
- Change one thing: enforce Node-free layering in the same PR as the module
