import type { Sha256Digest } from "../contracts/export-plan";
import {
  createIssue,
  ISSUE_CODES,
  type BlockerIssue,
  type MdxRelayIssue,
  type WarningIssue,
} from "../contracts/issues";
import { mdxRelayErr, mdxRelayOk } from "../contracts/result";
import type {
  WorkerCompletion,
  WorkerImageOutput,
  WorkerProcessRequest,
  WorkerWireEvent,
} from "../contracts/worker-protocol";
import type { ImageCodec } from "../images/image-codec";
import type { transformMarkdown } from "../markdown/transform";
import type { PortableProfileV1 } from "../profiles/profile-schema";

/** Injected collaborators so the worker core is unit-testable without a real Worker. */
export interface ProcessPlanDeps {
  readonly codec: ImageCodec;
  /** Hashes output bytes to the canonical `sha256:<hex>` digest form. */
  readonly hash: (bytes: ArrayBuffer) => Promise<Sha256Digest>;
  readonly transformMarkdown: typeof transformMarkdown;
  /** Posts a wire event to the parent, transferring any listed buffers. */
  readonly post: (
    event: WorkerWireEvent,
    transfer?: readonly Transferable[],
  ) => void;
  /** Wall clock in epoch milliseconds; injected for deterministic budget tests. */
  readonly now: () => number;
}

const parseProfile = (snapshot: string): PortableProfileV1 | undefined => {
  try {
    return JSON.parse(snapshot) as PortableProfileV1;
  } catch {
    return undefined;
  }
};

const blockerResult = (issues: readonly [BlockerIssue, ...MdxRelayIssue[]]) =>
  mdxRelayErr(issues as [BlockerIssue, ...MdxRelayIssue[]]);

/**
 * Runs one sealed processing plan inside the worker: generates the MDX, then
 * transforms each canonical image sequentially with per-source dedupe, emitting
 * started/progress/completed wire events. Every blocker collapses the plan to a
 * single blocker-first error result; success transfers all output buffers.
 *
 *   started -> progress* -> completed(ok | blocker-first error)
 *
 * Cooperative budget checks fail closed between images; the parent enforces the
 * hard wall-clock ceiling by terminating a worker that overruns.
 */
export async function processPlan(
  request: WorkerProcessRequest,
  deps: ProcessPlanDeps,
): Promise<void> {
  const { generationToken } = request;
  const totalImages = request.images.length;
  deps.post({ type: "started", generationToken, imageCount: totalImages });

  const profile = parseProfile(request.profileSnapshot);
  if (!profile) {
    deps.post({
      type: "completed",
      generationToken,
      result: blockerResult([createIssue(ISSUE_CODES.invalidProfile)]),
    });
    return;
  }

  const noteText = new TextDecoder().decode(request.sourceNote.bytes);
  const transformed = await deps.transformMarkdown(noteText, profile);
  if (!transformed.ok) {
    deps.post({
      type: "completed",
      generationToken,
      result: blockerResult([transformed.error as BlockerIssue]),
    });
    return;
  }
  const markdown = transformed.value;

  const transfer = new Set<Transferable>();
  const transformedImages: WorkerImageOutput[] = [];
  // Decode/transform each unique source once; reuse the output for repeats.
  const bySource = new Map<Sha256Digest, WorkerImageOutput>();

  for (let index = 0; index < totalImages; index += 1) {
    const image = request.images[index]!;
    const elapsedMs = deps.now() - request.planStartedAtMs;
    const remainingPlanBudgetMs = Math.max(
      0,
      request.planDeadlineMs - deps.now(),
    );
    deps.post({
      type: "progress",
      generationToken,
      sourceId: image.sourceId,
      imageIndex: index,
      completedImages: index,
      totalImages,
      elapsedMs,
      remainingPlanBudgetMs,
    });

    if (deps.now() >= request.planDeadlineMs) {
      deps.post({
        type: "completed",
        generationToken,
        result: blockerResult([createIssue(ISSUE_CODES.planBudgetExhausted)]),
      });
      return;
    }

    const cached = bySource.get(image.contentSha256);
    if (cached) {
      transformedImages.push({ ...cached, sourceId: image.sourceId });
      continue;
    }

    const result = await deps.codec.transform(image.bytes, {
      maxDimension: profile.images.maxDimension,
      webpQuality: profile.images.webpQuality,
    });
    if (!result.ok) {
      deps.post({
        type: "completed",
        generationToken,
        result: blockerResult([result.error as BlockerIssue]),
      });
      return;
    }

    const output: WorkerImageOutput = {
      sourceId: image.sourceId,
      decodedMime: result.value.decodedMime,
      width: result.value.width,
      height: result.value.height,
      contentSha256: await deps.hash(result.value.bytes),
      byteLength: result.value.bytes.byteLength,
      bytes: result.value.bytes,
    };
    transfer.add(result.value.bytes);
    bySource.set(image.contentSha256, output);
    transformedImages.push(output);
  }

  const mdxBytes = new TextEncoder().encode(markdown.mdx).buffer;
  transfer.add(mdxBytes);
  const warnings = markdown.issues.filter(
    (issue): issue is WarningIssue => issue.severity === "warning",
  );
  const completion: WorkerCompletion = {
    generatedMdx: {
      contentSha256: await deps.hash(mdxBytes),
      byteLength: mdxBytes.byteLength,
      bytes: mdxBytes,
    },
    transformedImages,
    warnings,
  };

  deps.post(
    {
      type: "completed",
      generationToken,
      result: mdxRelayOk(completion),
    },
    [...transfer],
  );
}
