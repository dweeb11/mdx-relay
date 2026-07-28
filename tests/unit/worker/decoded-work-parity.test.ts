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
import { ok } from "../../../src/contracts/result";
import type {
  WorkerImageInput,
  WorkerProcessRequest,
  WorkerWireEvent,
} from "../../../src/contracts/worker-protocol";
import type { MarkdownTransformResult } from "../../../src/markdown/transform";
import { DPW_MIND_NET_V1 } from "../../../src/profiles/builtins/dpw-mind-net-v1";
import {
  processPlan,
  type ProcessPlanDeps,
} from "../../../src/worker/process-plan";

import {
  PARITY_CASES,
  uniqueSources,
  type ParityEmbed,
} from "./decoded-work-cases";

const token = "generation-1" as GenerationToken;
const digest = (value: string): Sha256Digest =>
  `sha256:${value}` as Sha256Digest;
const label = (value: string): SafePathLabel =>
  toSafePathLabel(value) as SafePathLabel;

const markdownResult: MarkdownTransformResult = {
  slug: "example",
  mdx: "# hi\n",
  images: [],
  issues: [createIssue(ISSUE_CODES.summaryMissing)],
};

const inputFor = (embed: ParityEmbed, index: number): WorkerImageInput => ({
  sourceId: `img-${String(index)}`,
  safePathLabel: label(`assets/img-${String(index)}.png`),
  contentSha256: digest(embed.key),
  byteLength: 4,
  bytes: Uint8Array.of(1, 2, 3, 4).buffer,
});

const requestFor = (
  embeds: readonly ParityEmbed[],
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
  images: embeds.map(inputFor),
  ...overrides,
});

/**
 * Drives `processPlan` over a case.
 *
 * The worker probes and transforms unique sources in first-appearance order, so
 * the header probe and the fake codec both walk that same sequence. The codec
 * must echo the header's dimensions or the worker fails the plan closed on the
 * charge-disagreement check, which would mask the budget verdict under test.
 */
const runWorker = async (embeds: readonly ParityEmbed[]) => {
  const sequence = uniqueSources(embeds);
  let probes = 0;
  let decodes = 0;
  const posts: WorkerWireEvent[] = [];
  const transform = vi.fn(async () => {
    const current = sequence[decodes]!;
    decodes += 1;
    return ok({
      decodedMime: "image/png" as const,
      decodedWidth: current.width,
      decodedHeight: current.height,
      width: 2,
      height: 2,
      bytes: Uint8Array.of(9, 9).buffer,
    });
  });
  const deps: ProcessPlanDeps = {
    codec: { transform },
    readImageHeader: () => {
      const current = sequence[probes]!;
      probes += 1;
      return ok({
        mime: "image/png" as const,
        width: current.width,
        height: current.height,
      });
    },
    hash: async (bytes) => digest(`h${String(bytes.byteLength)}`),
    transformMarkdown: (async () =>
      ok(markdownResult)) as ProcessPlanDeps["transformMarkdown"],
    post: (event) => posts.push(event),
    now: () => 2_000,
  };
  await processPlan(requestFor(embeds), deps);
  const terminal = posts.at(-1)!;
  return { terminal, transformCalls: transform.mock.calls.length };
};

/**
 * The wire event carries `result: unknown` on purpose -- it is the untrusted
 * structured-clone payload. Narrowing it here mirrors the existing pattern in
 * `process-plan.test.ts`, and keeps the test honest about what the boundary
 * actually hands back.
 */
const refusedOnBudget = (terminal: WorkerWireEvent): boolean => {
  if (terminal.type !== "completed") return false;
  const result = terminal.result as {
    ok: boolean;
    error?: { code: string }[];
  };
  return (
    !result.ok &&
    result.error?.[0]?.code === ISSUE_CODES.decodedWorkLimitExceeded
  );
};

/**
 * P3 -- the worker's prefix charging must agree with the parent's whole-list
 * charging on every case. The client half of this table lives in
 * `processing-client.test.ts`, driven from the same source.
 */
describe("decoded-work parity: worker side of the shared case table", () => {
  for (const parityCase of PARITY_CASES) {
    it(`${parityCase.refused ? "refuses" : "accepts"} ${parityCase.name}`, async () => {
      const { terminal } = await runWorker(parityCase.embeds);
      expect(refusedOnBudget(terminal)).toBe(parityCase.refused);
    });
  }
});

describe("decoded-work parity: worker input construction", () => {
  /**
   * P1 -- dedupe keys on the parent-owned request hash, never on anything the
   * codec reports. Two embeds share one request hash while the codec hands back
   * a different output for each; the second embed must still cost no decode.
   */
  it("dedupes on the request hash even when outputs differ", async () => {
    const embeds: ParityEmbed[] = [
      { key: "same-source", width: 10, height: 10 },
      { key: "same-source", width: 10, height: 10 },
    ];
    const { terminal, transformCalls } = await runWorker(embeds);
    expect(terminal.type).toBe("completed");
    // One canonical source means one decode, however many times it is embedded.
    expect(transformCalls).toBe(1);
  });

  /**
   * P2 -- the worker charges the raw decoded size the header reports, not the
   * resized output size. Eleven sources at 40 MP decoded resize to 2x2 outputs;
   * charging outputs would total 44 pixels and wrongly accept the plan.
   */
  it("charges header dimensions, not resized output dimensions", async () => {
    const embeds = Array.from({ length: 11 }, (_, i) => ({
      key: `source-${String(i)}`,
      width: 10_000,
      height: 4_000,
    }));
    const { terminal } = await runWorker(embeds);
    expect(refusedOnBudget(terminal)).toBe(true);
  });

  /**
   * The prefix must include the source being charged. A slice short by one
   * leaves the last source uncharged, which shows up as a plan that should
   * refuse at exactly one source over the cap but does not.
   */
  it("charges the current source, not just its predecessors", async () => {
    const tenAtCap = Array.from({ length: 10 }, (_, i) => ({
      key: `source-${String(i)}`,
      width: 10_000,
      height: 4_000,
    }));
    const accepted = await runWorker(tenAtCap);
    expect(refusedOnBudget(accepted.terminal)).toBe(false);

    const oneOver = [...tenAtCap, { key: "extra", width: 1, height: 1 }];
    const refused = await runWorker(oneOver);
    expect(refusedOnBudget(refused.terminal)).toBe(true);
  });
});
