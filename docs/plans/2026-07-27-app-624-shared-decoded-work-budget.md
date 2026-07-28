# APP-624 Shared Decoded-Work Budget Engineering Plan

**Date:** 2026-07-27

**Branch:** `refactor/app-624-shared-decoded-work-budget`

**Root issue:** APP-624

**Status:** Implemented and verified. See "Outcome" at the end for divergences from plan.

**Scope mode:** Cumulative-only. Does not alter ADR-0001.

## Goal

Give the cumulative decoded-work budget one owner, one audited implementation, and one
exhaustive test suite, without weakening the double enforcement ADR-0001 §7-8 requires.

The trust model does not change. It moves from "never trust the worker" to "both sides run
the same audited function on their own independently-held inputs." The parent still
recomputes from its own request hashes and still fails closed on disagreement.

## Locked decisions

These were settled before this plan was written. Do not re-litigate during implementation.

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Cumulative-only scope.** The helper owns dedupe by `contentSha256`, the running sum of `w * h` per unique source, the `> cumulativeDecodedPixels` comparison, and the repeat-coherence rule. | Folding in the 40 MP per-image ceiling would change the client's failure channel from redacted `MALFORMED_WORKER_RESPONSE` to `DECODED_IMAGE_TOO_LARGE`, violating ADR-0001 §9 redaction and the issue's own "does NOT alter ADR-0001" constraint. |
| D2 | **Batch function, worker calls it on a growing prefix.** | One signature, one call shape, one test suite. Arithmetic cannot drift by construction. |
| D3 | **Worker keeps its early skip** via the existing `bySource` output cache (`process-plan.ts:143-149`). | Minimal change. Consequence stated honestly below. |
| D4 | **Helper is generic over the key type.** | `src/core/` is a true zero-import leaf; importing `Sha256Digest` from `contracts/` would invert the ADR-0002 §3 layering edge. |

## Verified current state

Verified 2026-07-27 against `main` at `e612a6b`.

### The three loops

| | Worker `process-plan.ts:143-192` | Client `processing-client.ts:630-652` |
|---|---|---|
| Input | `readImageHeader` dims, **before** decode | reported `decodedWidth`/`decodedHeight`, **after** completion |
| Dedupe key | `image.contentSha256` (parent-owned) | `request.images[index].contentSha256` (parent-owned) |
| Cumulative test | `decodedPixels + width * height > CAP` → refuse before decode | `decodedPixels += ...; if (decodedPixels > CAP) return true` |
| Repeat coherence | structurally impossible (cached output reused) | exact-edge compare; mismatch → `undefined` → `MALFORMED` |
| Failure channel | `DECODED_WORK_LIMIT_EXCEEDED` | `decoded-work-exceeded`, or redacted `MALFORMED_WORKER_RESPONSE` |

The cumulative arithmetic is already equivalent. The two formulations differ; the outcomes
do not. This refactor is behavior-preserving, matching the ADR-0002 precedent where
consolidation was proven safe by audit before it was performed.

### Per-image ceilings (out of scope, stated so nobody "fixes" them)

- Worker: `w > 40M || h > 40M || w * h > 40M` (`process-plan.ts:165-169`). The edge bound
  uses the **area** constant deliberately, so a header declaring `0xFFFFFFFF` edges cannot
  overflow the product. ADR-0001 §8 names this.
- Client: `isPositiveInteger` guards plus `dw * dh > 40M`, plus `maxDimension` and
  no-upscale bounds (`processing-client.ts:585-598`). No edge bound against the area
  constant, because `isPositiveInteger` already rejects non-safe-integers.

These stay divergent. They answer different questions about differently-trusted inputs.

### Known-remaining duplication (out of scope)

The issue's file list is incomplete. Two further sites touch the same constants:

| File | Use |
|------|-----|
| `src/images/portable-webp-codec.ts:121` | `decoded.width * decoded.height > decodedImagePixels` |
| `src/profiles/parse-portable-profile.ts:194` | `maxDimension > sqrt(decodedImagePixels)` as an edge bound |

Five enforcement points, not three. Neither is cumulative-budget logic, so neither is
touched here. Recorded so the next reader does not think this plan missed them.

### Correcting the issue's benefit claim

APP-624 says "~86 combined client/worker tests re-prove overlapping halves of the same
math." Measured: the budget-specific regions are ~12 tests each side (~24 total), inside
files of 31 (`process-plan.test.ts`) and 109 (`processing-client.test.ts`). The duplication
is real; the 86 figure counts the whole worker-boundary surface, most of which is not
budget math.

(First draft of this plan said 21 and 142. Those came from `grep -c "it("`, which counts
lines rather than tests and misses `it.each` expansion. Corrected against real run output.)

### The benefit the issue did not claim

`vitest.config.ts:52-58` includes `src/contracts`, `src/core`, `src/canonical`,
`src/markdown`, and `src/profiles` in the coverage gate. **`src/worker/**` is absent.** The
cumulative budget math therefore has no enforced coverage threshold today. Moving it into
`src/core/` puts it under the global 99% statements / 99% lines / 95% branches / 100%
functions gate (`vitest.config.ts:60-64`) for the first time.

## Canonical budget contract

This section is the artifact the Hermes calibrated decision required. It is the single
normative statement of the rule.

**MUST:** The cumulative decoded-work budget for one plan is the sum of `width * height`
over each **unique** canonical source, keyed by the **parent-owned** `contentSha256` from
the request. A plan is refused when that sum exceeds
`MDX_RELAY_LIMITS.cumulativeDecodedPixels`.

**MUST:** Repeat embeds of one canonical source cost nothing. They are charged once.

**MUST:** Two entries sharing a `contentSha256` must report **identical exact edges**. `2x6`
and `3x4` are the same twelve pixels but cannot be the same decode. A disagreement is
incoherent, not a budget overrun, and is reported on a distinct channel.

**MUST:** The comparison is strictly-greater-than against the running total after the
current source is added. A plan totalling exactly `cumulativeDecodedPixels` is allowed.

**MUST (caller precondition):** Every `width * height` passed to the helper is already
bounded by `MDX_RELAY_LIMITS.decodedImagePixels` by the caller. This is what keeps the
running sum inside safe-integer range, and it is now load-bearing rather than incidental.
Both call sites already order it correctly:

| Side | Per-image bound at | Cumulative charge at |
|------|--------------------|----------------------|
| Worker | `process-plan.ts:165` | `process-plan.ts:179` |
| Client | `decodeImage`, called `processing-client.ts:691` | `processing-client.ts:707` |

**MUST:** The worker charges from a bounded container-header probe taken **before** the
decode that would spend the budget, per ADR-0001 §8. A cap enforced after the work is a
reporting threshold, not a cap. Prefix-charging preserves this.

**MUST:** The parent recomputes independently from its own request hashes and never takes
the worker's accounting on trust, per ADR-0001 §7. Both sides calling the same audited
function does not weaken this: they call it on independently-held inputs.

**MUST NOT:** The helper does not own the per-image `decodedImagePixels` ceiling, and does
not know about issue codes, wire events, or redaction. It returns data; callers own
channels.

### Consequence of D3, stated plainly

Because the worker skips repeats at `process-plan.ts:143` *before* probing a header, the
list it passes the helper holds exactly one entry per unique source. The worker therefore
**never reaches the helper's `incoherent` branch**, and its `duplicate` path is never
exercised. The genuinely shared logic between the two sides is the running sum and the
comparison. The dedupe and coherence rules are shared code exercised by one caller.

This is honest and acceptable at this scope. The alternative (worker probes every embed,
gaining a hash-vs-header disagreement check it cannot make today, at one extra bounded
header read per repeat) is a real behavior change and is filed separately as APP-643.

## Proposed change

### Module placement

`src/core/decoded-work-budget.ts`.

`src/core/` currently imports nothing (verified: zero import statements in the directory).
`src/contracts/export-plan.ts:6` imports **from** `core/predicates`, so `core/` sits below
`contracts/` per ADR-0002 §3. The helper needs `MDX_RELAY_LIMITS` from `./limits`, which is
already in `core/`, and needs a Map key type.

Importing `Sha256Digest` from `contracts/export-plan` would create `contracts → core →
contracts`. **D4 resolves this with a type parameter.** The helper uses the key only for Map
identity, so it does not need the brand. Callers pass `Sha256Digest` and keep full
type safety at the call site; `core/` stays a leaf.

This also satisfies the ADR-0002 §2 Node-free rule automatically: the module imports one
sibling and nothing else, so the worker bundle cannot pick up a `node:` builtin through it.

### Task 1: Add the shared helper

**Files:**
- Create: `src/core/decoded-work-budget.ts`

**Implementation:**

```ts
import { MDX_RELAY_LIMITS } from "./limits";

/**
 * One canonical source's contribution to a plan's decoded-work budget.
 *
 * `contentSha256` is the *parent-owned* content hash of the source bytes, never
 * a worker-reported output hash. It is generic so this module stays a
 * zero-import leaf: `Sha256Digest` lives in `contracts/`, which imports from
 * `core/`, and taking the reverse edge would make the layering cyclic.
 *
 * `width`/`height` are the raw decoded source dimensions, before EXIF
 * orientation and resize -- the decode cost actually paid (ADR-0001 section 7).
 */
export interface DecodedWorkSource<K> {
  readonly contentSha256: K;
  readonly width: number;
  readonly height: number;
}

export type DecodedWorkCharge =
  | { readonly ok: true; readonly total: number }
  | { readonly ok: false; readonly reason: "exceeded" | "incoherent" };

/**
 * The single owner of the cumulative decoded-work rule.
 *
 * Charges each unique canonical source exactly once, keyed by the caller's own
 * content hashes, and refuses a plan whose total exceeds
 * `MDX_RELAY_LIMITS.cumulativeDecodedPixels`. Repeat embeds cost nothing but
 * must agree on their exact decoded edges: 2x6 and 3x4 are the same twelve
 * pixels but cannot be the same decode, so a disagreement is `incoherent`
 * rather than a budget overrun.
 *
 * CALLER PRECONDITION: every `width * height` is already bounded by
 * `MDX_RELAY_LIMITS.decodedImagePixels`. That bound is what keeps this running
 * total inside the safe-integer range, and it is deliberately NOT re-checked
 * here -- the two sides bound per-image size on differently-trusted inputs and
 * report it on different channels (ADR-0001 section 9 redaction). Passing
 * unbounded dimensions is a caller bug, not an input this function defends
 * against.
 *
 * Both the worker and the parent call this on inputs they hold independently.
 * That is the point: the parent still never takes the worker's accounting on
 * trust (ADR-0001 section 7), it just stops re-deriving the arithmetic by hand.
 */
export function chargeDecodedWork<K>(
  sources: readonly DecodedWorkSource<K>[],
): DecodedWorkCharge {
  const charged = new Map<K, readonly [number, number]>();
  let total = 0;
  for (const { contentSha256, width, height } of sources) {
    const previous = charged.get(contentSha256);
    if (previous !== undefined) {
      if (previous[0] !== width || previous[1] !== height)
        return { ok: false, reason: "incoherent" };
      continue;
    }
    charged.set(contentSha256, [width, height]);
    total += width * height;
    if (total > MDX_RELAY_LIMITS.cumulativeDecodedPixels)
      return { ok: false, reason: "exceeded" };
  }
  return { ok: true, total };
}
```

**Verification:**
Run: `npm run typecheck && npm run test:unit`
Expected: exit 0.

**Acceptance Criteria:**
- [ ] `src/core/decoded-work-budget.ts` imports only `./limits`.
- [ ] `grep -rn "^import" src/core/decoded-work-budget.ts` shows exactly one line.

**Automated Tests:** Task 4 (exhaustive suite). Splitting the module from its tests keeps
each task independently verifiable.

### Task 2: Rewire the worker

**Files:**
- Modify: `src/worker/process-plan.ts`

**Implementation:**

Replace the `let decodedPixels = 0;` accumulator (`:114`) with a probed-source list:

```ts
  // Every unique source probed so far, in charge order. The cumulative budget
  // is recharged over this whole prefix before each decode, because the cap
  // must be enforced *before* the work is performed (ADR-0001 section 8), and
  // one shared function owns that arithmetic for both sides.
  const probed: DecodedWorkSource<Sha256Digest>[] = [];
```

Replace the cumulative block (`:177-192`) with:

```ts
    // The hard cap: a source that would push the plan past the cumulative limit
    // is refused before its decode begins, so the work is never performed.
    probed.push({ contentSha256: image.contentSha256, width, height });
    const charge = chargeDecodedWork(probed);
    if (!charge.ok) {
      // `incoherent` is unreachable here: repeats are skipped at the bySource
      // cache above, before any probe, so `probed` holds one entry per unique
      // source. Both reasons fail closed on the same channel regardless.
      deps.post({
        type: "completed",
        generationToken,
        result: blockerResult([
          createIssue(ISSUE_CODES.decodedWorkLimitExceeded),
        ]),
      });
      return;
    }
```

Add the import alongside the existing `MDX_RELAY_LIMITS` import at `:18`:

```ts
import {
  chargeDecodedWork,
  type DecodedWorkSource,
} from "../core/decoded-work-budget";
```

The per-image ceiling at `:165-176` is untouched. The `width`/`height` destructure at
`:162` is untouched.

**Verification:**
Run: `npm run test:unit -- process-plan`
Expected: all 31 tests pass, zero changed assertions.

**Acceptance Criteria:**
- [ ] No `decodedPixels` identifier remains in `process-plan.ts`.
- [ ] `MDX_RELAY_LIMITS.cumulativeDecodedPixels` no longer appears in `process-plan.ts`.
- [ ] `MDX_RELAY_LIMITS.decodedImagePixels` still appears (per-image ceiling stays).
- [ ] Every existing `process-plan.test.ts` assertion passes unmodified.

**Automated Tests:** Existing `tests/unit/worker/process-plan.test.ts:395-575` budget region
must pass with **zero edits**. An edit there means behavior changed and the refactor is
wrong.

### Task 3: Rewire the client

**Files:**
- Modify: `src/worker/processing-client.ts`

**Implementation:**

Replace the body of `exceedsDecodedWorkBudget` (`:630-652`), keeping the signature and the
tri-state contract its caller at `:707-711` depends on:

```ts
  private exceedsDecodedWorkBudget(
    request: WorkerProcessRequest,
    images: readonly WorkerImageOutput[],
  ): boolean | undefined {
    const charge = chargeDecodedWork(
      images.map((image, index) => ({
        contentSha256: request.images[index]!.contentSha256,
        width: image.decodedWidth,
        height: image.decodedHeight,
      })),
    );
    if (charge.ok) return false;
    // Incoherent repeats are a malformed report, not a budget overrun, and stay
    // on the redacted MALFORMED channel (ADR-0001 section 9).
    return charge.reason === "exceeded" ? true : undefined;
  }
```

Keep the existing doc comment above it, updating only the sentence that described the
inline loop. Add `chargeDecodedWork` to the `../core/` import at `:24`.

**Verification:**
Run: `npm run test:unit -- processing-client`
Expected: all 109 tests pass, zero changed assertions.

**Acceptance Criteria:**
- [ ] `exceedsDecodedWorkBudget` still returns `true` / `false` / `undefined` with unchanged
      meanings.
- [ ] `MDX_RELAY_LIMITS.cumulativeDecodedPixels` no longer appears in
      `processing-client.ts`.
- [ ] `MDX_RELAY_LIMITS.decodedImagePixels` still appears at `:590` (per-image ceiling).
- [ ] Every existing `processing-client.test.ts` assertion passes unmodified.

**Automated Tests:** Existing `tests/unit/worker/processing-client.test.ts:1460-1700` budget
region must pass with **zero edits**, for the same reason as Task 2.

### Task 4: Exhaustive helper suite

**Files:**
- Modify: `src/core/decoded-work-budget.ts` (in-source `import.meta.vitest` block)

**Implementation:**

Cases, each asserting the exact `DecodedWorkCharge`:

| # | Case | Expected |
|---|------|----------|
| 1 | empty list | `{ok: true, total: 0}` |
| 2 | one source | `{ok: true, total: w*h}` |
| 3 | two distinct sources | sum of both |
| 4 | repeat embed, identical edges | charged once |
| 5 | three embeds of one source | charged once |
| 6 | repeat with transposed edges (`2x6` then `6x2`) | `incoherent` |
| 7 | repeat with same area, different edges (`2x6` then `3x4`) | `incoherent` |
| 8 | 10 sources at `10_000 x 4_000` (40 MP each) → exactly 400 MP | `{ok: true, total: 400_000_000}` (boundary, not an overrun) |
| 9 | case 8 plus one `1 x 1` source → 400 MP + 1 | `exceeded` |
| 10 | 11 sources at `10_000 x 4_000` → overruns at the 11th | `exceeded` |
| 11 | incoherent repeat positioned *after* the cap is already hit | `exceeded` wins (short-circuit order) |
| 12 | 20 embeds of one `10_000 x 4_000` source (800 MP if double-charged) | `{ok: true, total: 40_000_000}` |
| 13 | 50 distinct sources at `2_000 x 4_000` (8 MP each) → exactly 400 MP | `{ok: true, total: 400_000_000}` |
| 14 | two distinct source *objects* carrying the same hash **string** | charged once |

Case 14 works because `Sha256Digest` is a branded string primitive, so `Map` identity is
value equality on the hash. The case proves the helper keys on the hash value and not on
the enclosing object reference. Build it with two separately-constructed
`DecodedWorkSource` literals sharing one `"sha256:..."` string.

**Dimensions are concrete on purpose.** `decodedImagePixels` is 40 MP and
`cumulativeDecodedPixels` is 400 MP, so **no single precondition-respecting source can
overrun the cumulative cap**: it takes 11 max-size images. Any case that overruns on one
source would have to pass an input the contract forbids, so no such case exists here. Case
13 uses the 50-source `sealedOutputFiles` bound at 8 MP each, the largest per-source size
that still fits 50 sources inside the cap.

Case 11 pins the short-circuit order, which is observable and would otherwise be an
accident of loop structure.

**Verification:**
Run: `npm run test:coverage`
Expected: `src/core/decoded-work-budget.ts` at 100% statements, lines, branches, functions.
The directory gate is 99/99/95/100; this file should clear it outright.

**Acceptance Criteria:**
- [ ] All 14 cases pass.
- [ ] Coverage report shows the file at 100% across all four metrics.

**Automated Tests:** This task is the tests.

### Task 5: Parity tests

**Files:**
- Create: `tests/unit/worker/decoded-work-cases.ts` (shared table, not a `.test.ts`)
- Create: `tests/unit/worker/decoded-work-parity.test.ts` (worker driver)
- Modify: `tests/unit/worker/processing-client.test.ts` (client driver, appended)

**Implementation:**

The arithmetic is single-owner by construction after Tasks 2 and 3, so parity tests must
**not** re-prove the math. The residual risk is **input equivalence**: each side building
the wrong input shape and feeding the right function garbage.

**Test seams.** Neither call site is directly callable, so use the seams the existing tests
already use:

- **Worker:** `processPlan(request, deps)` is exported and every collaborator is injected
  through `ProcessPlanDeps` (`process-plan.ts:24-44`). Control `readImageHeader` to return
  chosen dimensions, and count `codec.transform` calls to observe dedupe. No module mocking.
- **Client:** `exceedsDecodedWorkBudget` is `private`. Drive it through the public
  `process()` path with a crafted completion payload, the same way
  `processing-client.test.ts:1460-1700` already does. Do **not** reach in via
  `["exceedsDecodedWorkBudget"]` index access; that couples the test to a private name and
  bypasses `decodeImage`, which is the very ordering Task 6 pins.

Three properties, each a real failure mode that would survive Tasks 1-4:

**P1 — both sides key on the parent-owned request hash.**
Build a request with two embeds sharing one `images[i].contentSha256` (source hash), where
the codec returns a *different* output `contentSha256` for each. The two hashes must
disagree, or the property proves nothing.
- Worker: assert `codec.transform` is called exactly once. If dedupe keyed on the output
  hash, the second embed would miss the cache and transform twice.
- Client: assert the completion is accepted and the plan totals one source, not two.

Guards against a refactor swapping in `image.contentSha256` from `WorkerImageOutput`, which
is the *output* hash and would silently break dedupe.

**P2 — both sides charge raw decoded dimensions, not output dimensions.**
The charged total is not exposed by either call site, so make the miscount observable by
straddling the cap. Use 11 sources at `10_000 x 4_000` decoded (40 MP each, 440 MP total)
each resized to `2_000 x 800` output (1.6 MP each, 17.6 MP total):

| Charged from | Total | Outcome |
|--------------|-------|---------|
| decoded dims (correct) | 440 MP | refused |
| output dims (wrong) | 17.6 MP | accepted |

Assert **refused** on both sides. Wiring `width`/`height` instead of
`decodedWidth`/`decodedHeight` flips the outcome, so the bug cannot hide behind an
unobservable total. ADR-0001 §7 exists precisely because `TransformedImage` used to expose
only the output size.

**P3 — the worker's prefix-charging and the client's whole-list charging agree.**
Drive one shared case table through a worker driver and a client driver, asserting identical
accept/refuse outcomes. The asymmetry from D3 is the point: the worker's input carries no
repeats, the client's does, and both must land on the same answer.

| Case | Embeds (each `10_000 x 4_000` = 40 MP unless noted) | Expected |
|------|------------------------------------------------------|----------|
| a | 1 unique | accepted |
| b | 10 unique (400 MP exactly) | accepted |
| c | 11 unique (440 MP) | refused, `DECODED_WORK_LIMIT_EXCEEDED` |
| d | 10 unique + 5 repeats of an existing source | accepted (repeats free) |
| e | 3 embeds of 1 source, repeated to 30 entries | accepted |

Case b is the off-by-one detector. A prefix slice of `probed.slice(0, i)` instead of
`slice(0, i + 1)` undercharges by the current source, so case b's 10th source is never
charged and case c passes at 11 when it must refuse. Assert case c refuses **and** case b
accepts; either alone misses one direction of the off-by-one.

**Client payload construction.** A crafted completion must satisfy every check that runs
*before* `exceedsDecodedWorkBudget` at `:707`, or the test fails for the wrong reason:
`transformedImages.length === request.images.length`, a resolvable `maxDimension` in the
profile snapshot, and per-image `decodeImage` validity (exact keys, matching `sourceId`,
positive-integer dims, no upscale, correct `contentSha256` and `byteLength` over the actual
bytes). Reuse the existing payload builder in `processing-client.test.ts:1460-1700` rather
than hand-rolling one.

**Verification:**
Run: `npm run test:unit -- decoded-work-parity`
Expected: all three properties pass.

**Acceptance Criteria:**
- [ ] P1 fails if the dedupe key is switched to the output hash.
- [ ] P2 fails if the client is switched to `width`/`height`.
- [ ] P3 fails if the worker's prefix slice is off by one.

Each criterion is stated as a mutation the test must catch. Verify by making the mutation
locally and confirming a red test before reverting.

**Automated Tests:** This task is the tests.

### Task 6: Pin the caller precondition

**Files:**
- Modify: `tests/unit/worker/process-plan.test.ts`
- Modify: `tests/unit/worker/processing-client.test.ts`

**Implementation:**

The contract's safe-integer guarantee now rests on callers bounding per-image size first.
That ordering is currently incidental. Pin it on both sides:

**The ordering is provable from the issue code alone — no spy needed.** With edges of
`0xFFFFFFFF`, the two orderings produce *different* observable outcomes:

| Ordering | Emitted issue |
|----------|---------------|
| per-image first (correct) | `DECODED_IMAGE_TOO_LARGE` |
| cumulative first (wrong) | `DECODED_WORK_LIMIT_EXCEEDED` (1.8e19 > 400 MP) |

So asserting the exact issue code pins the ordering. Concretely:

- Worker: `readImageHeader` returns `{width: 0xFFFFFFFF, height: 0xFFFFFFFF}`. Assert the
  completion carries `DECODED_IMAGE_TOO_LARGE`, **not** `DECODED_WORK_LIMIT_EXCEEDED`, and
  assert `codec.transform` was never called.
- Client: a completion reporting `decodedWidth * decodedHeight` above `decodedImagePixels`
  must settle on redacted `MALFORMED_WORKER_RESPONSE` (from `decodeImage`), **not** the
  `decoded-work-exceeded` path.

**Verification:**
Run: `npm run test:unit`
Expected: exit 0.

**Acceptance Criteria:**
- [ ] Reordering the per-image check after the cumulative charge turns at least one test
      red on each side, and the failure is a wrong *issue code*, not a crash.

**Automated Tests:** This task is the tests.

### Task 7: File APP-643

**Files:** none.

**Implementation:**

File the deferred alternative in Linear before closing APP-624, so the tradeoff is not lost
with this conversation.

- Team **Apps**, project **MDX Relay**, priority Medium, labels `cleanup` +
  `dweeb11/mdx-relay`.
- Title: "Arch: worker probes every embed for hash-vs-header coherence".
- Body: carry the "Consequence of D3" section verbatim — the check gained (a repeat whose
  hash matches but whose header disagrees, undetectable today), the cost (one extra bounded
  header read per repeat embed, no pixel data touched per ADR-0001 §8), and that this is a
  real behavior change requiring an ADR-0001 note.
- Link as related to APP-624.

Use the Linear MCP tools. If Linear is unreachable, do **not** block the PR: post the exact
issue body as a comment on APP-624 and note in the PR description that APP-643 is unfiled.
The rule is that the tradeoff survives somewhere durable, not that a particular tool works.

**Verification:**
Run: none (tracker operation).
Expected: APP-643 URL, or a fallback comment URL on APP-624.

**Acceptance Criteria:**
- [ ] APP-643 exists and is linked to APP-624, or the fallback comment exists and the PR
      description says so.

**Automated Tests:** None — this is a tracker operation with no code surface.

### Task 8: Full gate

**Files:** none.

**Verification:**
Run: `npm run verify`
Expected: exit 0. Paste the full output including test counts, per the
`WORKING_AGREEMENT.md` evidence rule.

`test:bundle` matters here specifically: it runs `probe-node-builtins` and the worker smoke
test, which is what proves the new `core/` import did not drag a Node builtin into
`dist/processing.worker.js`. ADR-0002 §2 notes the Node-free rule is not otherwise enforced
by a test.

**Acceptance Criteria:**
- [ ] `npm run verify` exits 0 with output pasted.
- [ ] Coverage thresholds hold, including the new `src/core/` file.

## Testing plan

| Layer | What | Count |
|-------|------|-------|
| Unit (core) | `chargeDecodedWork` exhaustive cases | +14 |
| Unit (parity) | input-equivalence properties P1-P3 | +3 |
| Unit (precondition) | per-image bound ordering, both sides | +2 |
| Unit (regression) | existing budget regions, **unmodified** | 24 existing |
| Bundle | `probe-node-builtins` + worker smoke | existing |

Net new: 19 tests. **Existing assertions modified: zero.**

Tasks 2 and 3 must not touch `process-plan.test.ts` or `processing-client.test.ts` at all.
Task 6 *appends* two new tests to those files but edits no existing assertion, block, or
fixture. The signal for a behavior-preserving refactor is that every assertion written
before this plan still passes as written, so review the diff of those two test files and
confirm it is additions only.

## Rollback plan

Revert the PR. The change is additive plus two call-site rewrites, touches no persisted
format, no wire protocol, and no stored plan bytes. Nothing serializes a `DecodedWorkCharge`.

Partial rollback is also safe: reverting Task 3 alone leaves the worker on the shared helper
and the client on its inline loop, which is exactly today's behavior with one side already
migrated.

## Effort estimate

| Component | Human | CC + gstack |
|-----------|-------|-------------|
| Task 1 helper | 30 min | 3 min |
| Tasks 2-3 call sites | 45 min | 5 min |
| Task 4 exhaustive suite | 60 min | 8 min |
| Task 5 parity tests | 90 min | 12 min |
| Task 6 precondition pins | 30 min | 5 min |
| Task 7 file APP-643 | 10 min | 2 min |
| Task 8 verify + evidence | 15 min | 5 min |
| **Total** | **~4.5h** | **~40 min** |

Task 5 dominates because each property is verified by mutation, which means deliberately
breaking the code three times and confirming red.

## Files reference

| File | Change |
|------|--------|
| `src/core/decoded-work-budget.ts` | Create. The one owner of the cumulative rule. |
| `src/worker/process-plan.ts:114` | Replace `decodedPixels` accumulator with `probed` list |
| `src/worker/process-plan.ts:177-192` | Replace inline cap check with prefix charge |
| `src/worker/process-plan.ts:18` | Add `core/decoded-work-budget` import |
| `src/worker/processing-client.ts:630-652` | Replace loop body; keep signature and tri-state |
| `src/worker/processing-client.ts:24` | Add `chargeDecodedWork` to the `core/` import |
| `src/core/decoded-work-budget.ts` | In-source test block. 14 exhaustive cases. |
| `tests/unit/worker/decoded-work-cases.ts` | Create. Shared parity case table. |
| `tests/unit/worker/decoded-work-parity.test.ts` | Create. Worker-side driver, P1-P3. |
| `tests/unit/worker/process-plan.test.ts` | Add precondition-ordering test |
| `tests/unit/worker/processing-client.test.ts` | Add precondition-ordering test |

## Out of scope

- The 40 MP per-image ceiling on either side (D1).
- `src/images/portable-webp-codec.ts:121` and `src/profiles/parse-portable-profile.ts:194`.
- Worker probing repeat embeds to gain a hash-vs-header disagreement check (APP-643).
- Any change to ADR-0001 §7, §8, or §9.
- Unifying the divergent per-image edge-bound formulations.

## Definition of done

1. `npm run verify` exits 0, output pasted.
2. Diff of `process-plan.test.ts` and `processing-client.test.ts` is additions only; the 24
   existing budget assertions are byte-identical.
3. `src/core/decoded-work-budget.ts` at 100% on all four coverage metrics.
4. Each of P1, P2, P3 verified by mutation: broken deliberately, confirmed red, reverted.
5. The cumulative *comparison* lives in exactly one file. `grep -rn cumulativeDecodedPixels
   src/` returns exactly two lines: the declaration in `core/limits.ts` and the single
   comparison in `core/decoded-work-budget.ts`. No occurrence under `src/worker/`.
6. `src/core/decoded-work-budget.ts` imports exactly one module.
7. Task 7 complete: APP-643 filed and linked, or the documented fallback applied.

## Outcome

Implemented 2026-07-27 on `refactor/app-624-shared-decoded-work-budget`. `npm run verify`
exits 0: 545 unit (from 516) plus 26 integration, `src/core` at 100/100/100/100, bundle
probe confirms no Node built-in reached `dist/processing.worker.js`.

Where implementation diverged from this plan, and why:

| Planned | Actual | Reason |
|---------|--------|--------|
| Tests at `tests/unit/core/decoded-work-budget.test.ts` | In-source `import.meta.vitest` block | `tests/unit/core/` does not exist; both existing `src/core/` files use in-source tests, and `vitest.config.ts` lists `src/core/**` under `includeSource`. Followed the directory's convention. |
| One parity file | `decoded-work-cases.ts` (shared table) + `decoded-work-parity.test.ts` (worker driver) + appended client driver | The client harness (`FakeWorker`, `setup`, `okCompletion`) is module-local and unexported. Replicating ~200 lines was worse than one shared table with two independent drivers, which is stronger parity anyway. |
| Branch `dweeb1123/app-624-...` | `refactor/app-624-shared-decoded-work-budget` | The planned name was Linear's auto-generated one. `GIT_CONVENTIONS.md:12-16` requires a `refactor/` prefix and says it applies to all tools. |
| Follow-up filed as APP-625 | APP-643 | Linear assigned the next free number. |
| P2 needs a new client test | Already covered | Mutation C (client charges output dims) turned three *existing* budget tests red, so the property was already pinned. No new test added. |

Mutation verification, each confirmed red then reverted:

| Mutation | Tests turned red |
|----------|------------------|
| Worker prefix slice short by one | 3 parity |
| Worker charges resized output dims | 3 parity |
| Client charges output dims | 3 existing budget |
| Client dedupes on reported output hash | 1 new parity + 2 existing |
| Worker per-image ceiling removed | 2 existing preflight |
| Client per-image ceiling removed | 1 new precondition + 1 existing |

## Related

- ADR-0001 §7 (codecs report decoded dimensions), §8 (bounded header probe), §9 (parent
  bounds its own verification and redacts).
- ADR-0002 §2 (Node-free rule), §3 (shared predicates go to `src/core/`).
- APP-622 — M2 canonical byte rules, the consolidation precedent this follows.
- APP-643 — worker probes every embed (filed from this plan).
