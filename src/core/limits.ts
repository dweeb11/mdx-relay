export const MDX_RELAY_LIMITS = Object.freeze({
  noteBytes: 2 * 1024 * 1024,
  sealedOutputFiles: 50,
  sourceImageBytes: 25 * 1024 * 1024,
  decodedImagePixels: 40_000_000,
  sealedOutputBytes: 25 * 1024 * 1024,
  totalSealedOutputBytes: 100 * 1024 * 1024,
  cumulativeDecodedPixels: 400_000_000,
  workerImageTimeoutMs: 60_000,
  planBudgetMs: 10 * 60_000,
} as const);

export type MdxRelayLimits = typeof MDX_RELAY_LIMITS;

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("locked limits", () => {
    it("locks the approved byte, pixel, file, and time budgets", () => {
      expect(MDX_RELAY_LIMITS).toEqual({
        noteBytes: 2_097_152,
        sealedOutputFiles: 50,
        sourceImageBytes: 26_214_400,
        decodedImagePixels: 40_000_000,
        sealedOutputBytes: 26_214_400,
        totalSealedOutputBytes: 104_857_600,
        cumulativeDecodedPixels: 400_000_000,
        workerImageTimeoutMs: 60_000,
        planBudgetMs: 600_000,
      });
      expect(Object.isFrozen(MDX_RELAY_LIMITS)).toBe(true);
    });
  });
}
