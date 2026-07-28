/**
 * The shared parity table for the cumulative decoded-work budget.
 *
 * `chargeDecodedWork` owns the arithmetic for both sides, so the residual risk
 * this table exists to cover is *input equivalence*: each call site building the
 * wrong shape and handing the right function garbage. The worker charges from a
 * header probe over unique sources; the parent charges from reported decoded
 * dimensions over every embed. Both must reach the same verdict on every case
 * below, or the two sides disagree and plans fail closed for the wrong reason.
 *
 * Not a test file: `vitest.config.ts` collects `tests/unit/**\/*.test.ts`, so
 * this module is imported by the two drivers rather than run on its own.
 */

/** One embed in a plan. Repeats share a `key`, which is the canonical source. */
export interface ParityEmbed {
  readonly key: string;
  readonly width: number;
  readonly height: number;
}

export interface ParityCase {
  readonly name: string;
  readonly embeds: readonly ParityEmbed[];
  /** `true` when the plan must be refused on the cumulative budget channel. */
  readonly refused: boolean;
}

/** 40 MP: the per-image ceiling, and the largest a single source may charge. */
const MAX_W = 10_000;
const MAX_H = 4_000;

const maxEmbeds = (count: number, keyOf: (i: number) => string) =>
  Array.from({ length: count }, (_, i) => ({
    key: keyOf(i),
    width: MAX_W,
    height: MAX_H,
  }));

const unique = (count: number) =>
  maxEmbeds(count, (i) => `source-${String(i)}`);

export const PARITY_CASES: readonly ParityCase[] = [
  { name: "one unique source", embeds: unique(1), refused: false },
  // Ten maximum-size sources land on exactly 400 MP. This is the off-by-one
  // detector: a prefix slice short by one never charges the tenth source, so
  // this case still passes while the eleven-source case below wrongly passes
  // too. Asserting both directions is what pins the slice.
  {
    name: "ten unique sources at exactly the cap",
    embeds: unique(10),
    refused: false,
  },
  {
    name: "eleven unique sources over the cap",
    embeds: unique(11),
    refused: true,
  },
  {
    name: "ten unique sources plus five repeats",
    embeds: [...unique(10), ...maxEmbeds(5, (i) => `source-${String(i)}`)],
    refused: false,
  },
  {
    name: "thirty embeds of a single source",
    embeds: maxEmbeds(30, () => "one-source"),
    refused: false,
  },
];

/**
 * Unique canonical sources in first-appearance order.
 *
 * This is the worker's view: it skips a repeat at its output cache before any
 * header probe, so it only ever charges this sequence. The parent charges the
 * full embed list and dedupes inside the helper. Both must agree, which is the
 * asymmetry the parity drivers exercise.
 */
export const uniqueSources = (
  embeds: readonly ParityEmbed[],
): readonly ParityEmbed[] => {
  const seen = new Set<string>();
  const out: ParityEmbed[] = [];
  for (const embed of embeds) {
    if (seen.has(embed.key)) continue;
    seen.add(embed.key);
    out.push(embed);
  }
  return out;
};
