# ADR 0002: One canonicalization module, kept Node-free

**Status:** Accepted
**Date:** 2026-07-25
**Issue:** APP-622 (M2 — canonical byte rules)
**Supersedes:** nothing. Does not touch ADR-0001.

## Context

"How does this project turn a value into canonical bytes" had three answers: the
strict self-guarding `canonicalizeJcs` in `seal-export-plan.ts`, the pre-gated
`canonicalizeValidated`/`canonicalizeProfileData` pair in `portable-profile.ts`,
and a hand-written fixed-field string in `machine-binding.ts`. The
well-formed-Unicode rule was re-coded four times and the structural predicates
five. In a system whose entire safety model is byte-exact hashing, a divergence
between those implementations would be invisible until a hash mismatched in
production.

Auditing them first established that all three accept and reject the same
values — the only true gap was cycle detection — and that nothing persists
canonical bytes across versions, because sealed plans store the snapshot text
and re-hash *that* rather than re-canonicalizing the original value. So
consolidation was a behaviour-preserving move, not a risky rewrite.

## Decisions

### 1. One self-guarding canonicalizer, with the plain-data gate kept separate

`canonical/` exports a single `canonicalizeJcs` that throws on anything that is
not a plain data property graph, extended with an explicit cycle check so a
cyclic value produces a real `TypeError` instead of relying on a stack-overflow
`RangeError` being swallowed by a `catch`. `canonicalizeValidated`,
`canonicalizeProfileData`, and `canonicalizeMachineBinding` are deleted.

`isPlainDataPropertyGraph` survives as a *separate exported predicate* rather
than being folded into the canonicalizer. It returns a boolean and does not
throw, because profile validation needs it before the credential-URL and
unsafe-path walks — that ordering guarantees those later walks only ever see a
graph already proven plain, and it is what maps to the `invalidProfile` issue
code. The profile path therefore still walks twice, deliberately: the two walks
answer different questions.

### 2. Hashing lives in a sibling file, not in `canonical/index.ts`

This is the decision most likely to look arbitrary later, so: **`src/canonical/`
must not import any Node built-in.**

`esbuild.config.mjs` produces two bundles and marks every Node built-in
`external` in both, including `dist/processing.worker.js`. The worker already
reaches `parse-portable-profile.ts`, which will import the shared Unicode gate
and predicates. If the sha256 helpers lived in the same module, the worker
bundle would emit a `require("node:crypto")` that survives the build and the
`probe-node-builtins` check and fails only at runtime inside a real Web Worker.

So `canonical/index.ts` holds the canonicalizer, the Unicode gate, `deepEquals`,
and the plain-data gate with zero Node imports, and `canonical/hash.ts` holds
`sha256OfBytes`/`sha256OfUtf8`/`sha256OfCanonical` with the `node:crypto`
import. The dependency runs `hash.ts → index.ts` and never the reverse.

The worker keeps its own async Web Crypto hashing in `webcrypto-hash.ts`.
Unifying on Web Crypto was considered and rejected: `crypto.subtle.digest` is
async, and making it the single implementation would turn `computePlanId`,
`hasVerifiedBlobs`, and `verifiedEnvelope` async — a blast radius far beyond
this change.

### 3. Shared predicates go to `src/core/`, not `canonical/`

`isRecord`, `hasExactKeys`, `isNonemptyString`, and `isNonnegativeInteger` are
generic type guards, not byte rules; putting them in `canonical/` would rebuild
the grab-bag problem this work exists to remove. They land in
`src/core/predicates.ts`, below both `contracts/` and `canonical/`.

`src/contracts/` was previously a true zero-import leaf. It now takes exactly
one inbound edge, to `core/` — chosen over an edge to a sibling like
`canonical/` precisely to keep the layering direction honest.

### 4. `isNonnegativeInteger` unifies on `Number.isSafeInteger`

The two copies genuinely diverged: `contracts/export-plan.ts` used
`Number.isInteger`, `worker/processing-client.ts` used `Number.isSafeInteger`.
Five other sites in the codebase already use `isSafeInteger`, so the contracts
copy was the outlier. Unifying tightens `contracts/export-plan.ts`: a plan
claiming `byteLength = 2**60` is now rejected. That value is unreachable through
live capture — `MDX_RELAY_LIMITS` caps it orders of magnitude lower — but it is
reachable through a tampered stored plan, which is exactly the adversary
`verifyStoredExportPlan` exists for. The tightening is therefore a small
correctness win and is accepted rather than avoided.

### 5. `canonical/` carries the strictest coverage bar in the repo

`src/planning/**` is not in the coverage gate's `include` list, so
`canonicalizeJcs` had no enforced threshold. Moving it into a new directory
would have silently preserved that gap. `src/canonical/**` is added to `include`
with a 100% statements/lines/branches/functions threshold, matching the
`src/profiles/**` tier it inherits code from. RFC 8785 conformance is proven
against the official cyberphone/json-canonicalization vectors, vendored into
`tests/fixtures/jcs/` so the suite stays offline and reproducible.

Fixture provenance: the `input/`, `output/`, and `outhex/` files are the
official testdata from
https://github.com/cyberphone/json-canonicalization (snapshot 2026-07-26). See
`tests/fixtures/jcs/PROVENANCE.md`. The 100-million-line ES6 number corpus is
not vendored; Node's `JSON.stringify` is the ES6 number serializer JCS defers
to.

## Consequences

- `build-export-plan.ts` stops being a utility grab-bag; `sha256OfBytes`,
  `sha256OfUtf8`, `deepEquals`, and `isWellFormedUnicode` are no longer exported
  from the planner.
- Future hashed artifacts — receipts and journals, layers 6 and 7, still
  unbuilt — get canonical bytes and the audited refusal rules for free.
- APP-620 (single owner for plan verification) lands on top of this and of the
  `export-plan.ts` split; both are its raw material.
- The Node-free rule for `canonical/index.ts` is not currently enforced by a
  test. Anyone adding an import there must check the worker bundle by hand.
