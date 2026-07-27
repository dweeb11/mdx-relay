# Milestone M2 Retrospective

**Date:** 2026-07-27
**Features completed:** One audited `src/canonical/` module (Node-free `canonicalizeJcs` + Unicode / plain-data / equality helpers), sibling `canonical/hash.ts`, shared `src/core/predicates.ts`, RFC 8785 offline vectors, sealed-plan cross-version byte-compat docs
**Total commits:** 7 M2-scoped merges on main (PRs #25–#30, #34), plus this closeout

## What went well

- **Design before code paid off.** ADR 0002 settled the three hard cuts up front — self-guarding JCS vs a separate boolean plain-data gate, hashing as a sibling file, predicates in `core/` — so S1/S2/S3 were mechanical extractionsations rather than design fights mid-PR.
- **Audit before consolidate.** Confirming the three pre-existing canonicalizers already agreed (cycles aside) made consolidation behaviour-preserving and unblocked landing M2 before APP-620.
- **Worker-bundle constraint as a hard edge.** Treating `node:crypto` reachability into `processing.worker.js` as a build-time architectural rule prevented a latent runtime failure and forced the clean `hash.ts → index.ts` dependency direction.
- **Coverage bar moved with the code.** Putting `src/canonical/**` on the 100% threshold closed the gap where `canonicalizeJcs` had lived under unenforced `planning/`.
- **Cross-version sealed-plan persistence caught early.** Follow-on docs (APP-631/633) made the durable-byte requirement explicit before anyone “improved” JCS output and invalidated stored plans.

## What could improve

- **Umbrella vs slice ownership.** APP-622 stayed In Progress after S1–S3 merged because child PRs closed only their own IDs. The umbrella needed an explicit closeout owner once the milestone checklist hit all `[x]`.
- **Linear tooling for agents.** Cloud agents had no Linear MCP in-session, so Done transitions depended on PR `Closes` text and human follow-up. That slowed umbrella closure more than code work.
- **Node-free rule was comment-only at first.** ADR 0002 documented the constraint, but until closeout only a manual worker-bundle check enforced it — easy to regress on a drive-by import.

## Lessons to carry forward

- For multi-issue milestones: name the umbrella closeout slice (or auto-open it when the last slice merges) so Done does not depend on someone noticing an empty checklist.
- Persist any “must not import X” layering rule as a unit test in the same PR that introduces the module — comments and ADRs alone are not gates.
- When byte identity is durable across versions, write the compatibility requirement into the ADR *before* the first extraction lands, not as a follow-up correction.
- Keep hashing / I/O out of any module the worker can reach; prove the one-directional edge in tests (`hash → index`, never reverse).
