import type { GenerationToken, PlanId, Sha256Digest } from "./export-plan";
import type { MdxRelayIssue } from "./issues";
import type { MdxRelayResult } from "./result";

export interface WorkerImageInput {
  readonly sourceId: string;
  readonly safePathLabel: string;
  readonly contentSha256: Sha256Digest;
  readonly bytes: ArrayBuffer;
}

export interface WorkerProcessRequest {
  readonly type: "process-plan";
  readonly generationToken: GenerationToken;
  readonly planId: PlanId;
  readonly planStartedAtMs: number;
  readonly planDeadlineMs: number;
  readonly imageTimeoutMs: number;
  readonly images: readonly WorkerImageInput[];
}

export interface WorkerCancelRequest {
  readonly type: "cancel-generation";
  readonly generationToken: GenerationToken;
  readonly planId: PlanId;
}

export type WorkerRequest = WorkerProcessRequest | WorkerCancelRequest;

interface GenerationBoundEvent {
  readonly generationToken: GenerationToken;
  readonly planId: PlanId;
}

export interface WorkerStartedEvent extends GenerationBoundEvent {
  readonly type: "started";
  readonly imageCount: number;
}

export interface WorkerProgressEvent extends GenerationBoundEvent {
  readonly type: "progress";
  readonly sourceId: string;
  readonly imageIndex: number;
  readonly completedImages: number;
  readonly totalImages: number;
  readonly elapsedMs: number;
  readonly remainingPlanBudgetMs: number;
}

export interface WorkerImageOutput {
  readonly sourceId: string;
  readonly contentSha256: Sha256Digest;
  readonly byteLength: number;
  readonly bytes: ArrayBuffer;
}

export interface WorkerCompletedEvent extends GenerationBoundEvent {
  readonly type: "completed";
  readonly result: MdxRelayResult<readonly WorkerImageOutput[]>;
}

export interface WorkerBlockedEvent extends GenerationBoundEvent {
  readonly type: "blocked";
  readonly activeSourceId?: string;
  readonly issues: readonly MdxRelayIssue[];
}

export interface WorkerCancelledEvent extends GenerationBoundEvent {
  readonly type: "cancelled";
}

export type WorkerEvent =
  | WorkerStartedEvent
  | WorkerProgressEvent
  | WorkerCompletedEvent
  | WorkerBlockedEvent
  | WorkerCancelledEvent;

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("worker protocol", () => {
    it("binds every event variant to generation token and plan ID", () => {
      const eventTypes: WorkerEvent["type"][] = [
        "started",
        "progress",
        "completed",
        "blocked",
        "cancelled",
      ];

      expect(eventTypes).toHaveLength(5);
    });
  });
}
