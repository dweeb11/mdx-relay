import {
  createIssue,
  isMdxRelayIssue,
  ISSUE_CODES,
  type BlockerIssue,
  type MdxRelayIssue,
} from "./issues";

export type Result<T, E> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: E }>;

const mdxRelayResultBrand: unique symbol = Symbol("MdxRelayResult");
type MdxRelayResultBrand = Readonly<{
  readonly [mdxRelayResultBrand]: true;
}>;

export type MdxRelayErrorIssues = readonly [BlockerIssue, ...MdxRelayIssue[]];

/**
 * Nominal host/worker/storage/Git boundary result. Only mdxRelayOk and
 * mdxRelayErr construct this brand; generic Result helpers are not assignable.
 */
export type MdxRelayResult<T> =
  | (Readonly<{ ok: true; value: T }> & MdxRelayResultBrand)
  | (Readonly<{ ok: false; error: MdxRelayErrorIssues }> & MdxRelayResultBrand);

export function ok<T>(value: T): Result<T, never> {
  return Object.freeze({ ok: true, value });
}

export function err<E>(error: E): Result<never, E> {
  return Object.freeze({ ok: false, error });
}

const brandAndFreeze = <T extends object>(
  value: T,
): T & MdxRelayResultBrand => {
  Object.defineProperty(value, mdxRelayResultBrand, { value: true });
  return Object.freeze(value) as T & MdxRelayResultBrand;
};

/**
 * Freezes the nominal result wrapper. Transferable ArrayBuffers remain owned by
 * the receiving boundary: declared byte lengths and hashes are authoritative,
 * and future decoders must reverify bytes before trusting output collections.
 */
export function mdxRelayOk<T>(value: T): MdxRelayResult<T> {
  return brandAndFreeze({ ok: true as const, value });
}

/**
 * Clones and freezes the nonempty blocker-first issue tuple. Every element is
 * fully revalidated against registry-owned policy at runtime so unvalidated
 * failure data cannot be branded trusted.
 */
export function mdxRelayErr(
  issues: MdxRelayErrorIssues,
): MdxRelayResult<never> {
  if (
    !Array.isArray(issues) ||
    issues.length === 0 ||
    !issues.every(isMdxRelayIssue) ||
    issues[0].severity !== "blocker"
  ) {
    throw new TypeError(
      "mdxRelayErr requires registry-coherent issues led by a blocker.",
    );
  }
  const stableIssues = Object.freeze([...issues]) as MdxRelayErrorIssues;
  return brandAndFreeze({ ok: false as const, error: stableIssues });
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("Result", () => {
    it("keeps generic helpers generic and immutable", () => {
      expect(ok("sealed")).toEqual({ ok: true, value: "sealed" });
      expect(err("blocked")).toEqual({ ok: false, error: "blocked" });
      expect(Object.isFrozen(ok("sealed"))).toBe(true);
      expect(Object.isFrozen(err("blocked"))).toBe(true);
    });

    it("makes MdxRelayResult nominal at compile time", () => {
      const blocker = createIssue(ISSUE_CODES.invalidMdx);
      const genericFailure = err([blocker] as const);
      const genericSuccess = ok("sealed");
      // @ts-expect-error generic err lacks the private MdxRelayResult brand
      const invalidFailure: MdxRelayResult<never> = genericFailure;
      // @ts-expect-error generic ok lacks the private MdxRelayResult brand
      const invalidSuccess: MdxRelayResult<string> = genericSuccess;
      const validFailure: MdxRelayResult<never> = mdxRelayErr([blocker]);
      const validSuccess: MdxRelayResult<string> = mdxRelayOk("sealed");
      void invalidFailure;
      void invalidSuccess;
      expect(validFailure.ok).toBe(false);
      expect(validSuccess.ok).toBe(true);
    });

    it("enforces the blocker-first invariant at runtime before branding", () => {
      const blocker = createIssue(ISSUE_CODES.invalidMdx);
      const warning = createIssue(ISSUE_CODES.summaryMissing);
      const forced = (issues: unknown) => () =>
        mdxRelayErr(issues as MdxRelayErrorIssues);
      expect(forced("blocked")).toThrow(TypeError);
      expect(forced([])).toThrow(TypeError);
      expect(forced([warning])).toThrow(TypeError);
      expect(forced([warning, blocker])).toThrow(TypeError);
      expect(forced([null])).toThrow(TypeError);
      expect(forced([{ ...blocker, severity: "warning" }])).toThrow(TypeError);
      expect(forced([{ ...blocker, code: "NOT_IN_REGISTRY" }])).toThrow(
        TypeError,
      );
      expect(forced([blocker, { severity: "warning" }])).toThrow(TypeError);
      expect(
        forced([{ ...blocker, displayDetails: { summary: "secret" } }]),
      ).toThrow(TypeError);
      expect(
        forced([
          {
            ...blocker,
            displayDetails: { ...blocker.displayDetails, leaked: "secret" },
          },
        ]),
      ).toThrow(TypeError);
      expect(forced([{ ...blocker, recoveryActions: [] }])).toThrow(TypeError);
      expect(forced([{ ...blocker, stage: "git" }])).toThrow(TypeError);
      expect(forced([{ ...blocker, extra: true }])).toThrow(TypeError);
      expect(
        forced([
          blocker,
          { ...warning, displayDetails: { summary: "secret" } },
        ]),
      ).toThrow(TypeError);
      const failure = mdxRelayErr([blocker, warning]);
      expect(failure.ok).toBe(false);
      if (!failure.ok) expect(failure.error).toEqual([blocker, warning]);
    });

    it("stabilizes the blocker-first issue tuple without retaining aliases", () => {
      const blocker = createIssue(ISSUE_CODES.invalidMdx);
      const warning = createIssue(ISSUE_CODES.summaryMissing);
      const original: [BlockerIssue, MdxRelayIssue] = [blocker, warning];
      const failure = mdxRelayErr(original);
      original.pop();
      expect(failure.ok).toBe(false);
      if (!failure.ok) {
        expect(failure.error).toEqual([blocker, warning]);
        expect(Object.isFrozen(failure.error)).toBe(true);
        expect(() =>
          (failure.error as unknown as MdxRelayIssue[]).pop(),
        ).toThrow(TypeError);
      }
      expect(Object.isFrozen(failure)).toBe(true);
    });

    it("freezes the success wrapper while leaving transferable bytes to decoder verification", () => {
      const value = { bytes: Uint8Array.of(1, 2).buffer, byteLength: 2 };
      const success = mdxRelayOk(value);
      expect(Object.isFrozen(success)).toBe(true);
      expect(success.ok).toBe(true);
      expect(success.ok && success.value).toBe(value);
    });
  });
}
