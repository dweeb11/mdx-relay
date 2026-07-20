import type {
  CanonicalDependencySnapshot,
  GenerationToken,
  Sha256Digest,
  ValidatedPortableProfileSnapshot,
} from "./export-plan";
import {
  createIssue,
  ISSUE_CODES,
  toSafePathLabel,
  type BlockerIssue,
  type SafePathLabel,
  type WarningIssue,
} from "./issues";
import { mdxRelayErr, mdxRelayOk, type MdxRelayResult } from "./result";

export interface WorkerSourceNoteInput {
  readonly vaultRelativePath: string;
  readonly safePathLabel: SafePathLabel;
  readonly byteLength: number;
  readonly contentSha256: Sha256Digest;
  readonly bytes: ArrayBuffer;
}

export interface WorkerImageInput {
  readonly sourceId: string;
  readonly safePathLabel: SafePathLabel;
  readonly contentSha256: Sha256Digest;
  readonly byteLength: number;
  readonly bytes: ArrayBuffer;
}

/** Pre-seal requests have no planId; generationToken is their sole identity. */
export interface WorkerProcessRequest {
  readonly type: "process-plan";
  readonly generationToken: GenerationToken;
  readonly planStartedAtMs: number;
  readonly planDeadlineMs: number;
  readonly imageTimeoutMs: number;
  readonly sourceNote: WorkerSourceNoteInput;
  /** RFC 8785 canonical JSON validated before crossing the worker boundary. */
  readonly profileSnapshot: ValidatedPortableProfileSnapshot;
  readonly profileSnapshotSha256: Sha256Digest;
  /** RFC 8785 canonical JSON from one coherent dependency capture. */
  readonly dependencySnapshot: CanonicalDependencySnapshot;
  readonly dependencySnapshotSha256: Sha256Digest;
  /** Canonical source images only; duplicate occurrences remain in the snapshot. */
  readonly images: readonly WorkerImageInput[];
}

export interface WorkerCancelRequest {
  readonly type: "cancel-generation";
  readonly generationToken: GenerationToken;
}

export type WorkerRequest = WorkerProcessRequest | WorkerCancelRequest;

interface GenerationBoundEvent {
  readonly generationToken: GenerationToken;
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

export interface WorkerGeneratedMdxOutput {
  readonly contentSha256: Sha256Digest;
  readonly byteLength: number;
  readonly bytes: ArrayBuffer;
}

export interface WorkerImageOutput {
  readonly sourceId: string;
  readonly decodedMime: "image/png" | "image/jpeg" | "image/webp";
  readonly width: number;
  readonly height: number;
  readonly contentSha256: Sha256Digest;
  readonly byteLength: number;
  readonly bytes: ArrayBuffer;
}

export interface WorkerCompletion {
  readonly generatedMdx: WorkerGeneratedMdxOutput;
  readonly transformedImages: readonly WorkerImageOutput[];
  readonly warnings: readonly WarningIssue[];
}

/** Raw structured-clone completion payload; result is untrusted until decoded. */
export interface WorkerCompletedWireEvent extends GenerationBoundEvent {
  readonly type: "completed";
  readonly result: unknown;
}

/**
 * Host-side completion produced only after the future T3 decoder validates the
 * event shape, severity channels, byte lengths and hashes, then creates or
 * restores the nominal boundary result with the mdxRelay constructors.
 */
export interface DecodedWorkerCompletedEvent extends GenerationBoundEvent {
  readonly type: "completed";
  /** A blocker-first error arm never exposes trusted partial output. */
  readonly result: MdxRelayResult<WorkerCompletion>;
}

/** Parent-synthesized terminal failure when no trustworthy worker Result exists. */
export interface WorkerBlockedEvent extends GenerationBoundEvent {
  readonly type: "blocked";
  readonly activeSourceId?: string;
  readonly issues: readonly [BlockerIssue, ...BlockerIssue[]];
}

export interface WorkerCancelledEvent extends GenerationBoundEvent {
  readonly type: "cancelled";
}

/** Raw MessageEvent.data contract. It is not host authority. */
export type WorkerWireEvent =
  | WorkerStartedEvent
  | WorkerProgressEvent
  | WorkerCompletedWireEvent
  | WorkerBlockedEvent
  | WorkerCancelledEvent;

/**
 * Host-facing union returned by the future T3 decoder, never by annotating
 * MessageEvent.data. The decoder validates shape, severity channels, byte
 * lengths and hashes, and creates/restores nominal boundary results. All
 * pre-seal variants remain generationToken-only.
 */
export type DecodedWorkerEvent =
  | WorkerStartedEvent
  | WorkerProgressEvent
  | DecodedWorkerCompletedEvent
  | WorkerBlockedEvent
  | WorkerCancelledEvent;

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  const digest = "sha256:fixture" as Sha256Digest;
  const generationToken = "generation-1" as GenerationToken;
  const noteLabel = toSafePathLabel("notes/example.md") as SafePathLabel;
  const imageLabel = toSafePathLabel("assets/image.png") as SafePathLabel;

  const processRequest = (): WorkerProcessRequest => ({
    type: "process-plan",
    generationToken,
    planStartedAtMs: 100,
    planDeadlineMs: 5_100,
    imageTimeoutMs: 1_000,
    sourceNote: {
      vaultRelativePath: "notes/example.md",
      safePathLabel: noteLabel,
      byteLength: 1,
      contentSha256: digest,
      bytes: Uint8Array.of(1).buffer,
    },
    profileSnapshot: "{}" as ValidatedPortableProfileSnapshot,
    profileSnapshotSha256: digest,
    dependencySnapshot: "{}" as CanonicalDependencySnapshot,
    dependencySnapshotSha256: digest,
    images: [
      {
        sourceId: "image-1",
        safePathLabel: imageLabel,
        contentSha256: digest,
        byteLength: 1,
        bytes: Uint8Array.of(2).buffer,
      },
    ],
  });

  describe("worker protocol", () => {
    it("structured-clones all pure transformation input", () => {
      const request = processRequest();
      const cloned = structuredClone(request) as WorkerProcessRequest;
      expect(cloned).toMatchObject({
        type: "process-plan",
        generationToken,
        sourceNote: { safePathLabel: noteLabel, contentSha256: digest },
        images: [{ sourceId: "image-1", safePathLabel: imageLabel }],
      });
      expect(new Uint8Array(cloned.sourceNote.bytes)).toEqual(Uint8Array.of(1));
      expect(new Uint8Array(cloned.images[0]!.bytes)).toEqual(Uint8Array.of(2));
      expect("planId" in cloned).toBe(false);
    });

    it("binds requests, cancellation, and every event only to generationToken", () => {
      const request = processRequest();
      const invalidRequest: WorkerProcessRequest = {
        ...request,
        // @ts-expect-error pre-seal worker requests cannot carry a planId
        planId: "pre-seal-plan",
      };
      const cancel = {
        type: "cancel-generation",
        generationToken,
      } satisfies WorkerCancelRequest;
      const completion: WorkerCompletion = {
        generatedMdx: {
          contentSha256: digest,
          byteLength: 1,
          bytes: Uint8Array.of(3).buffer,
        },
        transformedImages: [],
        warnings: [createIssue(ISSUE_CODES.summaryMissing)],
      };
      const events: readonly DecodedWorkerEvent[] = [
        { type: "started", generationToken, imageCount: 1 },
        {
          type: "progress",
          generationToken,
          sourceId: "image-1",
          imageIndex: 0,
          completedImages: 0,
          totalImages: 1,
          elapsedMs: 10,
          remainingPlanBudgetMs: 990,
        },
        { type: "completed", generationToken, result: mdxRelayOk(completion) },
        {
          type: "blocked",
          generationToken,
          issues: [createIssue(ISSUE_CODES.workerCrashed)],
        },
        { type: "cancelled", generationToken },
      ];
      const invalidEvent: DecodedWorkerEvent = {
        type: "cancelled",
        generationToken,
        // @ts-expect-error pre-seal worker events cannot carry a planId
        planId: "pre-seal-plan",
      };
      for (const value of [request, cancel, ...events]) {
        expect(value.generationToken).toBe(generationToken);
        expect("planId" in value).toBe(false);
      }
      void invalidRequest;
      void invalidEvent;
      const stale = {
        ...events[0],
        generationToken: "generation-stale" as GenerationToken,
      };
      expect(stale.generationToken === request.generationToken).toBe(false);
    });

    it("uses nominal result constructors for success and blocker-first failure", () => {
      const warning = createIssue(ISSUE_CODES.wikilinksFlattened, { count: 1 });
      const completion = {
        generatedMdx: {
          contentSha256: digest,
          byteLength: 1,
          bytes: Uint8Array.of(4).buffer,
        },
        transformedImages: [],
        warnings: [warning],
      } satisfies WorkerCompletion;
      const success = {
        type: "completed",
        generationToken,
        result: mdxRelayOk(completion),
      } satisfies DecodedWorkerCompletedEvent;
      const blocker = createIssue(ISSUE_CODES.imageDecodeFailed);
      const failure = {
        type: "completed",
        generationToken,
        result: mdxRelayErr([blocker, warning]),
      } satisfies DecodedWorkerCompletedEvent;
      expect(success.result.ok).toBe(true);
      expect(failure.result.ok).toBe(false);
      if (!failure.result.ok) expect(failure.result.error[0]).toBe(blocker);
    });

    it("keeps structured-cloned completion data untrusted until decoding", () => {
      const completion: WorkerCompletion = {
        generatedMdx: {
          contentSha256: digest,
          byteLength: 2,
          bytes: Uint8Array.of(7, 8).buffer,
        },
        transformedImages: [],
        warnings: [createIssue(ISSUE_CODES.summaryMissing)],
      };
      const event = {
        type: "completed",
        generationToken,
        result: mdxRelayOk(completion),
      } satisfies DecodedWorkerCompletedEvent;
      const cloned: WorkerCompletedWireEvent = structuredClone(event);
      const messageEvent = { data: cloned } as MessageEvent<WorkerWireEvent>;
      // @ts-expect-error raw structured-clone data cannot satisfy decoded authority
      const decodedCompletion: DecodedWorkerCompletedEvent = cloned;
      // @ts-expect-error annotating MessageEvent.data as wire data cannot decode it
      const decodedEvent: DecodedWorkerEvent = messageEvent.data;
      expect(cloned).toMatchObject({
        type: "completed",
        generationToken,
        result: {
          ok: true,
          value: {
            generatedMdx: { contentSha256: digest, byteLength: 2 },
            transformedImages: [],
            warnings: [{ code: ISSUE_CODES.summaryMissing }],
          },
        },
      });
      const untrustedResult = cloned.result as {
        ok: true;
        value: WorkerCompletion;
      };
      expect(new Uint8Array(untrustedResult.value.generatedMdx.bytes)).toEqual(
        Uint8Array.of(7, 8),
      );
      expect(Object.getOwnPropertySymbols(event.result)).toHaveLength(1);
      expect(Object.getOwnPropertySymbols(untrustedResult)).toHaveLength(0);
      void decodedCompletion;
      void decodedEvent;
    });

    it("enforces warning and blocker channels at compile time", () => {
      const warning = createIssue(ISSUE_CODES.summaryMissing);
      const blocker = createIssue(ISSUE_CODES.invalidMdx);
      const generatedMdx = {
        contentSha256: digest,
        byteLength: 1,
        bytes: Uint8Array.of(1).buffer,
      };
      const invalidCompletion: WorkerCompletion = {
        generatedMdx,
        transformedImages: [],
        // @ts-expect-error blocker issues cannot be worker success warnings
        warnings: [blocker],
      };
      const invalidBlocked: WorkerBlockedEvent = {
        type: "blocked",
        generationToken,
        // @ts-expect-error warning issues cannot form a blocked event
        issues: [warning],
      };
      const emptyBlocked: WorkerBlockedEvent = {
        type: "blocked",
        generationToken,
        // @ts-expect-error blocked events require at least one blocker
        issues: [],
      };
      void invalidCompletion;
      void invalidBlocked;
      void emptyBlocked;
      expect(blocker.severity).toBe("blocker");
      expect(warning.severity).toBe("warning");
    });
  });
}
