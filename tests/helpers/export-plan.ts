import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalizeJcs } from "../../src/canonical";
import { sha256OfBytes, sha256OfUtf8 } from "../../src/canonical/hash";
import type {
  ApprovalFingerprint,
  CanonicalDependencySnapshot,
  GenerationToken,
  Sha256Digest,
  TargetSnapshotEntry,
} from "../../src/contracts/export-plan";
import { toSafePathLabel } from "../../src/contracts/issues";
import type {
  AnyWorkerProcessRequest,
  DecodedWorkerEvent,
  WorkerProcessRequestV2,
  WorkerRequest,
} from "../../src/contracts/worker-protocol";
import { readImageHeader } from "../../src/images/image-metadata";
import { createPortableWebpCodec } from "../../src/images/portable-webp-codec";
import { transformMarkdown } from "../../src/markdown/transform";
import {
  buildExportPlan,
  type PlanSourceBytes,
} from "../../src/planning/build-export-plan";
import { sealExportPlan } from "../../src/planning/seal-export-plan";
import type { SealedExportPlanEnvelope } from "../../src/planning/plan-verification";
import { DPW_MIND_NET_V1 } from "../../src/profiles/builtins/dpw-mind-net-v1";
import { validatePortableProfile } from "../../src/profiles/portable-profile";
import type { PortableProfileV1 } from "../../src/profiles/profile-schema";
import {
  processPlan,
  type ProcessPlanDeps,
} from "../../src/worker/process-plan";
import {
  ProcessingClient,
  type WorkerLike,
} from "../../src/worker/processing-client";
import { loadCodecWasm } from "./codec-wasm";

const bufferCopy = (bytes: Uint8Array): ArrayBuffer =>
  new Uint8Array(bytes).buffer;

const asBytes = (buffer: ArrayBuffer): Uint8Array => new Uint8Array(buffer);

class InProcessWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  terminated = false;

  constructor(private readonly deps: Omit<ProcessPlanDeps, "post">) {}

  postMessage(message: WorkerRequest, transfer?: Transferable[]): void {
    if (message.type === "cancel-generation") return;
    const request = structuredClone(
      message,
      transfer === undefined ? undefined : { transfer },
    );
    queueMicrotask(() => {
      void processPlan(request, {
        ...this.deps,
        post: (event, eventTransfer) => {
          const cloned = structuredClone(
            event,
            eventTransfer === undefined
              ? undefined
              : { transfer: [...eventTransfer] },
          );
          queueMicrotask(() => {
            if (!this.terminated)
              this.onmessage?.({ data: cloned } as MessageEvent);
          });
        },
      }).catch((error: unknown) => this.onerror?.(error));
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

export interface PublicPipelineInput {
  readonly targetRoot: string;
  readonly noteBytes: Uint8Array;
  readonly imageBytes: Uint8Array;
  readonly profile?: PortableProfileV1;
  readonly noteVaultPath?: string;
  readonly imageVaultPath?: string;
  readonly imageEmbedSource?: string;
  readonly generationToken?: GenerationToken;
  readonly createdAtUtc?: string;
  readonly expiresAtUtc?: string;
}

export interface BuiltPipelineEnvelope {
  readonly envelope: SealedExportPlanEnvelope;
  readonly sourceBytes: PlanSourceBytes;
  readonly profileSnapshotSha256: Sha256Digest;
  readonly dependencySnapshotSha256: Sha256Digest;
  readonly workerEvents: readonly DecodedWorkerEvent[];
  readonly generatedMdxBytes: Uint8Array;
  readonly transformedImageBytes: Uint8Array;
}

const priorTarget = async (
  targetRoot: string,
  relativePath: string,
): Promise<TargetSnapshotEntry> => {
  try {
    const bytes = new Uint8Array(
      await readFile(join(targetRoot, relativePath)),
    );
    return {
      relativePath,
      priorState: {
        state: "regularFile",
        contentSha256: sha256OfBytes(bytes),
      },
    };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return { relativePath, priorState: { state: "absent" } };
    throw error;
  }
};

/**
 * Shared cross-suite envelope builder. It is the only T7 helper that constructs
 * a complete worker-backed plan, avoiding another private buildInput copy.
 */
export async function buildWorkerBackedEnvelope(
  input: PublicPipelineInput,
): Promise<BuiltPipelineEnvelope> {
  const profileResult = validatePortableProfile(
    input.profile ?? DPW_MIND_NET_V1,
  );
  if (!profileResult.ok) throw new Error(profileResult.error[0].code);
  const { profile, snapshot, profileSnapshotSha256 } = profileResult.value;
  const notePath = input.noteVaultPath ?? "notes/public-example.md";
  const imagePath = input.imageVaultPath ?? "assets/gradient.png";
  const embedSource = input.imageEmbedSource ?? "gradient.png";
  const noteText = new TextDecoder().decode(input.noteBytes);
  const transformed = await transformMarkdown(noteText, profile);
  if (!transformed.ok) throw new Error(transformed.error.code);
  const occurrence = transformed.value.images[0];
  if (occurrence === undefined) throw new Error("fixture requires one image");

  const dependencySnapshot = canonicalizeJcs({
    images: [{ source: embedSource, resolvedPath: imagePath }],
  }) as CanonicalDependencySnapshot;
  const dependencySnapshotSha256 = sha256OfUtf8(dependencySnapshot);
  const generationToken =
    input.generationToken ?? ("generation-t7" as GenerationToken);
  const noteDigest = sha256OfBytes(input.noteBytes);
  const imageDigest = sha256OfBytes(input.imageBytes);
  const request: WorkerProcessRequestV2 = {
    type: "process-plan-v2",
    generationToken,
    planStartedAtMs: 1_000,
    planDeadlineMs: 601_000,
    imageTimeoutMs: 60_000,
    sourceNote: {
      vaultRelativePath: notePath,
      safePathLabel: toSafePathLabel(notePath)!,
      byteLength: input.noteBytes.byteLength,
      contentSha256: noteDigest,
      bytes: bufferCopy(input.noteBytes),
    },
    profileSnapshot: snapshot,
    profileSnapshotSha256,
    dependencySnapshot,
    dependencySnapshotSha256,
    images: [
      {
        sourceId: "image-1",
        safePathLabel: toSafePathLabel(imagePath)!,
        contentSha256: imageDigest,
        byteLength: input.imageBytes.byteLength,
        bytes: bufferCopy(input.imageBytes),
        embedSource,
        embedSourceStartOffset: occurrence.sourceStartOffset,
      },
    ],
  };

  const codec = createPortableWebpCodec(await loadCodecWasm());
  let timerSequence = 0;
  const client = new ProcessingClient({
    createWorker: () =>
      new InProcessWorker({
        codec,
        readImageHeader,
        hash: async (bytes) => sha256OfBytes(asBytes(bytes)),
        transformMarkdown,
        now: () => 1_000,
      }),
    hash: async (bytes) => sha256OfBytes(asBytes(bytes)),
    now: () => 1_000,
    setTimer: () => ++timerSequence,
    clearTimer: () => undefined,
  });
  const progress: DecodedWorkerEvent[] = [];
  const terminal = await client.process(
    request as AnyWorkerProcessRequest,
    (event) => progress.push(event),
  );
  if (terminal.type !== "completed") throw new Error(terminal.type);
  if (!terminal.result.ok) throw new Error(terminal.result.error[0].code);
  const completion = terminal.result.value;
  const imageOutput = completion.transformedImages[0];
  if (imageOutput === undefined) throw new Error("worker omitted image output");
  const generatedMdxBytes = asBytes(completion.generatedMdx.bytes);
  const transformedImageBytes = asBytes(imageOutput.bytes);
  const mdxTarget = `${profile.output.contentRoot}/${transformed.value.slug}.mdx`;
  const imageTarget = `${profile.output.assetRoot}/${transformed.value.slug}/${occurrence.destination}`;
  const priorTargets = await Promise.all(
    [mdxTarget, imageTarget]
      .sort()
      .map((relativePath) => priorTarget(input.targetRoot, relativePath)),
  );
  const sourceBytes: PlanSourceBytes = {
    note: new Uint8Array(input.noteBytes),
    images: new Map([["image-1", new Uint8Array(input.imageBytes)]]),
  };
  const sourceImages = [
    {
      sourceId: "image-1",
      vaultRelativePath: imagePath,
      realPath: `/vault/${imagePath}`,
      decodedMime: imageOutput.decodedMime,
      byteLength: input.imageBytes.byteLength,
      contentSha256: imageDigest,
    },
  ] as const;
  const sourceNote = {
    vaultRelativePath: notePath,
    realPath: `/vault/${notePath}`,
    byteLength: input.noteBytes.byteLength,
    contentSha256: noteDigest,
  };
  const built = buildExportPlan({
    generationToken,
    profile,
    profileSnapshot: snapshot,
    profileSnapshotSha256,
    dependencySnapshot,
    dependencySnapshotSha256,
    sourceNote,
    sourceImages,
    sourceBytes,
    documentSlug: transformed.value.slug,
    generatedMdxBytes,
    transformedImages: [{ sourceId: "image-1", bytes: transformedImageBytes }],
    imageEmbeds: [
      { sourceId: "image-1", assetFileName: occurrence.destination },
    ],
    targetRootRealPath: input.targetRoot,
    caseSensitivity: "sensitive",
    priorTargets,
    warnings: completion.warnings,
    finalCapture: {
      profileSnapshotSha256,
      dependencySnapshotSha256,
      sourceNote,
      sourceImages,
      targetRootRealPath: input.targetRoot,
      caseSensitivity: "sensitive",
      targets: priorTargets,
    },
    createdAtUtc: input.createdAtUtc ?? "2026-08-08T00:00:00.000Z",
    expiresAtUtc: input.expiresAtUtc ?? "2026-08-09T00:00:00.000Z",
  });
  if (!built.ok) throw new Error(built.error[0].code);
  const sealed = sealExportPlan(built.value);
  if (!sealed.ok) throw new Error(sealed.error[0].code);
  return {
    envelope: sealed.value,
    sourceBytes,
    profileSnapshotSha256,
    dependencySnapshotSha256,
    workerEvents: Object.freeze([...progress, terminal]),
    generatedMdxBytes,
    transformedImageBytes,
  };
}

export async function recaptureApprovalFingerprint(
  built: BuiltPipelineEnvelope,
  targetRoot: string,
  sourceBytes: PlanSourceBytes = built.sourceBytes,
): Promise<ApprovalFingerprint> {
  const { plan, blobBytes } = built.envelope;
  const targets = await Promise.all(
    plan.targetFolderSnapshot.targets.map((target) =>
      priorTarget(targetRoot, target.relativePath),
    ),
  );
  const sealedOutputs = [...blobBytes.entries()]
    .map(([planRelativePath, bytes]) => ({
      planRelativePath,
      byteLength: bytes.byteLength,
      contentSha256: sha256OfBytes(bytes),
    }))
    .sort((left, right) =>
      left.planRelativePath < right.planRelativePath ? -1 : 1,
    );
  return {
    profileSnapshotSha256: built.profileSnapshotSha256,
    sourceNote: {
      byteLength: sourceBytes.note.byteLength,
      contentSha256: sha256OfBytes(sourceBytes.note),
    },
    dependencySnapshotSha256: built.dependencySnapshotSha256,
    sourceImages: plan.sourceImages.map((image) => {
      const source = sourceBytes.images.get(image.sourceId)!;
      return {
        sourceId: image.sourceId,
        byteLength: source.byteLength,
        contentSha256: sha256OfBytes(source),
        transformedOutputSha256: sha256OfBytes(built.transformedImageBytes),
      };
    }),
    sealedOutputs,
    targetFolderSnapshot: {
      targetRootRealPath: targetRoot,
      caseSensitivity: "sensitive",
      targets,
    },
  };
}
