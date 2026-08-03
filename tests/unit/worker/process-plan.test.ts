import { describe, expect, it, vi } from "vitest";

import type {
  CanonicalDependencySnapshot,
  GenerationToken,
  Sha256Digest,
  ValidatedPortableProfileSnapshot,
} from "../../../src/contracts/export-plan";
import {
  createIssue,
  ISSUE_CODES,
  toSafePathLabel,
  type SafePathLabel,
} from "../../../src/contracts/issues";
import { err, ok } from "../../../src/contracts/result";
import type {
  WorkerImageInput,
  WorkerImageInputV2,
  WorkerProcessRequest,
  WorkerProcessRequestV2,
  WorkerWireEvent,
} from "../../../src/contracts/worker-protocol";
import type { ImageCodec } from "../../../src/images/image-codec";
import type {
  MarkdownImageReference,
  MarkdownTransformResult,
} from "../../../src/markdown/transform";
import { MDX_RELAY_LIMITS } from "../../../src/core/limits";
import { DPW_MIND_NET_V1 } from "../../../src/profiles/builtins/dpw-mind-net-v1";
import {
  processPlan,
  type ProcessPlanDeps,
} from "../../../src/worker/process-plan";

const token = "generation-1" as GenerationToken;
const digest = (value: string): Sha256Digest =>
  `sha256:${value}` as Sha256Digest;
const label = (value: string): SafePathLabel =>
  toSafePathLabel(value) as SafePathLabel;

const image = (
  sourceId: string,
  contentSha256: string,
  safePath = `assets/${sourceId}.png`,
  embedSource = safePath,
  embedSourceStartOffset = 0,
): WorkerImageInputV2 => ({
  sourceId,
  embedSource,
  embedSourceStartOffset,
  safePathLabel: label(safePath),
  contentSha256: digest(contentSha256),
  byteLength: 4,
  bytes: Uint8Array.of(1, 2, 3, 4).buffer,
});

const request = (
  images: readonly WorkerImageInputV2[],
  overrides: Partial<WorkerProcessRequestV2> = {},
): WorkerProcessRequestV2 => ({
  type: "process-plan-v2",
  generationToken: token,
  planStartedAtMs: 1_000,
  planDeadlineMs: 601_000,
  imageTimeoutMs: 60_000,
  sourceNote: {
    vaultRelativePath: "notes/example.md",
    safePathLabel: label("notes/example.md"),
    byteLength: 5,
    contentSha256: digest("note"),
    bytes: new TextEncoder().encode("# hi\n").buffer,
  },
  profileSnapshot: JSON.stringify(
    DPW_MIND_NET_V1,
  ) as ValidatedPortableProfileSnapshot,
  profileSnapshotSha256: digest("profile"),
  dependencySnapshot: "{}" as CanonicalDependencySnapshot,
  dependencySnapshotSha256: digest("deps"),
  images,
  ...overrides,
});

const legacyRequest = (
  images: readonly WorkerImageInputV2[],
): WorkerProcessRequest => ({
  ...request(images),
  type: "process-plan",
  images: images.map((image): WorkerImageInput => ({
    sourceId: image.sourceId,
    safePathLabel: image.safePathLabel,
    contentSha256: image.contentSha256,
    byteLength: image.byteLength,
    bytes: image.bytes,
  })),
});

/** Occurrence list aligned with request embed sources (document order). */
const alignedOccurrences = (
  images: readonly WorkerImageInputV2[],
  sourceFor: (image: WorkerImageInputV2) => string = (image) =>
    image.embedSource,
): readonly MarkdownImageReference[] =>
  images.map((image, index) =>
    Object.freeze({
      source: sourceFor(image),
      sourceStartOffset: image.embedSourceStartOffset,
      destination: `img-${String(index + 1)}.webp`,
    }),
  );

const markdownResult = (
  images: readonly WorkerImageInputV2[] = [],
  occurrences: readonly MarkdownImageReference[] = alignedOccurrences(images),
): MarkdownTransformResult => ({
  slug: "example",
  mdx: "# hi\n",
  images: occurrences,
  issues: [createIssue(ISSUE_CODES.summaryMissing)],
});

interface Harness {
  readonly deps: ProcessPlanDeps;
  readonly posts: {
    event: WorkerWireEvent;
    transfer: readonly Transferable[] | undefined;
  }[];
  readonly transformCalls: () => number;
}

/** Matches the default fake codec's decoded size, so the charge is coherent. */
const defaultHeader = () =>
  ok({ mime: "image/png" as const, width: 4, height: 4 });

const harness = (
  images: readonly WorkerImageInputV2[] = [],
  overrides: Partial<ProcessPlanDeps> = {},
  codecTransform?: ImageCodec["transform"],
): Harness => {
  const posts: Harness["posts"] = [];
  const transform =
    codecTransform ??
    vi.fn(async () =>
      ok({
        decodedMime: "image/png" as const,
        decodedWidth: 4,
        decodedHeight: 4,
        width: 2,
        height: 2,
        bytes: Uint8Array.of(9, 9).buffer,
      }),
    );
  const deps: ProcessPlanDeps = {
    codec: { transform },
    readImageHeader: defaultHeader,
    hash: async (bytes) => digest(`h${bytes.byteLength}`),
    transformMarkdown: (async () =>
      ok(markdownResult(images))) as ProcessPlanDeps["transformMarkdown"],
    post: (event, transferList) =>
      posts.push({ event, transfer: transferList }),
    now: () => 2_000,
    ...overrides,
  };
  return {
    deps,
    posts,
    transformCalls: () =>
      (transform as ReturnType<typeof vi.fn>).mock.calls.length,
  };
};

const types = (posts: Harness["posts"]): string[] =>
  posts.map(({ event }) => event.type);

describe("processPlan", () => {
  it("emits started, per-image progress, and an ok completion", async () => {
    const images = [image("a", "aa"), image("b", "bb")];
    const h = harness(images);
    await processPlan(request(images), h.deps);
    expect(types(h.posts)).toEqual([
      "started",
      "progress",
      "progress",
      "completed",
    ]);
    const started = h.posts[0]!.event;
    expect(started).toMatchObject({ type: "started", imageCount: 2 });
    const completed = h.posts.at(-1)!;
    const result = (
      completed.event as { result: { ok: boolean; value: unknown } }
    ).result;
    expect(result.ok).toBe(true);
    const value = result.value as {
      transformedImages: unknown[];
      generatedMdx: { byteLength: number };
      warnings: unknown[];
    };
    expect(value.transformedImages).toHaveLength(2);
    expect(value.generatedMdx.byteLength).toBeGreaterThan(0);
    expect(value.warnings).toHaveLength(1);
  });

  it("transfers every output buffer exactly once", async () => {
    const images = [image("a", "aa"), image("b", "bb")];
    const h = harness(images);
    await processPlan(request(images), h.deps);
    const completed = h.posts.at(-1)!;
    expect(completed.transfer).toBeDefined();
    const transfer = completed.transfer!;
    expect(new Set(transfer).size).toBe(transfer.length);
    // Two image outputs plus the generated MDX buffer.
    expect(transfer).toHaveLength(3);
  });

  it("decodes each canonical source once and reuses it for duplicates", async () => {
    const images = [
      image("a", "same", "assets/photo.png"),
      image("b", "same", "assets/photo.png"),
    ];
    const h = harness(images);
    await processPlan(request(images), h.deps);
    expect(h.transformCalls()).toBe(1);
    const value = (
      h.posts.at(-1)!.event as {
        result: { value: { transformedImages: unknown[] } };
      }
    ).result.value;
    expect(value.transformedImages).toHaveLength(2);
  });

  it("collapses to a blocker-first error when an image fails", async () => {
    const failing: ImageCodec["transform"] = async () =>
      err(createIssue(ISSUE_CODES.imageDecodeFailed));
    const images = [image("a", "aa")];
    const h = harness(images, {}, failing);
    await processPlan(request(images), h.deps);
    const result = (
      h.posts.at(-1)!.event as {
        result: { ok: boolean; error: { code: string }[] };
      }
    ).result;
    expect(result.ok).toBe(false);
    expect(result.error[0]!.code).toBe(ISSUE_CODES.imageDecodeFailed);
  });

  it("collapses to a blocker when the markdown transform fails", async () => {
    const images = [image("a", "aa")];
    const h = harness(images, {
      transformMarkdown: (async () =>
        err(
          createIssue(ISSUE_CODES.invalidMdx),
        )) as ProcessPlanDeps["transformMarkdown"],
    });
    await processPlan(request(images), h.deps);
    // No image processing happens once the note itself is blocked.
    expect(types(h.posts)).toEqual(["started", "completed"]);
    const result = (
      h.posts.at(-1)!.event as {
        result: { ok: boolean; error: { code: string }[] };
      }
    ).result;
    expect(result.ok).toBe(false);
    expect(result.error[0]!.code).toBe(ISSUE_CODES.invalidMdx);
  });

  it("blocks an unparseable profile snapshot", async () => {
    const h = harness();
    await processPlan(
      request([], {
        profileSnapshot: "{not json" as ValidatedPortableProfileSnapshot,
      }),
      h.deps,
    );
    const result = (
      h.posts.at(-1)!.event as {
        result: { ok: boolean; error: { code: string }[] };
      }
    ).result;
    expect(result.ok).toBe(false);
    expect(result.error[0]!.code).toBe(ISSUE_CODES.invalidProfile);
  });

  it.each([
    ["empty object", "{}"],
    ["array", "[]"],
    ["primitive string", '"profile"'],
    ["primitive number", "42"],
    ["primitive null", "null"],
    ["primitive boolean", "true"],
    [
      "missing fields",
      JSON.stringify({ schemaVersion: 1, id: "dpw-mind-net-v1" }),
    ],
    [
      "extra top-level field",
      JSON.stringify({ ...DPW_MIND_NET_V1, extra: true }),
    ],
    [
      "out-of-range maxDimension",
      JSON.stringify({
        ...DPW_MIND_NET_V1,
        images: { ...DPW_MIND_NET_V1.images, maxDimension: 0 },
      }),
    ],
    [
      "out-of-range webpQuality",
      JSON.stringify({
        ...DPW_MIND_NET_V1,
        images: { ...DPW_MIND_NET_V1.images, webpQuality: 101 },
      }),
    ],
  ])(
    "blocks invalid profile snapshot shape (%s) as INVALID_PROFILE",
    async (_label, snapshot) => {
      const images = [image("a", "aa")];
      const transformMarkdown = vi.fn(async () => ok(markdownResult(images)));
      const h = harness(images, {
        transformMarkdown:
          transformMarkdown as unknown as ProcessPlanDeps["transformMarkdown"],
      });
      await processPlan(
        request(images, {
          profileSnapshot: snapshot as ValidatedPortableProfileSnapshot,
        }),
        h.deps,
      );
      expect(types(h.posts)).toEqual(["started", "completed"]);
      const result = (
        h.posts.at(-1)!.event as {
          result: { ok: boolean; error: { code: string }[] };
        }
      ).result;
      expect(result.ok).toBe(false);
      expect(result.error[0]!.code).toBe(ISSUE_CODES.invalidProfile);
      expect(transformMarkdown).not.toHaveBeenCalled();
      expect(h.transformCalls()).toBe(0);
    },
  );

  it("accepts a valid frozen portable profile unchanged", async () => {
    const seen: unknown[] = [];
    const h = harness([], {
      transformMarkdown: (async (_note, profile) => {
        seen.push(profile);
        return ok(markdownResult());
      }) as ProcessPlanDeps["transformMarkdown"],
    });
    await processPlan(request([]), h.deps);
    const result = (h.posts.at(-1)!.event as { result: { ok: boolean } })
      .result;
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(DPW_MIND_NET_V1);
  });

  it("fails closed with PLAN_BUDGET_EXHAUSTED when the deadline has passed", async () => {
    const images = [image("a", "aa")];
    const h = harness(images, { now: () => 700_000 });
    await processPlan(request(images), h.deps);
    const progress = h.posts.find((post) => post.event.type === "progress")
      ?.event as {
      elapsedMs: number;
      remainingPlanBudgetMs: number;
    };
    // Past the deadline the worker still announces the image, but clocks stay
    // inside the sealed window so the parent can accept the progress event.
    expect(progress).toEqual(
      expect.objectContaining({
        elapsedMs: 600_000,
        remainingPlanBudgetMs: 0,
      }),
    );
    const result = (
      h.posts.at(-1)!.event as {
        result: { ok: boolean; error: { code: string }[] };
      }
    ).result;
    expect(result.ok).toBe(false);
    expect(result.error[0]!.code).toBe(ISSUE_CODES.planBudgetExhausted);
    expect(h.transformCalls()).toBe(0);
  });
});

/**
 * The parent can only arm a per-image timer from a wire signal, so the exact
 * interleaving of posts and codec work is a protocol guarantee, not an
 * implementation detail: each image's `progress` must be observable before that
 * image's decode/encode begins, and `started` must not imply image work.
 */
describe("processPlan image-work signalling", () => {
  const interleaving = async (
    images: readonly WorkerImageInputV2[],
  ): Promise<string[]> => {
    const order: string[] = [];
    const transform: ImageCodec["transform"] = async () => {
      order.push("codec.transform");
      return ok({
        decodedMime: "image/png" as const,
        decodedWidth: 4,
        decodedHeight: 4,
        width: 2,
        height: 2,
        bytes: Uint8Array.of(9, 9).buffer,
      });
    };
    const h = harness(
      images,
      {
        transformMarkdown: (async () => {
          order.push("markdown");
          return ok(markdownResult(images));
        }) as ProcessPlanDeps["transformMarkdown"],
        post: (event) => {
          order.push(
            event.type === "progress"
              ? `progress:${String((event as { imageIndex: number }).imageIndex)}`
              : event.type,
          );
        },
      },
      transform,
    );
    await processPlan(request(images), h.deps);
    return order;
  };

  it("emits started before markdown work, so started cannot time an image", async () => {
    expect(await interleaving([])).toEqual([
      "started",
      "markdown",
      "completed",
    ]);
  });

  it("emits each image's progress before that image's codec work", async () => {
    expect(await interleaving([image("a", "aa"), image("b", "bb")])).toEqual([
      "started",
      "markdown",
      "progress:0",
      "codec.transform",
      "progress:1",
      "codec.transform",
      "completed",
    ]);
  });

  it("still emits progress before reusing a deduplicated source", async () => {
    expect(
      await interleaving([
        image("a", "same", "assets/photo.png"),
        image("b", "same", "assets/photo.png"),
      ]),
    ).toEqual([
      "started",
      "markdown",
      "progress:0",
      "codec.transform",
      "progress:1",
      "completed",
    ]);
  });
});

/**
 * MDX_RELAY_LIMITS.cumulativeDecodedPixels caps the decoded work one plan may
 * perform, charged once per canonical source. It is a cap on work performed,
 * not a threshold reported after the fact: the cost of each source is read from
 * its container header and refused before any decode that would overshoot.
 */
describe("processPlan cumulative decoded-work budget", () => {
  const MEGAPIXEL = 1_000_000;
  const CUMULATIVE = MDX_RELAY_LIMITS.cumulativeDecodedPixels;
  const PER_IMAGE = MDX_RELAY_LIMITS.decodedImagePixels;

  /**
   * A header probe and codec sharing one fixed cost schedule, indexed by
   * canonical source. `performed()` is the decode work the codec actually did,
   * which is what the cap governs; `probed()` counts headers inspected.
   */
  const decoding = (pixelsPerCall: readonly number[]) => {
    const decodedPixels: number[] = [];
    let probes = 0;
    const sizeAt = (index: number): readonly [number, number] => {
      const pixels = pixelsPerCall[index] ?? PER_IMAGE;
      return [pixels / 1_000, 1_000];
    };
    const readImageHeader = ((): ProcessPlanDeps["readImageHeader"] => () => {
      const [width, height] = sizeAt(probes);
      probes += 1;
      return ok({ mime: "image/png" as const, width, height });
    })();
    const transform = vi.fn(async () => {
      const [decodedWidth, decodedHeight] = sizeAt(decodedPixels.length);
      decodedPixels.push(decodedWidth * decodedHeight);
      return ok({
        decodedMime: "image/png" as const,
        decodedWidth,
        decodedHeight,
        width: 2,
        height: 2,
        bytes: Uint8Array.of(9, 9).buffer,
      });
    });
    return {
      readImageHeader,
      transform: transform as unknown as ImageCodec["transform"],
      performed: (): number => decodedPixels.reduce((sum, n) => sum + n, 0),
      calls: (): number => decodedPixels.length,
      probed: (): number => probes,
    };
  };

  const unique = (count: number): WorkerImageInputV2[] =>
    Array.from({ length: count }, (_, index) =>
      image(`img-${String(index)}`, `sha-${String(index)}`),
    );

  const terminalResult = (h: Harness) =>
    (
      h.posts.at(-1)!.event as {
        result: { ok: boolean; error?: { code: string }[] };
      }
    ).result;

  it("locks the boundary arithmetic this budget is built on", () => {
    expect(PER_IMAGE).toBe(40 * MEGAPIXEL);
    expect(CUMULATIVE).toBe(400 * MEGAPIXEL);
    expect(11 * PER_IMAGE).toBe(440 * MEGAPIXEL);
  });

  it("never performs 440MP of work for eleven unique 40MP images", async () => {
    const images = unique(11);
    const codec = decoding(Array<number>(11).fill(PER_IMAGE));
    const h = harness(
      images,
      { readImageHeader: codec.readImageHeader },
      codec.transform,
    );
    await processPlan(request(images), h.deps);

    // The eleventh image is never decoded: the budget is already spent.
    expect(codec.calls()).toBe(10);
    expect(codec.performed()).toBe(CUMULATIVE);
    expect(codec.performed()).toBeLessThan(11 * PER_IMAGE);
    // Its header was inspected -- that is how the refusal was decided.
    expect(codec.probed()).toBe(11);
    const result = terminalResult(h);
    expect(result.ok).toBe(false);
    expect(result.error![0]!.code).toBe(ISSUE_CODES.decodedWorkLimitExceeded);
  });

  it("completes ten unique 40MP images exactly at the budget", async () => {
    const images = unique(10);
    const codec = decoding(Array<number>(10).fill(PER_IMAGE));
    const h = harness(
      images,
      { readImageHeader: codec.readImageHeader },
      codec.transform,
    );
    await processPlan(request(images), h.deps);
    expect(codec.calls()).toBe(10);
    expect(codec.performed()).toBe(CUMULATIVE);
    expect(terminalResult(h).ok).toBe(true);
  });

  it("blocks before the decode that would push a partial budget over", async () => {
    // 9 x 39MP = 351MP, then a 40MP image lands exactly on 391MP. The next
    // source costs 20MP, which would reach 411MP: it is never decoded.
    const images = unique(11);
    const codec = decoding([
      ...Array<number>(9).fill(39 * MEGAPIXEL),
      PER_IMAGE,
      20 * MEGAPIXEL,
    ]);
    const h = harness(
      images,
      { readImageHeader: codec.readImageHeader },
      codec.transform,
    );
    await processPlan(request(images), h.deps);
    expect(codec.calls()).toBe(10);
    expect(codec.performed()).toBe(391 * MEGAPIXEL);
    // The cap is never exceeded by even one pixel of real work.
    expect(codec.performed()).toBeLessThanOrEqual(CUMULATIVE);
    expect(codec.probed()).toBe(11);
    const result = terminalResult(h);
    expect(result.ok).toBe(false);
    expect(result.error![0]!.code).toBe(ISSUE_CODES.decodedWorkLimitExceeded);
  });

  it("charges a canonical source once however many times it is embedded", async () => {
    const codec = decoding([PER_IMAGE]);
    // Twenty embeds of one 40MP source: 40MP of work, not 800MP.
    const repeats = Array.from({ length: 20 }, (_, index) =>
      image(`embed-${String(index)}`, "one-source", "assets/photo.png"),
    );
    const h = harness(
      repeats,
      { readImageHeader: codec.readImageHeader },
      codec.transform,
    );
    await processPlan(request(repeats), h.deps);
    expect(codec.calls()).toBe(1);
    expect(codec.performed()).toBe(PER_IMAGE);
    // Dedupe happens before charging *and* before probing: one of each.
    expect(codec.probed()).toBe(1);
    expect(terminalResult(h).ok).toBe(true);
  });

  it("reports the decoded source size on every output, including reused ones", async () => {
    const images = [
      image("a", "same", "assets/photo.png"),
      image("b", "same", "assets/photo.png"),
    ];
    const codec = decoding([PER_IMAGE]);
    const h = harness(
      images,
      { readImageHeader: codec.readImageHeader },
      codec.transform,
    );
    await processPlan(request(images), h.deps);
    const value = (
      h.posts.at(-1)!.event as {
        result: {
          value: {
            transformedImages: {
              sourceId: string;
              decodedWidth: number;
              decodedHeight: number;
            }[];
          };
        };
      }
    ).result.value;
    expect(
      value.transformedImages.map((output) => [
        output.sourceId,
        output.decodedWidth * output.decodedHeight,
      ]),
    ).toEqual([
      ["a", PER_IMAGE],
      ["b", PER_IMAGE],
    ]);
  });
});

/**
 * The preflight is the only thing standing between an over-budget source and
 * the work it would cost, so every way it can fail must stop the plan before
 * the codec runs -- and a decoder that contradicts the header it was charged
 * for invalidates the accounting itself.
 */
describe("processPlan decoded-size preflight", () => {
  const PER_IMAGE = MDX_RELAY_LIMITS.decodedImagePixels;

  const blockedBy = async (
    overrides: Partial<ProcessPlanDeps>,
  ): Promise<{ code: string; transformCalls: number }> => {
    const images = [image("a", "aa")];
    const h = harness(images, overrides);
    await processPlan(request(images), h.deps);
    const result = (
      h.posts.at(-1)!.event as {
        result: { ok: boolean; error: { code: string }[] };
      }
    ).result;
    expect(result.ok).toBe(false);
    return {
      code: result.error[0]!.code,
      transformCalls: h.transformCalls(),
    };
  };

  it("blocks an unreadable container without decoding it", async () => {
    expect(
      await blockedBy({
        readImageHeader: () => err(createIssue(ISSUE_CODES.unsupportedImage)),
      }),
    ).toEqual({ code: ISSUE_CODES.unsupportedImage, transformCalls: 0 });
    expect(
      await blockedBy({
        readImageHeader: () => err(createIssue(ISSUE_CODES.imageDecodeFailed)),
      }),
    ).toEqual({ code: ISSUE_CODES.imageDecodeFailed, transformCalls: 0 });
  });

  it("blocks a header past the per-image ceiling without decoding it", async () => {
    expect(
      await blockedBy({
        readImageHeader: () =>
          ok({ mime: "image/png" as const, width: 8_001, height: 5_000 }),
      }),
    ).toEqual({ code: ISSUE_CODES.decodedImageTooLarge, transformCalls: 0 });
  });

  it("blocks absurd declared edges instead of overflowing the charge", async () => {
    // 0xFFFFFFFF squared is past MAX_SAFE_INTEGER: each edge is bounded first.
    expect(
      await blockedBy({
        readImageHeader: () =>
          ok({
            mime: "image/png" as const,
            width: 4_294_967_295,
            height: 4_294_967_295,
          }),
      }),
    ).toEqual({ code: ISSUE_CODES.decodedImageTooLarge, transformCalls: 0 });
    expect(4_294_967_295 * 4_294_967_295).toBeGreaterThan(
      Number.MAX_SAFE_INTEGER,
    );
    expect(4_294_967_295).toBeGreaterThan(PER_IMAGE);
  });

  it("fails the plan closed when the decoder disagrees with the header", async () => {
    // The default fake codec decodes 4x4; this header charged for 8x8.
    expect(
      await blockedBy({
        readImageHeader: () =>
          ok({ mime: "image/png" as const, width: 8, height: 8 }),
      }),
    ).toEqual({ code: ISSUE_CODES.imageDecodeFailed, transformCalls: 1 });
  });
});

/**
 * After transformMarkdown succeeds, the worker must refuse to process when the
 * occurrence list disagrees with request.images. Otherwise MDX can reference
 * outputs the worker never transforms.
 */
describe("processPlan markdown occurrence alignment", () => {
  const terminal = (h: Harness) =>
    (
      h.posts.at(-1)!.event as {
        result: { ok: boolean; error?: { code: string }[] };
      }
    ).result;

  const withOccurrences = (
    images: readonly WorkerImageInputV2[],
    occurrences: readonly MarkdownImageReference[],
  ): Harness =>
    harness(images, {
      transformMarkdown: (async () =>
        ok(
          markdownResult(images, occurrences),
        )) as ProcessPlanDeps["transformMarkdown"],
    });

  it("continues accepting image-free V1 requests", async () => {
    const h = withOccurrences([], []);
    await processPlan(legacyRequest([]), h.deps);
    expect(terminal(h).ok).toBe(true);
    expect(h.transformCalls()).toBe(0);
  });

  it("rejects image-bearing V1 requests that cannot bind occurrences", async () => {
    const images = [image("a", "aa", "assets/photo.png", "photo.png")];
    const h = withOccurrences(images, alignedOccurrences(images));
    await processPlan(legacyRequest(images), h.deps);
    expect(terminal(h)).toMatchObject({
      ok: false,
      error: [{ code: ISSUE_CODES.staleDuringPlanning }],
    });
    expect(h.transformCalls()).toBe(0);
  });

  it("fails closed when the transform finds more images than the request", async () => {
    const images = [image("a", "aa")];
    const h = withOccurrences(images, [
      {
        source: images[0]!.embedSource,
        sourceStartOffset: images[0]!.embedSourceStartOffset,
        destination: "img-1.webp",
      },
      {
        source: "assets/missing.png",
        sourceStartOffset: 0,
        destination: "img-2.webp",
      },
    ]);
    await processPlan(request(images), h.deps);
    expect(types(h.posts)).toEqual(["started", "completed"]);
    expect(terminal(h)).toMatchObject({
      ok: false,
      error: [{ code: ISSUE_CODES.staleDuringPlanning }],
    });
    expect(h.transformCalls()).toBe(0);
  });

  it("fails closed when the request lists extra images the note lacks", async () => {
    const images = [image("a", "aa"), image("b", "bb")];
    const h = withOccurrences(images, [
      {
        source: images[0]!.embedSource,
        sourceStartOffset: images[0]!.embedSourceStartOffset,
        destination: "img-1.webp",
      },
    ]);
    await processPlan(request(images), h.deps);
    expect(types(h.posts)).toEqual(["started", "completed"]);
    expect(terminal(h)).toMatchObject({
      ok: false,
      error: [{ code: ISSUE_CODES.staleDuringPlanning }],
    });
    expect(h.transformCalls()).toBe(0);
  });

  it("fails closed when request images are reordered relative to occurrences", async () => {
    const first = image("a", "aa", "assets/first.png", "first.png");
    const second = image("b", "bb", "assets/second.png", "second.png");
    const images = [first, second];
    // Document order is second then first; request still supplies first then second.
    const h = withOccurrences(images, [
      {
        source: second.embedSource,
        sourceStartOffset: second.embedSourceStartOffset,
        destination: "img-1.webp",
      },
      {
        source: first.embedSource,
        sourceStartOffset: first.embedSourceStartOffset,
        destination: "img-2.webp",
      },
    ]);
    await processPlan(request(images), h.deps);
    expect(types(h.posts)).toEqual(["started", "completed"]);
    expect(terminal(h)).toMatchObject({
      ok: false,
      error: [{ code: ISSUE_CODES.staleDuringPlanning }],
    });
    expect(h.transformCalls()).toBe(0);
  });

  it("fails closed when destination order disagrees with the profile template", async () => {
    const images = [image("a", "aa"), image("b", "bb")];
    const h = withOccurrences(images, [
      {
        source: images[0]!.embedSource,
        sourceStartOffset: images[0]!.embedSourceStartOffset,
        destination: "img-2.webp",
      },
      {
        source: images[1]!.embedSource,
        sourceStartOffset: images[1]!.embedSourceStartOffset,
        destination: "img-1.webp",
      },
    ]);
    await processPlan(request(images), h.deps);
    expect(terminal(h)).toMatchObject({
      ok: false,
      error: [{ code: ISSUE_CODES.staleDuringPlanning }],
    });
    expect(h.transformCalls()).toBe(0);
  });

  it("accepts basename embeds when capture records matching embedSource", async () => {
    const images = [image("a", "aa", "assets/photo.png", "photo.png")];
    const h = withOccurrences(images, [
      { source: "photo.png", sourceStartOffset: 0, destination: "img-1.webp" },
    ]);
    await processPlan(request(images), h.deps);
    expect(terminal(h).ok).toBe(true);
    expect(h.transformCalls()).toBe(1);
  });

  it("rejects when embedSource disagrees with the transform occurrence", async () => {
    const images = [image("a", "aa", "assets/photo.png", "photo.png")];
    const h = withOccurrences(images, [
      { source: "other.png", sourceStartOffset: 0, destination: "img-1.webp" },
    ]);
    await processPlan(request(images), h.deps);
    expect(terminal(h)).toMatchObject({
      ok: false,
      error: [{ code: ISSUE_CODES.staleDuringPlanning }],
    });
    expect(h.transformCalls()).toBe(0);
  });

  it("does not treat a resolved safePathLabel as the occurrence identity", async () => {
    // Capture resolved photo.png -> assets/photo.png, but forgot to record embedSource.
    const images = [image("a", "aa", "assets/photo.png", "assets/photo.png")];
    const h = withOccurrences(images, [
      { source: "photo.png", sourceStartOffset: 0, destination: "img-1.webp" },
    ]);
    await processPlan(request(images), h.deps);
    expect(terminal(h)).toMatchObject({
      ok: false,
      error: [{ code: ISSUE_CODES.staleDuringPlanning }],
    });
  });

  it("rejects reordered same-name embeds resolved to different paths", async () => {
    const first = image("a", "aa", "folder-a/photo.png", "photo.png", 10);
    const second = image("b", "bb", "folder-b/photo.png", "photo.png", 30);
    const captured = [first, second];
    const h = withOccurrences([second, first], alignedOccurrences(captured));
    await processPlan(request([second, first]), h.deps);
    expect(terminal(h)).toMatchObject({
      ok: false,
      error: [{ code: ISSUE_CODES.staleDuringPlanning }],
    });
    expect(h.transformCalls()).toBe(0);
  });

  it("still dedupes repeated embeds that share one source path", async () => {
    const images = [
      image("a", "same", "assets/photo.png", "photo.png", 10),
      image("b", "same", "assets/photo.png", "photo.png", 30),
    ];
    const h = withOccurrences(images, alignedOccurrences(images));
    await processPlan(request(images), h.deps);
    expect(terminal(h).ok).toBe(true);
    expect(h.transformCalls()).toBe(1);
  });
});
