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
 * orientation and resize -- the decode cost actually paid (ADR 0001 §7).
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
 * report it on different channels (ADR 0001 §9 redaction). Passing unbounded
 * dimensions is a caller bug, not an input this function defends against.
 *
 * Both the worker and the parent call this on inputs they hold independently.
 * That is the point: the parent still never takes the worker's accounting on
 * trust (ADR 0001 §7), it just stops re-deriving the arithmetic by hand.
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

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  const sha = (n: number | string) => `sha256:${n}`;
  const source = (n: number | string, width: number, height: number) => ({
    contentSha256: sha(n),
    width,
    height,
  });

  // 40 MP, the per-image ceiling. No single source may exceed this, so the
  // smallest cumulative overrun takes 11 of them.
  const MAX = { width: 10_000, height: 4_000 } as const;
  const maxSource = (n: number | string) => source(n, MAX.width, MAX.height);
  const distinct = (count: number) =>
    Array.from({ length: count }, (_, i) => maxSource(i));

  describe("chargeDecodedWork", () => {
    it("charges nothing for an empty plan", () => {
      expect(chargeDecodedWork([])).toEqual({ ok: true, total: 0 });
    });

    it("charges a single source its exact area", () => {
      expect(chargeDecodedWork([source("a", 3, 4)])).toEqual({
        ok: true,
        total: 12,
      });
    });

    it("sums distinct sources", () => {
      expect(
        chargeDecodedWork([source("a", 3, 4), source("b", 10, 10)]),
      ).toEqual({ ok: true, total: 112 });
    });

    it("charges a repeated source once", () => {
      expect(chargeDecodedWork([source("a", 3, 4), source("a", 3, 4)])).toEqual(
        { ok: true, total: 12 },
      );
    });

    it("charges three embeds of one source once", () => {
      expect(
        chargeDecodedWork([
          source("a", 3, 4),
          source("a", 3, 4),
          source("a", 3, 4),
        ]),
      ).toEqual({ ok: true, total: 12 });
    });

    it("rejects a repeat whose edges are transposed", () => {
      expect(chargeDecodedWork([source("a", 2, 6), source("a", 6, 2)])).toEqual(
        { ok: false, reason: "incoherent" },
      );
    });

    it("rejects a repeat with the same area but different edges", () => {
      expect(chargeDecodedWork([source("a", 2, 6), source("a", 3, 4)])).toEqual(
        { ok: false, reason: "incoherent" },
      );
    });

    it("allows a plan totalling exactly the cumulative cap", () => {
      expect(chargeDecodedWork(distinct(10))).toEqual({
        ok: true,
        total: MDX_RELAY_LIMITS.cumulativeDecodedPixels,
      });
    });

    it("refuses a plan one pixel over the cap", () => {
      expect(chargeDecodedWork([...distinct(10), source("x", 1, 1)])).toEqual({
        ok: false,
        reason: "exceeded",
      });
    });

    it("refuses at the eleventh maximum-size source", () => {
      expect(chargeDecodedWork(distinct(11))).toEqual({
        ok: false,
        reason: "exceeded",
      });
    });

    it("reports exceeded when the cap is hit before an incoherent repeat", () => {
      // The overrun lands at index 10; the incoherent entry never gets read.
      expect(chargeDecodedWork([...distinct(11), source(0, 1, 1)])).toEqual({
        ok: false,
        reason: "exceeded",
      });
    });

    it("keeps a plan inside the cap that would exceed it if repeats were double-charged", () => {
      expect(
        chargeDecodedWork(Array.from({ length: 20 }, () => maxSource("a"))),
      ).toEqual({ ok: true, total: MAX.width * MAX.height });
    });

    it("totals fifty distinct sources at the sealed-output-file bound", () => {
      const sources = Array.from(
        { length: MDX_RELAY_LIMITS.sealedOutputFiles },
        (_, i) => source(i, 2_000, 4_000),
      );
      expect(chargeDecodedWork(sources)).toEqual({
        ok: true,
        total: MDX_RELAY_LIMITS.cumulativeDecodedPixels,
      });
    });

    it("keys on the hash value, not the enclosing object identity", () => {
      // Two separately constructed literals carrying one hash string.
      const first = { contentSha256: sha("a"), width: 3, height: 4 };
      const second = { contentSha256: sha("a"), width: 3, height: 4 };
      expect(first).not.toBe(second);
      expect(chargeDecodedWork([first, second])).toEqual({
        ok: true,
        total: 12,
      });
    });
  });
}
