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
  WorkerProcessRequest,
  WorkerWireEvent,
} from "../../../src/contracts/worker-protocol";
import type { ImageCodec } from "../../../src/images/image-codec";
import type { MarkdownTransformResult } from "../../../src/markdown/transform";
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

const image = (sourceId: string, contentSha256: string): WorkerImageInput => ({
  sourceId,
  safePathLabel: label(`assets/${sourceId}.png`),
  contentSha256: digest(contentSha256),
  byteLength: 4,
  bytes: Uint8Array.of(1, 2, 3, 4).buffer,
});

const request = (
  images: readonly WorkerImageInput[],
  overrides: Partial<WorkerProcessRequest> = {},
): WorkerProcessRequest => ({
  type: "process-plan",
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

const markdownResult: MarkdownTransformResult = {
  slug: "example",
  mdx: "# hi\n",
  images: [],
  issues: [createIssue(ISSUE_CODES.summaryMissing)],
};

interface Harness {
  readonly deps: ProcessPlanDeps;
  readonly posts: {
    event: WorkerWireEvent;
    transfer: readonly Transferable[] | undefined;
  }[];
  readonly transformCalls: () => number;
}

const harness = (
  overrides: Partial<ProcessPlanDeps> = {},
  codecTransform?: ImageCodec["transform"],
): Harness => {
  const posts: Harness["posts"] = [];
  const transform =
    codecTransform ??
    vi.fn(async () =>
      ok({
        decodedMime: "image/png" as const,
        width: 2,
        height: 2,
        bytes: Uint8Array.of(9, 9).buffer,
      }),
    );
  const deps: ProcessPlanDeps = {
    codec: { transform },
    hash: async (bytes) => digest(`h${bytes.byteLength}`),
    transformMarkdown: (async () =>
      ok(markdownResult)) as ProcessPlanDeps["transformMarkdown"],
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
    const h = harness();
    await processPlan(request([image("a", "aa"), image("b", "bb")]), h.deps);
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
    const h = harness();
    await processPlan(request([image("a", "aa"), image("b", "bb")]), h.deps);
    const completed = h.posts.at(-1)!;
    expect(completed.transfer).toBeDefined();
    const transfer = completed.transfer!;
    expect(new Set(transfer).size).toBe(transfer.length);
    // Two image outputs plus the generated MDX buffer.
    expect(transfer).toHaveLength(3);
  });

  it("decodes each canonical source once and reuses it for duplicates", async () => {
    const h = harness();
    await processPlan(
      request([image("a", "same"), image("b", "same")]),
      h.deps,
    );
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
    const h = harness({}, failing);
    await processPlan(request([image("a", "aa")]), h.deps);
    const result = (
      h.posts.at(-1)!.event as {
        result: { ok: boolean; error: { code: string }[] };
      }
    ).result;
    expect(result.ok).toBe(false);
    expect(result.error[0]!.code).toBe(ISSUE_CODES.imageDecodeFailed);
  });

  it("collapses to a blocker when the markdown transform fails", async () => {
    const h = harness({
      transformMarkdown: (async () =>
        err(
          createIssue(ISSUE_CODES.invalidMdx),
        )) as ProcessPlanDeps["transformMarkdown"],
    });
    await processPlan(request([image("a", "aa")]), h.deps);
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

  it("fails closed with PLAN_BUDGET_EXHAUSTED when the deadline has passed", async () => {
    const h = harness({ now: () => 700_000 });
    await processPlan(request([image("a", "aa")]), h.deps);
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
    images: readonly WorkerImageInput[],
  ): Promise<string[]> => {
    const order: string[] = [];
    const transform: ImageCodec["transform"] = async () => {
      order.push("codec.transform");
      return ok({
        decodedMime: "image/png" as const,
        width: 2,
        height: 2,
        bytes: Uint8Array.of(9, 9).buffer,
      });
    };
    const h = harness(
      {
        transformMarkdown: (async () => {
          order.push("markdown");
          return ok(markdownResult);
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
      await interleaving([image("a", "same"), image("b", "same")]),
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
