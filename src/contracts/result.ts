import type { MdxRelayIssue } from "./issues";

export type Result<T, E> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: E }>;

/** Every host, worker, storage, and Git boundary uses this exact result shape. */
export type MdxRelayResult<T> = Result<T, MdxRelayIssue[]>;

export function ok<T>(value: T): Result<T, never> {
  return Object.freeze({ ok: true, value });
}

export function err<E>(error: E): Result<never, E> {
  return Object.freeze({ ok: false, error });
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("Result", () => {
    it("creates immutable success and failure discriminants", () => {
      const success = ok("sealed");
      const failure = err(["blocked"]);

      expect(success).toEqual({ ok: true, value: "sealed" });
      expect(failure).toEqual({ ok: false, error: ["blocked"] });
      expect(Object.isFrozen(success)).toBe(true);
      expect(Object.isFrozen(failure)).toBe(true);
    });
  });
}
