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

const isArrayBuffer = (value: unknown): value is ArrayBuffer =>
  value instanceof ArrayBuffer;
const isNonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const brand = (event: WorkerWireEvent): DecodedWorkerEvent =>
  event as DecodedWorkerEvent;

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

      worker.onmessage = (message: MessageEvent): void => {
        if (settled) return;
        const data = message.data as WorkerWireEvent | undefined;
        // Stale generation and late events are silently discarded.
        if (!isRecord(data) || data.generationToken !== generationToken) return;

        if (data.type === "started") {
          armImageTimer();
          onProgress?.(brand(data));
          return;
        }
        if (data.type === "progress") {
          activeSourceId =
            typeof data.sourceId === "string" ? data.sourceId : activeSourceId;
          armImageTimer();
          onProgress?.(brand(data));
          return;
        }
        if (data.type === "cancelled") {
          settle(brand(data));
          return;
        }
        if (data.type === "blocked") {
          const issues = this.decodeBlockerIssues(data.issues);
          settle(
            issues
              ? brand({ type: "blocked", generationToken, issues })
              : this.malformed(generationToken, activeSourceId),
          );
          return;
        }
        if (data.type === "completed") {
          clearTimers();
          void this.decodeCompletion(data.result).then((result) => {
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
        }
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

      const transfer: Transferable[] = [
        request.sourceNote.bytes,
        ...request.images.map((image) => image.bytes),
      ];
      worker.postMessage(request, transfer);
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

  private async verifyOutputBytes(output: {
    contentSha256: unknown;
    byteLength: unknown;
    bytes: unknown;
  }): Promise<boolean> {
    if (
      typeof output.contentSha256 !== "string" ||
      !isNonnegativeInteger(output.byteLength) ||
      !isArrayBuffer(output.bytes) ||
      output.bytes.byteLength !== output.byteLength
    )
      return false;
    return (await this.options.hash(output.bytes)) === output.contentSha256;
  }

  private async decodeGeneratedMdx(
    value: unknown,
  ): Promise<WorkerGeneratedMdxOutput | undefined> {
    if (!isRecord(value) || !(await this.verifyOutputBytes(value as never)))
      return undefined;
    return {
      contentSha256: value.contentSha256 as Sha256Digest,
      byteLength: value.byteLength as number,
      bytes: value.bytes as ArrayBuffer,
    };
  }

  private async decodeImage(
    value: unknown,
  ): Promise<WorkerImageOutput | undefined> {
    if (
      !isRecord(value) ||
      typeof value.sourceId !== "string" ||
      typeof value.decodedMime !== "string" ||
      !SUPPORTED_MIME.has(value.decodedMime) ||
      !isNonnegativeInteger(value.width) ||
      !isNonnegativeInteger(value.height) ||
      !(await this.verifyOutputBytes(value as never))
    )
      return undefined;
    return {
      sourceId: value.sourceId,
      decodedMime: value.decodedMime as WorkerImageOutput["decodedMime"],
      width: value.width,
      height: value.height,
      contentSha256: value.contentSha256 as Sha256Digest,
      byteLength: value.byteLength as number,
      bytes: value.bytes as ArrayBuffer,
    };
  }

  /**
   * Reconstructs a trusted MdxRelayResult from an untrusted structured-cloned
   * completion payload, re-verifying byte lengths, hashes, and severity
   * channels. Returns undefined for any malformed payload.
   */
  private async decodeCompletion(
    value: unknown,
  ): Promise<MdxRelayResult<WorkerCompletion> | undefined> {
    if (!isRecord(value)) return undefined;
    if (value.ok === false) {
      const issues = this.decodeErrorIssues(value.error);
      return issues ? mdxRelayErr(issues) : undefined;
    }
    if (value.ok !== true || !isRecord(value.value)) return undefined;
    const completion = value.value;
    const generatedMdx = await this.decodeGeneratedMdx(completion.generatedMdx);
    if (!generatedMdx || !Array.isArray(completion.transformedImages))
      return undefined;
    const transformedImages: WorkerImageOutput[] = [];
    for (const raw of completion.transformedImages) {
      const image = await this.decodeImage(raw);
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
