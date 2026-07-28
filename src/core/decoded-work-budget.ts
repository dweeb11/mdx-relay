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
