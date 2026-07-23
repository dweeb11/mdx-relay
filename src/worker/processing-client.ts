import type { Sha256Digest } from "../contracts/export-plan";
import {
  createIssue,
  isMdxRelayIssue,
  ISSUE_CODES,
  type BlockerIssue,
  type MdxRelayIssue,
  type WarningIssue,
} from "../contracts/issues";
import {
  mdxRelayErr,
  mdxRelayOk,
  type MdxRelayResult,
} from "../contracts/result";
import { MDX_RELAY_LIMITS } from "../core/limits";
import type {
  DecodedWorkerEvent,
  WorkerCompletion,
  WorkerGeneratedMdxOutput,
  WorkerImageOutput,
  WorkerProcessRequest,
  WorkerRequest,
  WorkerWireEvent,
} from "../contracts/worker-protocol";

/**
 *   process-plan.ts (worker)                 processing-client.ts (parent)
 *   ------------------------                 -----------------------------
 *   started/progress/completed  --wire-->    generation-token gate
 *                                            drop stale/late events
 *                                            started -> progress* -> terminal
 *                                            plan + per-image budget timers
 *                                            decode+verify -> brand event
 *                                            every terminal -> terminate()
 *
 * The client owns one generation. It never trusts a structured-cloned wire
 * event: bytes, hashes, and severity channels are re-verified before the event
 * is branded a DecodedWorkerEvent. The emission order is enforced rather than
 * assumed -- a success completion is trusted only after `started` and every
 * expected image progress event, because `progress` is what arms the per-image
 * clock. Timeout, cancellation, a crash, or an unverifiable digest yields a
 * parent-synthesized blocked event; the plan deadline stays armed through
 * completion verification so a stalled digest cannot hang the run. Events whose
 * generation token does not match the active request are discarded. Because
 * each run owns a worker carrying an embedded WASM bundle, every terminal path
 * releases it exactly once through the single `settle` funnel.
 */

/** The subset of the Worker interface the client depends on. */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
  /** Fires when a posted message cannot be deserialized; always fail-closed. */
  onmessageerror: ((event: unknown) => void) | null;
}

export interface ProcessingClientOptions {
  readonly createWorker: () => WorkerLike;
  readonly hash: (bytes: ArrayBuffer) => Promise<Sha256Digest>;
  readonly now: () => number;
  readonly setTimer: (callback: () => void, delayMs: number) => number;
  readonly clearTimer: (handle: number) => void;
}

const SUPPORTED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

const PROGRESS_KEYS = [
  "type",
  "generationToken",
  "sourceId",
  "imageIndex",
  "completedImages",
  "totalImages",
  "elapsedMs",
  "remainingPlanBudgetMs",
] as const;
const GENERATED_MDX_KEYS = ["contentSha256", "byteLength", "bytes"] as const;
const IMAGE_OUTPUT_KEYS = [
  "sourceId",
  "decodedMime",
  "decodedWidth",
  "decodedHeight",
  "width",
  "height",
  "contentSha256",
  "byteLength",
  "bytes",
] as const;
const COMPLETION_KEYS = [
  "generatedMdx",
  "transformedImages",
  "warnings",
] as const;

const isArrayBuffer = (value: unknown): value is ArrayBuffer =>
  value instanceof ArrayBuffer;
const isNonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isDigest = (value: unknown): value is string =>
  typeof value === "string" && SHA256_DIGEST.test(value);

/**
 * Exact-shape gate: the payload must carry these own keys and nothing else.
 * Unknown extras are rejected rather than ignored, so a hostile worker cannot
 * smuggle fields past the decoder and into host state or the UI.
 */
const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));

const brand = (event: WorkerWireEvent): DecodedWorkerEvent =>
  Object.freeze(event) as DecodedWorkerEvent;

/**
 * Completion decoding has three outcomes, not two: a trustworthy result, an
 * unusable payload, and a payload that decodes cleanly but breaks the plan's
 * cumulative decoded-work budget -- which is a truthful budget blocker, not a
 * malformed response.
 */
type DecodedCompletion =
  | {
      readonly kind: "completed";
      readonly result: MdxRelayResult<WorkerCompletion>;
    }
  | { readonly kind: "malformed" }
  | { readonly kind: "decoded-work-exceeded" };

const MALFORMED: DecodedCompletion = Object.freeze({ kind: "malformed" });

export class ProcessingClient {
  /** Cancels the in-flight run, if any; cleared when a run settles. */
  private cancelActive: (() => void) | undefined;

  constructor(private readonly options: ProcessingClientOptions) {}

  /**
   * Cancels the active generation: posts cancel-generation, terminates the
   * worker, and settles the in-flight run with a cancelled event. No-op when
   * nothing is running.
   */
  cancel(): void {
    this.cancelActive?.();
  }

  /**
   * Drives one plan to a terminal decoded event. started/progress events are
   * delivered to onProgress; the returned promise resolves with the branded
   * completed, blocked, or cancelled event. Never rejects.
   */
  process(
    request: WorkerProcessRequest,
    onProgress?: (event: DecodedWorkerEvent) => void,
  ): Promise<DecodedWorkerEvent> {
    const { generationToken } = request;
    const worker = this.options.createWorker();
    return new Promise<DecodedWorkerEvent>((resolve) => {
      let settled = false;
      let activeSourceId: string | undefined;
      let planTimer: number | undefined;
      let imageTimer: number | undefined;

      const clearImageTimer = (): void => {
        if (imageTimer !== undefined) {
          this.options.clearTimer(imageTimer);
          imageTimer = undefined;
        }
      };
      const clearTimers = (): void => {
        clearImageTimer();
        if (planTimer !== undefined) {
          this.options.clearTimer(planTimer);
          planTimer = undefined;
        }
      };

      /**
       * The single terminal funnel. Every path -- verified completion, a
       * worker-returned blocked/cancelled event, a malformed response, a crash,
       * a messageerror, cancellation, and either timeout -- releases the
       * per-run worker exactly once. The worker owns an embedded WASM bundle,
       * so leaking it on ordinary success is a real resource leak.
       */
      const settle = (event: DecodedWorkerEvent): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        // Only disown the shared cancel hook if it is still this run's.
        if (this.cancelActive === cancelThisRun) this.cancelActive = undefined;
        worker.terminate();
        resolve(event);
      };

      const blockWith = (issue: BlockerIssue): void => {
        settle(
          brand({
            type: "blocked",
            generationToken,
            ...(activeSourceId !== undefined ? { activeSourceId } : {}),
            issues: [issue],
          }),
        );
      };

      const cancelThisRun = (): void => {
        if (settled) return;
        worker.postMessage({ type: "cancel-generation", generationToken });
        settle(brand({ type: "cancelled", generationToken }));
      };

      const armImageTimer = (): void => {
        clearImageTimer();
        imageTimer = this.options.setTimer(
          () => blockWith(createIssue(ISSUE_CODES.workerImageTimeout)),
          request.imageTimeoutMs,
        );
      };

      worker.onerror = (): void => {
        blockWith(createIssue(ISSUE_CODES.workerCrashed));
      };

      // A message that cannot be deserialized is unusable wire data, so it
      // fails closed on the same redacted channel as any malformed response.
      worker.onmessageerror = (): void => {
        settle(this.malformed(generationToken, activeSourceId));
      };

      const failClosed = (): void => {
        settle(this.malformed(generationToken, activeSourceId));
      };

      // Sequential-emission state for the frozen
      // `started -> progress* -> terminal` order: exactly one `started`, then
      // one `progress` per image in ascending index order, then one terminal
      // event. Repeats, gaps, out-of-order events, and anything following the
      // terminal are all detectable here.
      const totalImages = request.images.length;
      let startedSeen = false;
      let nextImageIndex = 0;
      let terminalSeen = false;

      worker.onmessage = (message: MessageEvent): void => {
        if (settled) return;
        const data: unknown = message.data;
        // Wire data that is not even an object cannot be matched to a
        // generation, so it is malformed rather than merely stale.
        if (!isRecord(data)) return failClosed();
        // Stale generation and late events are silently discarded.
        if (data.generationToken !== generationToken) return;
        // A terminal event was accepted; verification may still be running, but
        // the protocol is over, so anything further is off-contract.
        if (terminalSeen) return failClosed();

        if (data.type === "started") {
          if (
            startedSeen ||
            nextImageIndex > 0 ||
            !hasExactKeys(data, ["type", "generationToken", "imageCount"]) ||
            data.imageCount !== totalImages
          )
            return failClosed();
          startedSeen = true;
          // Rebuilt from parent-owned values: no wire field is reflected on.
          // `started` precedes the Markdown transform and carries no image, so
          // it must not start the per-image clock. Until the first `progress`
          // the plan budget is the only clock that can expire.
          onProgress?.(
            brand({
              type: "started",
              generationToken,
              imageCount: totalImages,
            }),
          );
          return;
        }

        // Every remaining arm belongs after `started`. A worker that skips it
        // skips the whole sequence the per-image clock is armed from, so the
        // run fails closed instead of trusting an unmeasured plan.
        if (!startedSeen) return failClosed();

        if (data.type === "progress") {
          const planWindowMs = Math.max(
            0,
            request.planDeadlineMs - request.planStartedAtMs,
          );
          const expected = request.images[nextImageIndex];
          if (
            expected === undefined ||
            !hasExactKeys(data, PROGRESS_KEYS) ||
            data.totalImages !== totalImages ||
            data.imageIndex !== nextImageIndex ||
            data.completedImages !== nextImageIndex ||
            data.sourceId !== expected.sourceId ||
            !isNonnegativeInteger(data.elapsedMs) ||
            !isNonnegativeInteger(data.remainingPlanBudgetMs) ||
            data.remainingPlanBudgetMs > planWindowMs
          )
            return failClosed();
          const { elapsedMs, remainingPlanBudgetMs } = data;
          activeSourceId = expected.sourceId;
          nextImageIndex += 1;
          // Emitted immediately before this image's decode/encode: the one
          // wire signal that marks image-work start.
          armImageTimer();
          onProgress?.(
            brand({
              type: "progress",
              generationToken,
              sourceId: expected.sourceId,
              imageIndex: data.imageIndex,
              completedImages: data.completedImages,
              totalImages,
              elapsedMs,
              remainingPlanBudgetMs,
            }),
          );
          return;
        }

        if (data.type === "cancelled") {
          if (!hasExactKeys(data, ["type", "generationToken"]))
            return failClosed();
          settle(brand({ type: "cancelled", generationToken }));
          return;
        }

        if (data.type === "blocked") {
          const optional =
            "activeSourceId" in data ? (["activeSourceId"] as const) : [];
          const issues = this.decodeBlockerIssues(data.issues);
          if (
            !hasExactKeys(data, [
              "type",
              "generationToken",
              "issues",
              ...optional,
            ]) ||
            (optional.length > 0 &&
              !request.images.some(
                (candidate) => candidate.sourceId === data.activeSourceId,
              )) ||
            !issues
          )
            return failClosed();
          // The parent owns the active-source diagnostic, not the wire event.
          settle(
            brand({
              type: "blocked",
              generationToken,
              ...(activeSourceId !== undefined ? { activeSourceId } : {}),
              issues,
            }),
          );
          return;
        }

        if (data.type === "completed") {
          if (!hasExactKeys(data, ["type", "generationToken", "result"]))
            return failClosed();
          // Only the success arm carries output the host will trust, and it is
          // trustworthy only if every expected image announced its own work
          // first -- otherwise the worker decoded images no per-image timer
          // ever governed. An error arm legitimately stops at the image that
          // failed, so `progress*` stays zero-or-more there.
          if (
            isRecord(data.result) &&
            data.result.ok === true &&
            nextImageIndex !== totalImages
          )
            return failClosed();
          terminalSeen = true;
          // Image work is over, so the per-image clock stops. The plan deadline
          // deliberately stays armed: parent-side hash verification is async
          // and can stall, and this is the hard bound that ends the run and
          // releases the worker when it does.
          clearImageTimer();
          void this.decodeCompletion(request, data.result).then(
            (decoded) => {
              if (decoded.kind === "completed") {
                settle(
                  Object.freeze({
                    type: "completed",
                    generationToken,
                    result: decoded.result,
                  }) as DecodedWorkerEvent,
                );
                return;
              }
              if (decoded.kind === "decoded-work-exceeded") {
                blockWith(createIssue(ISSUE_CODES.decodedWorkLimitExceeded));
                return;
              }
              settle(this.malformed(generationToken, activeSourceId));
            },
            // A digest that throws leaves the response unverifiable. process()
            // never rejects, so this settles once on the redacted channel and
            // releases the worker rather than escaping as an unhandled
            // rejection.
            () => {
              settle(this.malformed(generationToken, activeSourceId));
            },
          );
          return;
        }

        // Any other `type` is outside the protocol and fails closed.
        return failClosed();
      };

      this.cancelActive = cancelThisRun;

      const planDelay = Math.max(
        0,
        request.planDeadlineMs - this.options.now(),
      );
      planTimer = this.options.setTimer(
        () => blockWith(createIssue(ISSUE_CODES.planBudgetExhausted)),
        planDelay,
      );

      // Inputs may alias one ArrayBuffer (a note and an image, or two images
      // resolved to the same source). A transfer list naming the same buffer
      // twice is a structured-clone DataCloneError, so dedupe by identity.
      const transfer: Transferable[] = [
        ...new Set<Transferable>([
          request.sourceNote.bytes,
          ...request.images.map((image) => image.bytes),
        ]),
      ];
      try {
        worker.postMessage(request, transfer);
      } catch {
        // A detached or otherwise untransferable input cannot be handed to the
        // worker. process() never rejects, so fail closed with one redacted
        // terminal blocker; settle() releases the worker it just created.
        blockWith(createIssue(ISSUE_CODES.workerCrashed));
      }
    });
  }

  private malformed(
    generationToken: WorkerProcessRequest["generationToken"],
    activeSourceId: string | undefined,
  ): DecodedWorkerEvent {
    return brand({
      type: "blocked",
      generationToken,
      ...(activeSourceId !== undefined ? { activeSourceId } : {}),
      issues: [createIssue(ISSUE_CODES.malformedWorkerResponse)],
    });
  }

  private decodeBlockerIssues(
    value: unknown,
  ): readonly [BlockerIssue, ...BlockerIssue[]] | undefined {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    if (
      !value.every(
        (issue) => isMdxRelayIssue(issue) && issue.severity === "blocker",
      )
    )
      return undefined;
    return value as [BlockerIssue, ...BlockerIssue[]];
  }

  /**
   * Byte-channel check shared by every output: a canonical digest, a byte
   * length that is a safe integer within the locked per-output ceiling, a real
   * ArrayBuffer of exactly that length, and a hash that re-computes.
   */
  private async verifyOutputBytes(output: {
    contentSha256: unknown;
    byteLength: unknown;
    bytes: unknown;
  }): Promise<boolean> {
    if (
      !isDigest(output.contentSha256) ||
      !isNonnegativeInteger(output.byteLength) ||
      output.byteLength > MDX_RELAY_LIMITS.sealedOutputBytes ||
      !isArrayBuffer(output.bytes) ||
      output.bytes.byteLength !== output.byteLength
    )
      return false;
    return (await this.options.hash(output.bytes)) === output.contentSha256;
  }

  private async decodeGeneratedMdx(
    value: unknown,
  ): Promise<WorkerGeneratedMdxOutput | undefined> {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, GENERATED_MDX_KEYS) ||
      !(await this.verifyOutputBytes(value as never))
    )
      return undefined;
    return Object.freeze({
      contentSha256: value.contentSha256 as Sha256Digest,
      byteLength: value.byteLength as number,
      bytes: value.bytes as ArrayBuffer,
    });
  }

  /**
   * Dimensions are a trust boundary, not a display detail: downstream sealing
   * sizes buffers from them. They must be positive safe integers whose product
   * stays inside the locked per-image decoded-pixel ceiling, so neither a zero
   * nor an absurd forged dimension can cross into host state.
   */
  private async decodeImage(
    value: unknown,
    expectedSourceId: string,
  ): Promise<WorkerImageOutput | undefined> {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, IMAGE_OUTPUT_KEYS) ||
      value.sourceId !== expectedSourceId ||
      typeof value.decodedMime !== "string" ||
      !SUPPORTED_MIME.has(value.decodedMime) ||
      !isPositiveInteger(value.width) ||
      !isPositiveInteger(value.height) ||
      !isPositiveInteger(value.decodedWidth) ||
      !isPositiveInteger(value.decodedHeight) ||
      value.decodedWidth * value.decodedHeight >
        MDX_RELAY_LIMITS.decodedImagePixels ||
      // The codec never upscales. Orientation may transpose the axes, so bound
      // each output edge by the longer decoded edge and the area by the whole.
      value.width * value.height > value.decodedWidth * value.decodedHeight ||
      Math.max(value.width, value.height) >
        Math.max(value.decodedWidth, value.decodedHeight) ||
      !isPositiveInteger(value.byteLength) ||
      !(await this.verifyOutputBytes(value as never))
    )
      return undefined;
    return Object.freeze({
      sourceId: expectedSourceId,
      decodedMime: value.decodedMime as WorkerImageOutput["decodedMime"],
      decodedWidth: value.decodedWidth,
      decodedHeight: value.decodedHeight,
      width: value.width,
      height: value.height,
      contentSha256: value.contentSha256 as Sha256Digest,
      byteLength: value.byteLength,
      bytes: value.bytes as ArrayBuffer,
    });
  }

  /**
   * Re-derives the plan's cumulative decoded work from the reported decoded
   * dimensions, charging each canonical source exactly once -- the same dedupe
   * the worker applies, recomputed here from the request's own content hashes
   * so the worker's accounting is never taken on trust. Repeat embeds of one
   * source must agree on their decoded size, or the report is incoherent.
   *
   * Each product is already bounded by the per-image decoded-pixel limit and
   * the sum short-circuits at the cumulative limit, so the running total stays
   * far inside the safe-integer range.
   *
   * Repeats are compared on their exact decoded edges, not their area: 2x6 and
   * 3x4 are the same twelve pixels but cannot be the same decode.
   */
  private exceedsDecodedWorkBudget(
    request: WorkerProcessRequest,
    images: readonly WorkerImageOutput[],
  ): boolean | undefined {
    const charged = new Map<Sha256Digest, readonly [number, number]>();
    let decodedPixels = 0;
    for (const [index, image] of images.entries()) {
      const { contentSha256 } = request.images[index]!;
      const previous = charged.get(contentSha256);
      if (previous !== undefined) {
        if (
          previous[0] !== image.decodedWidth ||
          previous[1] !== image.decodedHeight
        )
          return undefined;
        continue;
      }
      charged.set(contentSha256, [image.decodedWidth, image.decodedHeight]);
      decodedPixels += image.decodedWidth * image.decodedHeight;
      if (decodedPixels > MDX_RELAY_LIMITS.cumulativeDecodedPixels) return true;
    }
    return false;
  }

  /**
   * Reconstructs a trusted MdxRelayResult from an untrusted structured-cloned
   * completion payload, re-verifying byte lengths, hashes, and severity
   * channels. Returns undefined for any malformed payload.
   */
  private async decodeCompletion(
    request: WorkerProcessRequest,
    value: unknown,
  ): Promise<DecodedCompletion> {
    if (!isRecord(value)) return MALFORMED;
    if (value.ok === false) {
      if (!hasExactKeys(value, ["ok", "error"])) return MALFORMED;
      const issues = this.decodeErrorIssues(value.error);
      return issues
        ? { kind: "completed", result: mdxRelayErr(issues) }
        : MALFORMED;
    }
    if (value.ok !== true || !hasExactKeys(value, ["ok", "value"]))
      return MALFORMED;
    if (!isRecord(value.value) || !hasExactKeys(value.value, COMPLETION_KEYS))
      return MALFORMED;
    const completion = value.value;
    const generatedMdx = await this.decodeGeneratedMdx(completion.generatedMdx);
    // One output per canonical input, in request order: duplicate embeds each
    // keep their own entry, so a short, padded, or reordered list is malformed.
    if (
      !generatedMdx ||
      !Array.isArray(completion.transformedImages) ||
      completion.transformedImages.length !== request.images.length
    )
      return MALFORMED;
    const transformedImages: WorkerImageOutput[] = [];
    for (const [index, raw] of completion.transformedImages.entries()) {
      const image = await this.decodeImage(
        raw,
        request.images[index]!.sourceId,
      );
      if (!image) return MALFORMED;
      transformedImages.push(image);
    }
    if (
      !Array.isArray(completion.warnings) ||
      !completion.warnings.every(
        (issue): issue is WarningIssue =>
          isMdxRelayIssue(issue) && issue.severity === "warning",
      )
    )
      return MALFORMED;
    const exceeded = this.exceedsDecodedWorkBudget(request, transformedImages);
    if (exceeded === undefined) return MALFORMED;
    // A worker that completed past the cumulative budget disagrees with the
    // parent. The parent's independent recount decides, and it fails closed.
    if (exceeded) return { kind: "decoded-work-exceeded" };
    return {
      kind: "completed",
      result: mdxRelayOk<WorkerCompletion>({
        generatedMdx,
        transformedImages,
        warnings: completion.warnings,
      }),
    };
  }

  private decodeErrorIssues(
    value: unknown,
  ): readonly [BlockerIssue, ...MdxRelayIssue[]] | undefined {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    if (!value.every((issue) => isMdxRelayIssue(issue))) return undefined;
    const [first] = value as MdxRelayIssue[];
    if (first === undefined || first.severity !== "blocker") return undefined;
    return value as [BlockerIssue, ...MdxRelayIssue[]];
  }
}
