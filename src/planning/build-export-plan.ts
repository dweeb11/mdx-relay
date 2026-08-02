import type {
  ApprovalFingerprint,
  ApprovedPriorTarget,
  CanonicalDependencySnapshot,
  ExportAction,
  GenerationToken,
  SealedOutput,
  Sha256Digest,
  SourceImageMetadata,
  SourceNoteMetadata,
  TargetFolderSnapshot,
  TargetSnapshotEntry,
  ValidatedPortableProfileSnapshot,
} from "../contracts/export-plan";
import {
  createIssue,
  ISSUE_CODES,
  type WarningIssue,
} from "../contracts/issues";
import {
  mdxRelayErr,
  mdxRelayOk,
  type MdxRelayResult,
} from "../contracts/result";
import { deepEquals } from "../canonical";
import { sha256OfBytes } from "../canonical/hash";
import { MDX_RELAY_LIMITS } from "../core/limits";
import type { PortableProfileV1 } from "../profiles/profile-schema";

/**
 * Pure deterministic planning. Given one coherent capture plus the bytes the
 * worker produced, this module derives every target path, action, sealed output
 * and fingerprint with no I/O and no clock of its own. The same input always
 * yields the same draft, which is what makes the sealed plan ID content-derived
 * rather than run-derived.
 *
 *   capture -> derive targets -> content-address outputs -> final capture
 *   barrier -> draft
 *
 * The final capture barrier is the last gate: the host re-reads and re-hashes
 * the profile, dependency snapshot, note, every source image and every planned
 * target, and the derived plan is discarded whole if anything moved.
 */

/** Canonical source image metadata before its transformed output is known. */
export type CanonicalSourceImage = Omit<
  SourceImageMetadata,
  "transformedOutputSha256"
>;

/** Transformed WebP bytes for one canonical source image. */
export interface TransformedImageBytes {
  readonly sourceId: string;
  readonly bytes: Uint8Array;
}

/** One image embed in document order; duplicates repeat a canonical sourceId. */
export interface DocumentImageEmbed {
  readonly sourceId: string;
  readonly assetFileName: string;
}

export interface CapturedSourceNoteState {
  readonly byteLength: number;
  readonly contentSha256: Sha256Digest;
}

export interface CapturedSourceImageState {
  readonly sourceId: string;
  readonly byteLength: number;
  readonly contentSha256: Sha256Digest;
}

/**
 * The bytes a live capture actually read for the source note and every source
 * image, keyed by canonical sourceId. These are the evidence behind every
 * source fingerprint a plan records. They are held only for as long as a plan
 * is being derived or verified and are never written to the plan store, so
 * private note and image content never leaves the vault.
 */
export interface PlanSourceBytes {
  readonly note: Uint8Array;
  readonly images: ReadonlyMap<string, Uint8Array>;
}

export type SourceByteFailure =
  | typeof ISSUE_CODES.noteTooLarge
  | typeof ISSUE_CODES.sourceImageTooLarge
  | typeof ISSUE_CODES.staleDuringPlanning;

/**
 * The recapture taken immediately before publication. Every field is compared
 * against what the plan was derived from; any difference is a stale plan.
 */
export interface FinalCaptureBarrier {
  readonly profileSnapshotSha256: Sha256Digest;
  readonly dependencySnapshotSha256: Sha256Digest;
  readonly sourceNote: CapturedSourceNoteState;
  readonly sourceImages: readonly CapturedSourceImageState[];
  readonly targetRootRealPath: string;
  readonly caseSensitivity: TargetFolderSnapshot["caseSensitivity"];
  readonly targets: readonly TargetSnapshotEntry[];
}

export interface ExportPlanBuildInput {
  readonly generationToken: GenerationToken;
  readonly profile: PortableProfileV1;
  readonly profileSnapshot: ValidatedPortableProfileSnapshot;
  readonly profileSnapshotSha256: Sha256Digest;
  readonly dependencySnapshot: CanonicalDependencySnapshot;
  readonly dependencySnapshotSha256: Sha256Digest;
  readonly sourceNote: SourceNoteMetadata;
  readonly sourceImages: readonly CanonicalSourceImage[];
  /** The captured bytes behind every source fingerprint above. */
  readonly sourceBytes: PlanSourceBytes;
  readonly documentSlug: string;
  readonly generatedMdxBytes: Uint8Array;
  readonly transformedImages: readonly TransformedImageBytes[];
  readonly imageEmbeds: readonly DocumentImageEmbed[];
  readonly targetRootRealPath: string;
  readonly caseSensitivity: TargetFolderSnapshot["caseSensitivity"];
  /** Probed prior state for every planned target path. */
  readonly priorTargets: readonly TargetSnapshotEntry[];
  readonly warnings: readonly WarningIssue[];
  readonly finalCapture: FinalCaptureBarrier;
  readonly createdAtUtc: string;
  readonly expiresAtUtc: string;
}

/** A complete plan except for the content-derived plan ID the sealer assigns. */
export interface UnsealedExportPlan {
  readonly schemaVersion: 1;
  readonly generationToken: GenerationToken;
  readonly state: "ready" | "no-changes";
  readonly profileSnapshot: ValidatedPortableProfileSnapshot;
  readonly profileSnapshotSha256: Sha256Digest;
  readonly sourceNote: SourceNoteMetadata;
  readonly dependencySnapshot: CanonicalDependencySnapshot;
  readonly dependencySnapshotSha256: Sha256Digest;
  readonly sourceImages: readonly SourceImageMetadata[];
  readonly targetFolderSnapshot: TargetFolderSnapshot;
  readonly approvalFingerprint: ApprovalFingerprint;
  readonly generatedMdx: SealedOutput;
  readonly actions: readonly ExportAction[];
  readonly blobs: Readonly<Record<string, SealedOutput>>;
  readonly issues: readonly WarningIssue[];
  readonly createdAtUtc: string;
  readonly expiresAtUtc: string;
}

export interface ExportPlanDraft {
  readonly plan: UnsealedExportPlan;
  /** Sealed output bytes keyed by plan-relative path. */
  readonly blobBytes: ReadonlyMap<string, Uint8Array>;
  /** Carried to the sealer so branding can recompute source hashes from bytes. */
  readonly sourceBytes: PlanSourceBytes;
}

const WINDOWS_RESERVED_SEGMENT =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

/**
 * Common filesystem component limit (NAME_MAX) on macOS, Windows, and Linux.
 * A portable-valid slug can still exceed this and fail only at execute time.
 */
export const MAX_PORTABLE_PATH_SEGMENT_LENGTH = 255;

/**
 * Matches the bounded portable relative-path contract used for profile roots
 * (`contentRoot` / `assetRoot` in portable-profile validation).
 */
export const MAX_PORTABLE_TARGET_PATH_LENGTH = 240;

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

const isPortableSegment = (segment: string): boolean =>
  segment.length > 0 &&
  segment.length <= MAX_PORTABLE_PATH_SEGMENT_LENGTH &&
  !segment.includes("/") &&
  !segment.includes("\\") &&
  segment !== "." &&
  segment !== ".." &&
  segment.toLowerCase() !== ".git" &&
  !segment.endsWith(".") &&
  !segment.endsWith(" ") &&
  !WINDOWS_RESERVED_SEGMENT.test(segment) &&
  !hasControlCharacter(segment);

/** Mirrors the target-path shape the frozen plan contract accepts. */
export const isPortableTargetPath = (value: string): boolean =>
  value.length > 0 &&
  value.length <= MAX_PORTABLE_TARGET_PATH_LENGTH &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !/^[A-Za-z]:/u.test(value) &&
  value.split("/").every(isPortableSegment);

/**
 * Recomputes the source-note and every source-image fingerprint from the bytes
 * a capture actually read, and applies the locked source budgets to those
 * recomputed lengths. Recorded metadata is never the evidence: a plan whose
 * digest or length disagrees with its bytes is stale, and a plan whose real
 * bytes exceed a locked budget is refused whatever the plan claims.
 */
export function verifySourceBytes(
  sourceNote: CapturedSourceNoteState,
  sourceImages: readonly CapturedSourceImageState[],
  sourceBytes: PlanSourceBytes,
): SourceByteFailure | undefined {
  if (sourceBytes.note.byteLength > MDX_RELAY_LIMITS.noteBytes)
    return ISSUE_CODES.noteTooLarge;
  if (
    sourceBytes.note.byteLength !== sourceNote.byteLength ||
    sha256OfBytes(sourceBytes.note) !== sourceNote.contentSha256
  )
    return ISSUE_CODES.staleDuringPlanning;
  if (sourceBytes.images.size !== sourceImages.length)
    return ISSUE_CODES.staleDuringPlanning;
  for (const image of sourceImages) {
    const bytes = sourceBytes.images.get(image.sourceId);
    if (!bytes) return ISSUE_CODES.staleDuringPlanning;
    if (bytes.byteLength > MDX_RELAY_LIMITS.sourceImageBytes)
      return ISSUE_CODES.sourceImageTooLarge;
    if (
      bytes.byteLength !== image.byteLength ||
      sha256OfBytes(bytes) !== image.contentSha256
    )
      return ISSUE_CODES.staleDuringPlanning;
  }
  return undefined;
}

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const blocked = (
  code:
    | typeof ISSUE_CODES.unsafePath
    | typeof ISSUE_CODES.repositoryPreflightFailed
    | typeof ISSUE_CODES.staleDuringPlanning
    | typeof ISSUE_CODES.noteTooLarge
    | typeof ISSUE_CODES.sourceImageTooLarge
    | typeof ISSUE_CODES.outputFileLimitExceeded
    | typeof ISSUE_CODES.outputTooLarge
    | typeof ISSUE_CODES.totalOutputTooLarge,
): MdxRelayResult<never> => {
  if (code === ISSUE_CODES.unsafePath)
    return mdxRelayErr([createIssue(ISSUE_CODES.unsafePath)]);
  if (code === ISSUE_CODES.repositoryPreflightFailed)
    return mdxRelayErr([createIssue(ISSUE_CODES.repositoryPreflightFailed)]);
  if (code === ISSUE_CODES.noteTooLarge)
    return mdxRelayErr([createIssue(ISSUE_CODES.noteTooLarge)]);
  if (code === ISSUE_CODES.sourceImageTooLarge)
    return mdxRelayErr([createIssue(ISSUE_CODES.sourceImageTooLarge)]);
  if (code === ISSUE_CODES.outputFileLimitExceeded)
    return mdxRelayErr([createIssue(ISSUE_CODES.outputFileLimitExceeded)]);
  if (code === ISSUE_CODES.outputTooLarge)
    return mdxRelayErr([createIssue(ISSUE_CODES.outputTooLarge)]);
  if (code === ISSUE_CODES.totalOutputTooLarge)
    return mdxRelayErr([createIssue(ISSUE_CODES.totalOutputTooLarge)]);
  return mdxRelayErr([createIssue(ISSUE_CODES.staleDuringPlanning)]);
};

/**
 * Sealed outputs are content-addressed: the plan-relative path is the lowercase
 * hex of the content digest. Identical bytes therefore collapse to exactly one
 * blob, path order equals digest order, and no output path can collide with the
 * store's own metadata names.
 */
const sealedOutputFor = (bytes: Uint8Array): SealedOutput => {
  const digest = sha256OfBytes(bytes);
  return Object.freeze({
    planRelativePath: digest.slice("sha256:".length),
    byteLength: bytes.byteLength,
    contentSha256: digest,
  });
};

const copyPriorState = (value: ApprovedPriorTarget): ApprovedPriorTarget =>
  value.state === "absent"
    ? Object.freeze({ state: "absent" as const })
    : Object.freeze({
        state: "regularFile" as const,
        contentSha256: value.contentSha256,
      });

const copyTarget = (value: TargetSnapshotEntry): TargetSnapshotEntry =>
  Object.freeze({
    relativePath: value.relativePath,
    priorState: copyPriorState(value.priorState),
  });

const orderedTargets = (
  targets: readonly TargetSnapshotEntry[],
): readonly TargetSnapshotEntry[] =>
  Object.freeze(
    [...targets]
      .sort((left, right) =>
        compareCodeUnits(left.relativePath, right.relativePath),
      )
      .map(copyTarget),
  );

const targetKey = (
  relativePath: string,
  caseSensitivity: TargetFolderSnapshot["caseSensitivity"],
): string =>
  caseSensitivity === "insensitive" ? relativePath.toLowerCase() : relativePath;

interface PlannedTarget {
  readonly relativePath: string;
  readonly documentOrder: number;
  readonly sourceOccurrence: number;
  readonly sealedOutput: SealedOutput;
}

const capturedImageStates = (
  images: readonly CapturedSourceImageState[],
): readonly CapturedSourceImageState[] =>
  [...images]
    .sort((left, right) => compareCodeUnits(left.sourceId, right.sourceId))
    .map(({ sourceId, byteLength, contentSha256 }) => ({
      sourceId,
      byteLength,
      contentSha256,
    }));

/**
 * Derives the complete unsealed plan from one coherent capture.
 *
 * Every planned target becomes an action whenever anything changed, so a ready
 * plan always rewrites its own document; a plan whose every target already holds
 * the planned bytes is `no-changes` and carries no actions, while retaining the
 * target states that proved no write was needed so later application can detect
 * drift after preview.
 */
export function buildExportPlan(
  input: ExportPlanBuildInput,
): MdxRelayResult<ExportPlanDraft> {
  const { profile } = input;
  if (!isPortableSegment(input.documentSlug))
    return blocked(ISSUE_CODES.unsafePath);

  // Source fingerprints are proven from bytes before anything is derived from
  // them, so an oversized or moved note or image never reaches sealing.
  const sourceByteFailure = verifySourceBytes(
    input.sourceNote,
    input.sourceImages,
    input.sourceBytes,
  );
  if (sourceByteFailure) return blocked(sourceByteFailure);

  const transformedBySource = new Map<string, Uint8Array>();
  for (const image of input.transformedImages) {
    if (transformedBySource.has(image.sourceId))
      return blocked(ISSUE_CODES.staleDuringPlanning);
    transformedBySource.set(image.sourceId, image.bytes);
  }

  const canonicalSources = new Map<string, CanonicalSourceImage>();
  for (const image of input.sourceImages) {
    if (
      canonicalSources.has(image.sourceId) ||
      !transformedBySource.has(image.sourceId)
    )
      return blocked(ISSUE_CODES.staleDuringPlanning);
    canonicalSources.set(image.sourceId, image);
  }

  const generatedMdx = sealedOutputFor(input.generatedMdxBytes);
  const blobBytes = new Map<string, Uint8Array>([
    [generatedMdx.planRelativePath, input.generatedMdxBytes],
  ]);

  const outputBySource = new Map<string, SealedOutput>();
  const sourceImages: SourceImageMetadata[] = [];
  for (const [sourceId, image] of [...canonicalSources].sort(
    ([left], [right]) => compareCodeUnits(left, right),
  )) {
    const bytes = transformedBySource.get(sourceId)!;
    const output = sealedOutputFor(bytes);
    outputBySource.set(sourceId, output);
    blobBytes.set(output.planRelativePath, bytes);
    sourceImages.push(
      Object.freeze({
        sourceId: image.sourceId,
        vaultRelativePath: image.vaultRelativePath,
        realPath: image.realPath,
        decodedMime: image.decodedMime,
        byteLength: image.byteLength,
        contentSha256: image.contentSha256,
        transformedOutputSha256: output.contentSha256,
      }),
    );
  }

  const planned: PlannedTarget[] = [
    {
      relativePath: `${profile.output.contentRoot}/${input.documentSlug}.mdx`,
      documentOrder: 0,
      sourceOccurrence: 0,
      sealedOutput: generatedMdx,
    },
  ];
  const occurrences = new Map<string, number>();
  for (const [index, embed] of input.imageEmbeds.entries()) {
    const output = outputBySource.get(embed.sourceId);
    if (!output) return blocked(ISSUE_CODES.staleDuringPlanning);
    const occurrence = (occurrences.get(embed.sourceId) ?? 0) + 1;
    occurrences.set(embed.sourceId, occurrence);
    planned.push({
      relativePath: `${profile.output.assetRoot}/${input.documentSlug}/${embed.assetFileName}`,
      documentOrder: index + 1,
      sourceOccurrence: occurrence,
      sealedOutput: output,
    });
  }

  const seenTargets = new Set<string>();
  for (const target of planned) {
    const key = targetKey(target.relativePath, input.caseSensitivity);
    if (!isPortableTargetPath(target.relativePath) || seenTargets.has(key))
      return blocked(ISSUE_CODES.unsafePath);
    seenTargets.add(key);
  }

  const priorByPath = new Map(
    input.priorTargets.map((target) => [target.relativePath, target]),
  );
  if (
    priorByPath.size !== input.priorTargets.length ||
    priorByPath.size !== planned.length ||
    planned.some((target) => !priorByPath.has(target.relativePath))
  )
    return blocked(ISSUE_CODES.repositoryPreflightFailed);

  const changed = planned.some((target) => {
    const prior = priorByPath.get(target.relativePath)!.priorState;
    return (
      prior.state !== "regularFile" ||
      prior.contentSha256 !== target.sealedOutput.contentSha256
    );
  });

  const actions: ExportAction[] = changed
    ? planned.map((target) => {
        const prior = priorByPath.get(target.relativePath)!.priorState;
        const fields = {
          documentOrder: target.documentOrder,
          targetPath: target.relativePath,
          sealedOutput: target.sealedOutput,
          sourceOccurrence: target.sourceOccurrence,
        };
        return prior.state === "absent"
          ? Object.freeze({
              ...fields,
              kind: "create" as const,
              approvedPriorTarget: Object.freeze({ state: "absent" as const }),
            })
          : Object.freeze({
              ...fields,
              kind: "update" as const,
              approvedPriorTarget: Object.freeze({
                state: "regularFile" as const,
                contentSha256: prior.contentSha256,
              }),
            });
      })
    : [];

  const planTargets = orderedTargets(
    planned.map((target) => priorByPath.get(target.relativePath)!),
  );
  const targetFolderSnapshot: TargetFolderSnapshot = Object.freeze({
    targetRootRealPath: input.targetRootRealPath,
    caseSensitivity: input.caseSensitivity,
    targets: planTargets,
  });

  // Count every planned target before content-addressed collapse. Repeated
  // embeds of one image each produce a distinct action/target while sharing
  // one blob; the file-count boundary must trip on that action count, not on
  // the smaller deduped blob set.
  if (planned.length > MDX_RELAY_LIMITS.sealedOutputFiles)
    return blocked(ISSUE_CODES.outputFileLimitExceeded);

  // A ready plan seals exactly its action outputs; a no-changes plan still
  // seals every reviewable output for the preview.
  const blobs: Record<string, SealedOutput> = {};
  for (const output of changed
    ? actions.map((action) => action.sealedOutput)
    : [generatedMdx, ...outputBySource.values()])
    blobs[output.contentSha256] = output;

  const approvalSealedOutputs = Object.values(blobs).sort((left, right) =>
    compareCodeUnits(left.planRelativePath, right.planRelativePath),
  );

  if (approvalSealedOutputs.length > MDX_RELAY_LIMITS.sealedOutputFiles)
    return blocked(ISSUE_CODES.outputFileLimitExceeded);
  if (
    approvalSealedOutputs.some(
      (output) => output.byteLength > MDX_RELAY_LIMITS.sealedOutputBytes,
    )
  )
    return blocked(ISSUE_CODES.outputTooLarge);
  if (
    approvalSealedOutputs.reduce(
      (total, output) => total + output.byteLength,
      0,
    ) > MDX_RELAY_LIMITS.totalSealedOutputBytes
  )
    return blocked(ISSUE_CODES.totalOutputTooLarge);
  const approvalFingerprint: ApprovalFingerprint = Object.freeze({
    profileSnapshotSha256: input.profileSnapshotSha256,
    sourceNote: Object.freeze({
      byteLength: input.sourceNote.byteLength,
      contentSha256: input.sourceNote.contentSha256,
    }),
    dependencySnapshotSha256: input.dependencySnapshotSha256,
    sourceImages: Object.freeze(
      sourceImages.map(
        ({ sourceId, byteLength, contentSha256, transformedOutputSha256 }) =>
          Object.freeze({
            sourceId,
            byteLength,
            contentSha256,
            transformedOutputSha256,
          }),
      ),
    ),
    sealedOutputs: Object.freeze(approvalSealedOutputs),
    targetFolderSnapshot,
  });

  const barrier = input.finalCapture;
  if (
    barrier.profileSnapshotSha256 !== input.profileSnapshotSha256 ||
    barrier.dependencySnapshotSha256 !== input.dependencySnapshotSha256 ||
    barrier.sourceNote.byteLength !== input.sourceNote.byteLength ||
    barrier.sourceNote.contentSha256 !== input.sourceNote.contentSha256 ||
    !deepEquals(
      capturedImageStates(barrier.sourceImages),
      capturedImageStates(input.sourceImages),
    ) ||
    barrier.targetRootRealPath !== input.targetRootRealPath ||
    barrier.caseSensitivity !== input.caseSensitivity ||
    !deepEquals(
      orderedTargets(barrier.targets),
      orderedTargets(input.priorTargets),
    )
  )
    return blocked(ISSUE_CODES.staleDuringPlanning);

  const plan: UnsealedExportPlan = Object.freeze({
    schemaVersion: 1 as const,
    generationToken: input.generationToken,
    state: changed ? ("ready" as const) : ("no-changes" as const),
    profileSnapshot: input.profileSnapshot,
    profileSnapshotSha256: input.profileSnapshotSha256,
    sourceNote: Object.freeze({
      vaultRelativePath: input.sourceNote.vaultRelativePath,
      realPath: input.sourceNote.realPath,
      byteLength: input.sourceNote.byteLength,
      contentSha256: input.sourceNote.contentSha256,
    }),
    dependencySnapshot: input.dependencySnapshot,
    dependencySnapshotSha256: input.dependencySnapshotSha256,
    sourceImages: Object.freeze(sourceImages),
    targetFolderSnapshot,
    approvalFingerprint,
    generatedMdx,
    actions: Object.freeze(actions),
    blobs: Object.freeze(blobs),
    issues: Object.freeze([...input.warnings]),
    createdAtUtc: input.createdAtUtc,
    expiresAtUtc: input.expiresAtUtc,
  });

  const retained = new Map<string, Uint8Array>();
  for (const output of approvalSealedOutputs)
    retained.set(
      output.planRelativePath,
      blobBytes.get(output.planRelativePath)!,
    );

  // Rebuilt from the canonical sources so caller extras never travel with the
  // draft, and held in memory only: source bytes are never stored.
  const retainedSources: PlanSourceBytes = Object.freeze({
    note: input.sourceBytes.note,
    images: new Map(
      [...canonicalSources.keys()].map((sourceId) => [
        sourceId,
        input.sourceBytes.images.get(sourceId)!,
      ]),
    ),
  });

  return mdxRelayOk(
    Object.freeze({ plan, blobBytes: retained, sourceBytes: retainedSources }),
  );
}
