/**
 * Shared structural type guards used by contracts, profiles, planning, and the
 * worker client. Generic predicates live here rather than in `canonical/` so
 * that module stays about byte rules — see ADR 0002 §3.
 */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Exact-shape gate: the payload must carry these own keys and nothing else.
 * Uses an own-key check rather than a sorted-key compare so callers do not
 * re-sort `keys` on every iteration.
 */
export const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));

export const isNonemptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export const isNonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("isRecord", () => {
    it("accepts plain objects and rejects null, arrays, and primitives", () => {
      expect(isRecord({})).toBe(true);
      expect(isRecord({ a: 1 })).toBe(true);
      expect(isRecord(null)).toBe(false);
      expect(isRecord([])).toBe(false);
      expect(isRecord([1])).toBe(false);
      expect(isRecord("object")).toBe(false);
      expect(isRecord(1)).toBe(false);
      expect(isRecord(undefined)).toBe(false);
    });
  });

  describe("hasExactKeys", () => {
    it("requires every listed own key and rejects extras or missing keys", () => {
      expect(hasExactKeys({ a: 1, b: 2 }, ["a", "b"])).toBe(true);
      expect(hasExactKeys({ b: 2, a: 1 }, ["a", "b"])).toBe(true);
      expect(hasExactKeys({ a: 1 }, ["a", "b"])).toBe(false);
      expect(hasExactKeys({ a: 1, b: 2, c: 3 }, ["a", "b"])).toBe(false);
      expect(hasExactKeys({}, ["a"])).toBe(false);
      expect(hasExactKeys({ a: 1 }, [])).toBe(false);
      expect(hasExactKeys({}, [])).toBe(true);
    });
  });

  describe("isNonemptyString", () => {
    it("accepts nonempty strings only", () => {
      expect(isNonemptyString("a")).toBe(true);
      expect(isNonemptyString("")).toBe(false);
      expect(isNonemptyString(1)).toBe(false);
      expect(isNonemptyString(null)).toBe(false);
    });
  });

  describe("isNonnegativeInteger", () => {
    it("accepts safe nonnegative integers and rejects unsafe magnitudes", () => {
      expect(isNonnegativeInteger(0)).toBe(true);
      expect(isNonnegativeInteger(1)).toBe(true);
      expect(isNonnegativeInteger(-1)).toBe(false);
      expect(isNonnegativeInteger(1.5)).toBe(false);
      expect(isNonnegativeInteger(Number.NaN)).toBe(false);
      expect(isNonnegativeInteger(Number.POSITIVE_INFINITY)).toBe(false);
      expect(isNonnegativeInteger(2 ** 60)).toBe(false);
      expect(isNonnegativeInteger("0")).toBe(false);
    });
  });

  describe("isPositiveInteger", () => {
    it("accepts safe integers >= 1", () => {
      expect(isPositiveInteger(1)).toBe(true);
      expect(isPositiveInteger(0)).toBe(false);
      expect(isPositiveInteger(-1)).toBe(false);
      expect(isPositiveInteger(1.5)).toBe(false);
      expect(isPositiveInteger(2 ** 60)).toBe(false);
      expect(isPositiveInteger("1")).toBe(false);
    });
  });
}
