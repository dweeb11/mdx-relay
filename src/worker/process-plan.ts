import type { Sha256Digest } from "../contracts/export-plan";
import {
  createIssue,
  ISSUE_CODES,
  type BlockerIssue,
  type MdxRelayIssue,
  type WarningIssue,
} from "../contracts/issues";
import { mdxRelayErr, mdxRelayOk, type Result } from "../contracts/result";
import type {
  WorkerCompletion,
  WorkerImageOutput,
  WorkerProcessRequest,
  WorkerWireEvent,
} from "../contracts/worker-protocol";
import type { ImageCodec } from "../images/image-codec";
import type { ImageHeader } from "../images/image-metadata";
import { MDX_RELAY_LIMITS } from "../core/limits";
import type { transformMarkdown } from "../markdown/transform";
import { parsePortableProfile } from "../profiles/parse-portable-profile";
import type { PortableProfileV1 } from "../profiles/profile-schema";

/** Injected collaborators so the worker core is unit-testable without a real Worker. */
export interface ProcessPlanDeps {
  readonly codec: ImageCodec;
  /**
   * Bounded container-header probe returning the raw decoded size a source will
   * cost. The cumulative decoded-work cap is a cap on work performed, so the
   * cost must be known before the decode that would spend it.
   */
  readonly readImageHeader: (
    bytes: Uint8Array,
  ) => Result<ImageHeader, MdxRelayIssue>;
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

/**
 * Parse then validate against the canonical portable-profile schema. Any JSON
 * that is not an exact `PortableProfileV1` fails closed as undefined so the
 * worker can emit `INVALID_PROFILE` instead of throwing on missing fields.
 */
const parseProfile = (snapshot: string): PortableProfileV1 | undefined => {
  try {
    return parsePortableProfile(JSON.parse(snapshot) as unknown);
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
 * hard wall-clock ceiling by terminating a worker that overruns. Cumulative
 * decoded work is charged once per canonical source, from a bounded header
 * probe taken *before* the decode: a source that would push the plan past the
 * limit is refused without doing its work, and a decoder that disagrees with
 * the header it was charged for fails the plan closed. The parent re-verifies
 * the same budget from the reported decoded dimensions and never trusts this
 * accounting.
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
  // Cumulative decoded work for the plan, counted once per canonical source.
  let decodedPixels = 0;

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
      // A repeat embed of a canonical source costs no decode, so it spends
      // none of the cumulative budget.
      transformedImages.push({ ...cached, sourceId: image.sourceId });
      continue;
    }

    // What this source will cost, read from its container header alone. No
    // decode or transform runs until the charge is known and affordable.
    const header = deps.readImageHeader(new Uint8Array(image.bytes));
    if (!header.ok) {
      deps.post({
        type: "completed",
        generationToken,
        result: blockerResult([header.error as BlockerIssue]),
      });
      return;
    }
    const { width, height } = header.value;
    // Bounding each edge first keeps the area a safe integer, so a header
    // declaring four-billion-pixel edges cannot overflow the comparison.
    if (
      width > MDX_RELAY_LIMITS.decodedImagePixels ||
      height > MDX_RELAY_LIMITS.decodedImagePixels ||
      width * height > MDX_RELAY_LIMITS.decodedImagePixels
    ) {
      deps.post({
        type: "completed",
        generationToken,
        result: blockerResult([createIssue(ISSUE_CODES.decodedImageTooLarge)]),
      });
      return;
    }
    // The hard cap: a source that would push the plan past the cumulative limit
    // is refused before its decode begins, so the work is never performed.
    if (
      decodedPixels + width * height >
      MDX_RELAY_LIMITS.cumulativeDecodedPixels
    ) {
      deps.post({
        type: "completed",
        generationToken,
        result: blockerResult([
          createIssue(ISSUE_CODES.decodedWorkLimitExceeded),
        ]),
      });
      return;
    }
    decodedPixels += width * height;

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
    // The budget was charged on the header's word. A decoder that disagrees
    // means the charge was wrong, so the plan fails closed rather than let an
    // under-charged decode stand.
    if (
      result.value.decodedWidth !== width ||
      result.value.decodedHeight !== height
    ) {
      deps.post({
        type: "completed",
        generationToken,
        result: blockerResult([createIssue(ISSUE_CODES.imageDecodeFailed)]),
      });
      return;
    }

    const output: WorkerImageOutput = {
      sourceId: image.sourceId,
      decodedMime: result.value.decodedMime,
      decodedWidth: result.value.decodedWidth,
      decodedHeight: result.value.decodedHeight,
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
