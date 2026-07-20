import {
  matchesPlanIdentity,
  type ApprovalRecord,
  type ExportPlan,
  type GenerationToken,
  type PlanId,
  type RepositoryFingerprint,
  type Sha256Digest,
} from "./export-plan";
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
    it("keeps the plan, worker event, and approval on one identity", () => {
      const generationToken = "generation-1" as GenerationToken;
      const planId = "plan-1" as PlanId;
      const digest = "sha256:fixture" as Sha256Digest;
      const repositoryFingerprint = {
        repositoryIdentitySha256: digest,
        gitDirectoryIdentitySha256: digest,
        branchName: "feat/app-560-bootstrap-contracts",
        headOid: "a".repeat(40),
        upstreamOid: "b".repeat(40),
        remoteTipOid: "b".repeat(40),
        indexSha256: digest,
        worktreeStatusSha256: digest,
        gitConfigurationSha256: digest,
        effectivePushDestinationSha256: digest,
      } satisfies RepositoryFingerprint;
      const plan = {
        schemaVersion: 1,
        generationToken,
        planId,
        state: "ready",
        captureFingerprint: {
          noteSha256: digest,
          sourceImages: [],
          candidateSetSha256: digest,
          profileSnapshotSha256: digest,
          repository: repositoryFingerprint,
        },
        actions: [],
        blobs: {},
        issues: [],
        createdAtUtc: "2026-07-19T12:00:00.000Z",
        expiresAtUtc: "2026-07-26T12:00:00.000Z",
      } satisfies ExportPlan;
      const event = {
        type: "started",
        generationToken,
        planId,
        imageCount: 1,
      } satisfies WorkerStartedEvent;
      const approval = {
        generationToken,
        planId,
        repositoryFingerprint,
        approvedAtUtc: "2026-07-19T12:01:00.000Z",
      } satisfies ApprovalRecord;

      expect(matchesPlanIdentity(event, plan)).toBe(true);
      expect(matchesPlanIdentity(approval, plan)).toBe(true);
      expect(
        [plan, event, approval].map(({ generationToken }) => generationToken),
      ).toEqual([generationToken, generationToken, generationToken]);
      expect([plan, event, approval].map(({ planId }) => planId)).toEqual([
        planId,
        planId,
        planId,
      ]);

      const staleEvent = {
        ...event,
        generationToken: "generation-stale" as GenerationToken,
      } satisfies WorkerStartedEvent;
      const wrongPlanApproval = {
        ...approval,
        planId: "plan-stale" as PlanId,
      } satisfies ApprovalRecord;

      expect(matchesPlanIdentity(staleEvent, plan)).toBe(false);
      expect(matchesPlanIdentity(wrongPlanApproval, plan)).toBe(false);
    });
  });
}
