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
 *                                            plan + per-image budget timers
 *                                            decode+verify -> brand event
 *                                            every terminal -> terminate()
 *
 * The client owns one generation. It never trusts a structured-cloned wire
 * event: bytes, hashes, and severity channels are re-verified before the event
 * is branded a DecodedWorkerEvent. Timeout, cancellation, or a crash yields a
 * parent-synthesized blocked event. Events whose generation token does not
 * match the active request are discarded. Because each run owns a worker
 * carrying an embedded WASM bundle, every terminal path releases it exactly
 * once through the single `settle` funnel.
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

      // Sequential-emission state. The worker's contract is exactly one
      // `started`, then one `progress` per image in ascending index order, so
      // repeats, gaps, and out-of-order events are all detectable here.
      const totalImages = request.images.length;
      let startedSeen = false;
      let nextImageIndex = 0;

      worker.onmessage = (message: MessageEvent): void => {
        if (settled) return;
        const data: unknown = message.data;
        // Wire data that is not even an object cannot be matched to a
        // generation, so it is malformed rather than merely stale.
        if (!isRecord(data)) return failClosed();
        // Stale generation and late events are silently discarded.
        if (data.generationToken !== generationToken) return;

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

        if (data.type === "progress") {
          const planWindowMs = Math.max(
            0,
            request.planDeadlineMs - request.planStartedAtMs,
          );
          const expected = request.images[nextImageIndex];
          if (
            !startedSeen ||
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
          clearTimers();
          void this.decodeCompletion(request, data.result).then((result) => {
            settle(
              result
                ? (Object.freeze({
                    type: "completed",
                    generationToken,
                    result,
                  }) as DecodedWorkerEvent)
                : this.malformed(generationToken, activeSourceId),
            );
          });
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
      value.width * value.height > MDX_RELAY_LIMITS.decodedImagePixels ||
      !isPositiveInteger(value.byteLength) ||
      !(await this.verifyOutputBytes(value as never))
    )
      return undefined;
    return Object.freeze({
      sourceId: expectedSourceId,
      decodedMime: value.decodedMime as WorkerImageOutput["decodedMime"],
      width: value.width,
      height: value.height,
      contentSha256: value.contentSha256 as Sha256Digest,
      byteLength: value.byteLength,
      bytes: value.bytes as ArrayBuffer,
    });
  }

  /**
   * Reconstructs a trusted MdxRelayResult from an untrusted structured-cloned
   * completion payload, re-verifying byte lengths, hashes, and severity
   * channels. Returns undefined for any malformed payload.
   */
  private async decodeCompletion(
    request: WorkerProcessRequest,
    value: unknown,
  ): Promise<MdxRelayResult<WorkerCompletion> | undefined> {
    if (!isRecord(value)) return undefined;
    if (value.ok === false) {
      if (!hasExactKeys(value, ["ok", "error"])) return undefined;
      const issues = this.decodeErrorIssues(value.error);
      return issues ? mdxRelayErr(issues) : undefined;
    }
    if (value.ok !== true || !hasExactKeys(value, ["ok", "value"]))
      return undefined;
    if (!isRecord(value.value) || !hasExactKeys(value.value, COMPLETION_KEYS))
      return undefined;
    const completion = value.value;
    const generatedMdx = await this.decodeGeneratedMdx(completion.generatedMdx);
    // One output per canonical input, in request order: duplicate embeds each
    // keep their own entry, so a short, padded, or reordered list is malformed.
    if (
      !generatedMdx ||
      !Array.isArray(completion.transformedImages) ||
      completion.transformedImages.length !== request.images.length
    )
      return undefined;
    const transformedImages: WorkerImageOutput[] = [];
    for (const [index, raw] of completion.transformedImages.entries()) {
      const image = await this.decodeImage(
        raw,
        request.images[index]!.sourceId,
      );
      if (!image) return undefined;
      transformedImages.push(image);
    }
    if (
      !Array.isArray(completion.warnings) ||
      !completion.warnings.every(
        (issue): issue is WarningIssue =>
          isMdxRelayIssue(issue) && issue.severity === "warning",
      )
    )
      return undefined;
    return mdxRelayOk<WorkerCompletion>({
      generatedMdx,
      transformedImages,
      warnings: completion.warnings,
    });
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
