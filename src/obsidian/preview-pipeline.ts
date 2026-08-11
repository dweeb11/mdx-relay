import type {
  ApprovalFingerprint,
  ExportPlan,
  GenerationToken,
  TargetFolderSnapshot,
  TargetSnapshotEntry,
} from "../contracts/export-plan";
import {
  createIssue,
  ISSUE_CODES,
  toSafePathLabel,
  type BlockerIssue,
} from "../contracts/issues";
import {
  mdxRelayErr,
  mdxRelayOk,
  type MdxRelayResult,
} from "../contracts/result";
import type {
  DecodedWorkerEvent,
  WorkerImageOutput,
  WorkerProcessRequestV2,
} from "../contracts/worker-protocol";
import { sha256OfBytes } from "../canonical/hash";
import { MDX_RELAY_LIMITS } from "../core/limits";
import {
  transformMarkdown,
  type MarkdownTransformResult,
} from "../markdown/transform";
import {
  buildExportPlan,
  type CanonicalSourceImage,
  type PlanSourceBytes,
} from "../planning/build-export-plan";
import {
  publishSealedPlan,
  readPlanApproval,
  recordPlanApproval,
} from "../planning/plan-store";
import type { PlanStoreDeps } from "../planning/plan-store-types";
import { sealExportPlan } from "../planning/seal-export-plan";
import { DPW_MIND_NET_V1 } from "../profiles/builtins/dpw-mind-net-v1";
import {
  resolveProfile,
  type ResolvedProfile,
} from "../profiles/resolve-profile";
import {
  applyApprovedWrites,
  createNodeTargetFolderFileSystem,
  isTargetRootResolutionError,
  resolveContainedTargetPath,
  type TargetFolderFileSystem,
} from "../write";
import { ProcessingClient, type WorkerLike } from "../worker/processing-client";
import type {
  ActiveMarkdownCapture,
  DependencyCapture,
  ObsidianPipelineHost,
} from "./host-adapter";
import type {
  ApprovalRecapture,
  BuiltPreview,
  PreviewCommandDeps,
} from "./preview-command";
import type { LiveSettings, MdxRelaySettings } from "./settings";

type CaseSensitivity = TargetFolderSnapshot["caseSensitivity"];

export interface PreviewPipelineOptions {
  readonly host: ObsidianPipelineHost;
  readonly settings: LiveSettings;
  readonly planStoreDeps: PlanStoreDeps;
  readonly createWorker: () => WorkerLike;
  readonly createTargetFileSystem?: () => TargetFolderFileSystem;
  readonly caseSensitivity?: CaseSensitivity;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => number;
  readonly clearTimer?: (handle: number) => void;
}

export interface LivePreviewCommandDeps extends PreviewCommandDeps {
  readonly isConfigured: () => boolean;
}

interface TargetProbe {
  readonly snapshot: TargetFolderSnapshot;
}

const staleBlocker = (
  code:
    typeof ISSUE_CODES.staleDuringPlanning | typeof ISSUE_CODES.staleApproval,
): MdxRelayResult<never> => mdxRelayErr([createIssue(code) as BlockerIssue]);

const planningBlocker = (
  code:
    | typeof ISSUE_CODES.unsafePath
    | typeof ISSUE_CODES.unsafeTarget
    | typeof ISSUE_CODES.unsupportedTarget
    | typeof ISSUE_CODES.workerCrashed
    | typeof ISSUE_CODES.malformedWorkerResponse
    | typeof ISSUE_CODES.unsupportedImage
    | typeof ISSUE_CODES.invalidMdx
    | typeof ISSUE_CODES.targetRootMissing
    | typeof ISSUE_CODES.targetRootNotDirectory
    | typeof ISSUE_CODES.targetRootSymlink
    | typeof ISSUE_CODES.targetRootInaccessible,
  detail?: string,
): MdxRelayResult<never> =>
  mdxRelayErr([
    createIssue(code, detail === undefined ? {} : { detail }) as BlockerIssue,
  ]);

const targetRootBlocker = (
  error: unknown,
  configuredRoot: string,
): MdxRelayResult<never> => {
  if (isTargetRootResolutionError(error)) {
    switch (error.kind) {
      case "missing":
        return planningBlocker(
          ISSUE_CODES.targetRootMissing,
          error.configuredRoot,
        );
      case "not-directory":
        return planningBlocker(
          ISSUE_CODES.targetRootNotDirectory,
          error.configuredRoot,
        );
      case "symlink":
        return planningBlocker(
          ISSUE_CODES.targetRootSymlink,
          error.configuredRoot,
        );
      case "inaccessible":
        return planningBlocker(
          ISSUE_CODES.targetRootInaccessible,
          error.configuredRoot,
        );
      default: {
        const _exhaustive: never = error.kind;
        void _exhaustive;
        return planningBlocker(
          ISSUE_CODES.targetRootInaccessible,
          error.configuredRoot,
        );
      }
    }
  }
  return planningBlocker(ISSUE_CODES.targetRootInaccessible, configuredRoot);
};

const profileFor = (
  settings: MdxRelaySettings,
): MdxRelayResult<ResolvedProfile> =>
  resolveProfile(DPW_MIND_NET_V1, {
    schemaVersion: 1,
    profileId: settings.profileId,
    targetRoot: settings.targetRoot,
  });

const copyBuffer = (bytes: Uint8Array): ArrayBuffer =>
  new Uint8Array(bytes).buffer;

const decodeNote = (bytes: Uint8Array): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

const probeTargets = async (
  fileSystem: TargetFolderFileSystem,
  configuredRoot: string,
  caseSensitivity: CaseSensitivity,
  relativePaths: readonly string[],
  inconsistencyCode:
    typeof ISSUE_CODES.staleDuringPlanning | typeof ISSUE_CODES.staleApproval,
): Promise<MdxRelayResult<TargetProbe>> => {
  let targetRootRealPath: string;
  try {
    targetRootRealPath = await fileSystem.resolveTargetRoot(configuredRoot);
  } catch (error) {
    return targetRootBlocker(error, configuredRoot);
  }
  try {
    const targets: TargetSnapshotEntry[] = [];
    for (const relativePath of relativePaths) {
      const targetPath = resolveContainedTargetPath(
        targetRootRealPath,
        relativePath,
      );
      if (targetPath === undefined)
        return planningBlocker(ISSUE_CODES.unsafeTarget, relativePath);
      const stat = await fileSystem.lstat(targetPath);
      if (stat.kind === "absent") {
        targets.push({ relativePath, priorState: { state: "absent" } });
        continue;
      }
      if (stat.kind !== "regularFile")
        return planningBlocker(ISSUE_CODES.unsupportedTarget, relativePath);
      const bytes = await fileSystem.readFile(targetPath);
      if (bytes.byteLength !== stat.byteLength)
        return staleBlocker(inconsistencyCode);
      targets.push({
        relativePath,
        priorState: {
          state: "regularFile",
          contentSha256: sha256OfBytes(bytes),
        },
      });
    }
    return mdxRelayOk({
      snapshot: {
        targetRootRealPath,
        caseSensitivity,
        targets: Object.freeze(targets),
      },
    });
  } catch {
    return staleBlocker(inconsistencyCode);
  }
};

const referencesFor = (
  bytes: Uint8Array,
  profile: ResolvedProfile,
): Promise<MdxRelayResult<MarkdownTransformResult>> => {
  const note = decodeNote(bytes);
  if (note === undefined)
    return Promise.resolve(planningBlocker(ISSUE_CODES.invalidMdx));
  return transformMarkdown(note, profile.portableProfile).then((result) => {
    if (result.ok) return mdxRelayOk(result.value);
    if (result.error.severity === "blocker") return mdxRelayErr([result.error]);
    return planningBlocker(ISSUE_CODES.invalidMdx);
  });
};

const sourceBytesFor = (
  capture: ActiveMarkdownCapture,
  dependencies: DependencyCapture,
): PlanSourceBytes => ({
  note: new Uint8Array(capture.bytes),
  images: new Map(
    dependencies.images.map((image) => [
      image.sourceId,
      new Uint8Array(image.bytes),
    ]),
  ),
});

const sourceImagesFor = (
  dependencies: DependencyCapture,
  outputs: readonly WorkerImageOutput[],
): readonly CanonicalSourceImage[] | undefined => {
  const outputBySource = new Map<string, WorkerImageOutput>();
  for (const output of outputs)
    if (!outputBySource.has(output.sourceId))
      outputBySource.set(output.sourceId, output);
  const images: CanonicalSourceImage[] = [];
  for (const image of dependencies.images) {
    const output = outputBySource.get(image.sourceId);
    if (output === undefined) return undefined;
    images.push({
      sourceId: image.sourceId,
      vaultRelativePath: image.vaultRelativePath,
      realPath: image.realPath,
      decodedMime: output.decodedMime,
      byteLength: image.byteLength,
      contentSha256: image.contentSha256,
    });
  }
  return Object.freeze(images);
};

const currentCaseSensitivity = (): CaseSensitivity =>
  process.platform === "linux" ? "sensitive" : "insensitive";

export function createLivePreviewCommandDeps(
  options: PreviewPipelineOptions,
): LivePreviewCommandDeps {
  const activeClients = new Map<
    GenerationToken,
    ProcessingClient | "pending" | "cancelled"
  >();
  const createFileSystem =
    options.createTargetFileSystem ?? createNodeTargetFolderFileSystem;
  const caseSensitivity = options.caseSensitivity ?? currentCaseSensitivity();
  const now = options.now ?? (() => Date.now());
  const setTimer =
    options.setTimer ??
    ((callback, delayMs) =>
      globalThis.setTimeout(callback, delayMs) as unknown as number);
  const clearTimer =
    options.clearTimer ??
    ((handle) => globalThis.clearTimeout(handle as unknown as number));

  const buildPreviewOperation = async (
    capture: ActiveMarkdownCapture,
    onWorkerEvent: (event: DecodedWorkerEvent) => void,
  ): Promise<MdxRelayResult<BuiltPreview>> => {
    const startedAt = now();
    const initialProfile = profileFor(options.settings.current());
    if (!initialProfile.ok) return initialProfile;
    const initialTransform = await referencesFor(
      capture.bytes,
      initialProfile.value,
    );
    if (!initialTransform.ok) return initialTransform;
    const initialDependencies = await options.host.captureImageDependencies(
      capture.note.vaultRelativePath,
      initialTransform.value.images,
    );
    if (!initialDependencies.ok) return initialDependencies;
    const initialRoot = await probeTargets(
      createFileSystem(),
      initialProfile.value.targetRoot,
      caseSensitivity,
      [],
      ISSUE_CODES.staleDuringPlanning,
    );
    if (!initialRoot.ok) return initialRoot;
    const safeNotePath = toSafePathLabel(capture.note.vaultRelativePath);
    if (safeNotePath === undefined)
      return planningBlocker(
        ISSUE_CODES.unsafePath,
        capture.note.vaultRelativePath,
      );
    const requestImages = initialDependencies.value.occurrences.map(
      (occurrence) => {
        const image = initialDependencies.value.images.find(
          (candidate) => candidate.sourceId === occurrence.sourceId,
        )!;
        return {
          sourceId: image.sourceId,
          safePathLabel: image.safePathLabel,
          byteLength: image.byteLength,
          contentSha256: image.contentSha256,
          bytes: copyBuffer(image.bytes),
          embedSource: occurrence.embedSource,
          embedSourceStartOffset: occurrence.embedSourceStartOffset,
        };
      },
    );
    const request: WorkerProcessRequestV2 = {
      type: "process-plan-v2",
      generationToken: capture.generationToken,
      planStartedAtMs: startedAt,
      planDeadlineMs: startedAt + MDX_RELAY_LIMITS.planBudgetMs,
      imageTimeoutMs: MDX_RELAY_LIMITS.workerImageTimeoutMs,
      sourceNote: {
        vaultRelativePath: capture.note.vaultRelativePath,
        safePathLabel: safeNotePath,
        byteLength: capture.note.byteLength,
        contentSha256: capture.note.contentSha256,
        bytes: copyBuffer(capture.bytes),
      },
      profileSnapshot: initialProfile.value.portableSnapshot,
      profileSnapshotSha256: initialProfile.value.profileSnapshotSha256,
      dependencySnapshot: initialDependencies.value.snapshot,
      dependencySnapshotSha256: initialDependencies.value.snapshotSha256,
      images: requestImages,
    };
    const client = new ProcessingClient({
      createWorker: options.createWorker,
      hash: async (bytes) => sha256OfBytes(new Uint8Array(bytes)),
      now,
      setTimer,
      clearTimer,
    });
    if (activeClients.get(capture.generationToken) !== "pending")
      return staleBlocker(ISSUE_CODES.staleDuringPlanning);
    activeClients.set(capture.generationToken, client);
    const terminal = await client.process(request, onWorkerEvent);
    if (activeClients.get(capture.generationToken) !== client)
      return staleBlocker(ISSUE_CODES.staleDuringPlanning);
    if (terminal.type === "blocked") return mdxRelayErr(terminal.issues);
    if (terminal.type === "cancelled")
      return staleBlocker(ISSUE_CODES.staleDuringPlanning);
    if (terminal.type !== "completed")
      return planningBlocker(ISSUE_CODES.malformedWorkerResponse);
    if (!terminal.result.ok) return terminal.result;

    const sourceImages = sourceImagesFor(
      initialDependencies.value,
      terminal.result.value.transformedImages,
    );
    if (sourceImages === undefined)
      return planningBlocker(ISSUE_CODES.unsupportedImage);
    if (
      initialTransform.value.images.length !==
      initialDependencies.value.occurrences.length
    )
      return planningBlocker(ISSUE_CODES.unsupportedImage);
    const imageEmbeds = initialTransform.value.images.map((image, index) => ({
      sourceId: initialDependencies.value.occurrences[index]!.sourceId,
      assetFileName: image.destination,
    }));
    const targetPaths = [
      `${initialProfile.value.portableProfile.output.contentRoot}/${initialTransform.value.slug}.mdx`,
      ...imageEmbeds.map(
        (image) =>
          `${initialProfile.value.portableProfile.output.assetRoot}/${initialTransform.value.slug}/${image.assetFileName}`,
      ),
    ];
    const priorTargets = await probeTargets(
      createFileSystem(),
      initialProfile.value.targetRoot,
      caseSensitivity,
      targetPaths,
      ISSUE_CODES.staleDuringPlanning,
    );
    if (!priorTargets.ok) return priorTargets;
    if (
      priorTargets.value.snapshot.targetRootRealPath !==
      initialRoot.value.snapshot.targetRootRealPath
    )
      return staleBlocker(ISSUE_CODES.staleDuringPlanning);

    const finalProfile = profileFor(options.settings.current());
    if (!finalProfile.ok) return finalProfile;
    const recapturedSources = await options.host.recaptureSources(
      capture.note,
      sourceImages,
    );
    if (!recapturedSources.ok) return recapturedSources;
    const finalTransform = await referencesFor(
      recapturedSources.value.note,
      finalProfile.value,
    );
    if (!finalTransform.ok) return finalTransform;
    const finalDependencies = await options.host.captureImageDependencies(
      capture.note.vaultRelativePath,
      finalTransform.value.images,
    );
    if (!finalDependencies.ok) return finalDependencies;
    const finalTargets = await probeTargets(
      createFileSystem(),
      finalProfile.value.targetRoot,
      caseSensitivity,
      targetPaths,
      ISSUE_CODES.staleDuringPlanning,
    );
    if (!finalTargets.ok) return finalTargets;

    const generatedMdxBytes = new Uint8Array(
      terminal.result.value.generatedMdx.bytes,
    );
    const uniqueTransformed = new Map<string, Uint8Array>();
    for (const output of terminal.result.value.transformedImages)
      if (!uniqueTransformed.has(output.sourceId))
        uniqueTransformed.set(output.sourceId, new Uint8Array(output.bytes));
    const built = buildExportPlan({
      generationToken: capture.generationToken,
      profile: initialProfile.value.portableProfile,
      profileSnapshot: initialProfile.value.portableSnapshot,
      profileSnapshotSha256: initialProfile.value.profileSnapshotSha256,
      dependencySnapshot: initialDependencies.value.snapshot,
      dependencySnapshotSha256: initialDependencies.value.snapshotSha256,
      sourceNote: capture.note,
      sourceImages,
      sourceBytes: sourceBytesFor(capture, initialDependencies.value),
      documentSlug: initialTransform.value.slug,
      generatedMdxBytes,
      transformedImages: [...uniqueTransformed].map(([sourceId, bytes]) => ({
        sourceId,
        bytes,
      })),
      imageEmbeds,
      targetRootRealPath: initialRoot.value.snapshot.targetRootRealPath,
      caseSensitivity,
      priorTargets: priorTargets.value.snapshot.targets,
      warnings: terminal.result.value.warnings,
      finalCapture: {
        profileSnapshotSha256: finalProfile.value.profileSnapshotSha256,
        dependencySnapshotSha256: finalDependencies.value.snapshotSha256,
        sourceNote: {
          byteLength: recapturedSources.value.note.byteLength,
          contentSha256: sha256OfBytes(recapturedSources.value.note),
        },
        sourceImages: finalDependencies.value.images.map((image) => ({
          sourceId: image.sourceId,
          byteLength: image.byteLength,
          contentSha256: image.contentSha256,
        })),
        targetRootRealPath: finalTargets.value.snapshot.targetRootRealPath,
        caseSensitivity,
        targets: finalTargets.value.snapshot.targets,
      },
      createdAtUtc: new Date(startedAt).toISOString(),
      expiresAtUtc: new Date(
        startedAt + MDX_RELAY_LIMITS.planBudgetMs,
      ).toISOString(),
    });
    if (!built.ok) return built;
    const sealed = sealExportPlan(built.value);
    if (!sealed.ok) return sealed;
    const published = await publishSealedPlan(
      options.planStoreDeps,
      sealed.value,
    );
    if (!published.ok) return published;
    return mdxRelayOk({
      envelope: sealed.value,
      generatedMdxBytes,
    });
  };

  const buildPreview: PreviewCommandDeps["buildPreview"] = async (
    capture,
    onWorkerEvent,
  ) => {
    activeClients.set(capture.generationToken, "pending");
    try {
      return await buildPreviewOperation(capture, onWorkerEvent);
    } finally {
      activeClients.delete(capture.generationToken);
    }
  };

  const recaptureApproval = async (
    plan: ExportPlan,
  ): Promise<MdxRelayResult<ApprovalRecapture>> => {
    const liveProfile = profileFor(options.settings.current());
    if (!liveProfile.ok) return liveProfile;
    const sourceBytes = await options.host.recapturePlanSources(plan);
    if (!sourceBytes.ok) return sourceBytes;
    const transformed = await referencesFor(
      sourceBytes.value.note,
      liveProfile.value,
    );
    if (!transformed.ok) return transformed;
    const dependencies = await options.host.captureImageDependencies(
      plan.sourceNote.vaultRelativePath,
      transformed.value.images,
    );
    if (!dependencies.ok) return dependencies;
    const targets = await probeTargets(
      createFileSystem(),
      liveProfile.value.targetRoot,
      caseSensitivity,
      plan.targetFolderSnapshot.targets.map((target) => target.relativePath),
      ISSUE_CODES.staleApproval,
    );
    if (!targets.ok) return targets;
    const freshBySource = new Map(
      dependencies.value.images.map((image) => [image.sourceId, image]),
    );
    const sourceImages = plan.sourceImages.map((image) => {
      const fresh = freshBySource.get(image.sourceId);
      return fresh === undefined
        ? undefined
        : {
            sourceId: image.sourceId,
            byteLength: fresh.byteLength,
            contentSha256: fresh.contentSha256,
            transformedOutputSha256: image.transformedOutputSha256,
          };
    });
    if (sourceImages.some((image) => image === undefined))
      return staleBlocker(ISSUE_CODES.staleApproval);
    const fingerprint: ApprovalFingerprint = {
      profileSnapshotSha256: liveProfile.value.profileSnapshotSha256,
      sourceNote: {
        byteLength: sourceBytes.value.note.byteLength,
        contentSha256: sha256OfBytes(sourceBytes.value.note),
      },
      dependencySnapshotSha256: dependencies.value.snapshotSha256,
      sourceImages: sourceImages as ApprovalFingerprint["sourceImages"],
      sealedOutputs: Object.values(plan.blobs)
        .map((output) => ({
          planRelativePath: output.planRelativePath,
          byteLength: output.byteLength,
          contentSha256: output.contentSha256,
        }))
        .sort((left, right) =>
          left.planRelativePath < right.planRelativePath ? -1 : 1,
        ),
      targetFolderSnapshot: targets.value.snapshot,
    };
    return mdxRelayOk({ sourceBytes: sourceBytes.value, fingerprint });
  };

  return {
    host: options.host,
    isConfigured: () => profileFor(options.settings.current()).ok,
    createGenerationToken: () =>
      globalThis.crypto.randomUUID() as GenerationToken,
    buildPreview,
    cancelGeneration: (generationToken) => {
      const active = activeClients.get(generationToken);
      if (active === undefined) return;
      if (active instanceof ProcessingClient) active.cancel();
      activeClients.set(generationToken, "cancelled");
    },
    recaptureApproval,
    recordApproval: (planId, sourceBytes) =>
      recordPlanApproval(options.planStoreDeps, planId, sourceBytes),
    applyApprovedWrites: (input) =>
      applyApprovedWrites(
        input,
        Object.freeze({
          fileSystem: createFileSystem(),
          hash: sha256OfBytes,
          caseSensitivity,
          readApproval: (planId: ExportPlan["planId"]) =>
            readPlanApproval(options.planStoreDeps, planId),
          now: () => new Date(now()).toISOString(),
        }),
      ),
  };
}
