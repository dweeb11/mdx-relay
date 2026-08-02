import type {
  ApprovalFingerprint,
  ApprovalSourceImageFingerprint,
  ApprovalSourceNoteFingerprint,
  ApprovedPriorTarget,
  ExportAction,
  NoChangesExportPlan,
  PlanId,
  ReadyExportPlan,
  SealedOutput,
  Sha256Digest,
  SourceImageMetadata,
  SourceNoteMetadata,
  TargetFolderSnapshot,
  VerifiedReadyExportPlan,
} from "../contracts/export-plan";
import { createIssue, ISSUE_CODES, isMdxRelayIssue } from "../contracts/issues";
import type { WarningIssue } from "../contracts/issues";
import {
  mdxRelayErr,
  mdxRelayOk,
  type MdxRelayResult,
} from "../contracts/result";
import { canonicalizeJcs, deepEquals, isWellFormedUnicode } from "../canonical";
import { sha256OfBytes, sha256OfUtf8 } from "../canonical/hash";
import { MDX_RELAY_LIMITS } from "../core/limits";
import {
  hasExactKeys,
  isNonemptyString,
  isNonnegativeInteger,
  isRecord,
} from "../core/predicates";
import { verifySourceBytes, type PlanSourceBytes } from "./build-export-plan";

/**
 * Single owner for stored-plan structural verification.
 *
 * Re-admits a parsed plan document plus blob bytes as a sealed envelope. This
 * is the hostile-input gate for both sealing (after identity construction) and
 * private-store load. It does not call `matchesApprovalContext`: that remains
 * the independent post-seal approval boundary over transition identity, a
 * recaptured fingerprint, and the live clock.
 *
 * Source note and image bytes are never stored. A restored plan carries
 * structural proof only until a live capture supplies matching bytes again;
 * only then is a ready plan branded `VerifiedReadyExportPlan`.
 */

interface SealedExportPlanEnvelopeFields {
  readonly planId: PlanId;
  readonly identityManifest: string;
  readonly blobBytes: ReadonlyMap<string, Uint8Array>;
}

export type SealedExportPlanEnvelope =
  | Readonly<
      SealedExportPlanEnvelopeFields & {
        state: "ready";
        sourceBytesVerified: true;
        plan: VerifiedReadyExportPlan;
      }
    >
  | Readonly<
      SealedExportPlanEnvelopeFields & {
        state: "ready";
        sourceBytesVerified: false;
        plan: ReadyExportPlan;
      }
    >
  | Readonly<
      SealedExportPlanEnvelopeFields & {
        state: "no-changes";
        sourceBytesVerified: boolean;
        plan: NoChangesExportPlan;
      }
    >;

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** The canonical identity of a plan: every field except generation and ID. */
export function buildPlanIdentityManifest(plan: object): string {
  const identity: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(plan))
    if (key !== "generationToken" && key !== "planId") identity[key] = value;
  return canonicalizeJcs(identity);
}

export function computePlanId(identityManifest: string): PlanId {
  return `plan-${sha256OfUtf8(identityManifest).slice("sha256:".length)}` as PlanId;
}

const CONTENT_ADDRESSED_PATH = /^[0-9a-f]{64}$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const isIsoUtc = (value: unknown): value is string => {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
};

const exactObject = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> =>
  isRecord(value) && hasExactKeys(value, keys);

const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value))
    return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
};

const sameValue = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]))
    );
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && sameValue(left[key], right[key]),
    )
  );
};

/** Win32 reserves device base names and trailing dot/space path aliases. */
const windowsReservedSegmentPattern =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const hasPortableRelativePathShape = (value: unknown): value is string => {
  if (
    !isNonemptyString(value) ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      );
    })
  )
    return false;

  return value
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.endsWith(".") &&
        !segment.endsWith(" ") &&
        !windowsReservedSegmentPattern.test(segment),
    );
};
const isPlanRelativePath = (value: unknown): value is string =>
  hasPortableRelativePathShape(value) &&
  !value.toLowerCase().startsWith("plans/");
const isTargetRelativePath = (value: unknown): value is string =>
  hasPortableRelativePathShape(value) &&
  !value.split("/").some((segment) => segment.toLowerCase() === ".git");

const isPriorTarget = (value: unknown): value is ApprovedPriorTarget => {
  if (!isRecord(value)) return false;
  if (value.state === "absent") return hasExactKeys(value, ["state"]);
  return (
    value.state === "regularFile" &&
    hasExactKeys(value, ["state", "contentSha256"]) &&
    isNonemptyString(value.contentSha256)
  );
};

const targetPathKey = (
  relativePath: string,
  caseSensitivity: TargetFolderSnapshot["caseSensitivity"],
): string =>
  caseSensitivity === "insensitive" ? relativePath.toLowerCase() : relativePath;

const isTargetFolderSnapshot = (
  value: unknown,
): value is TargetFolderSnapshot => {
  if (!exactObject(value, ["targetRootRealPath", "caseSensitivity", "targets"]))
    return false;
  if (!isNonemptyString(value.targetRootRealPath)) return false;
  if (
    value.caseSensitivity !== "sensitive" &&
    value.caseSensitivity !== "insensitive"
  )
    return false;
  if (!Array.isArray(value.targets)) return false;
  let previous = "";
  const targetKeys = new Set<string>();
  for (const target of value.targets) {
    const targetKey =
      isRecord(target) && typeof target.relativePath === "string"
        ? targetPathKey(target.relativePath, value.caseSensitivity)
        : "";
    if (
      !exactObject(target, ["relativePath", "priorState"]) ||
      !isTargetRelativePath(target.relativePath) ||
      !isPriorTarget(target.priorState) ||
      target.relativePath <= previous ||
      targetKeys.has(targetKey)
    )
      return false;
    previous = target.relativePath;
    targetKeys.add(targetKey);
  }
  return true;
};

const isSealedOutput = (value: unknown): value is SealedOutput =>
  exactObject(value, ["planRelativePath", "byteLength", "contentSha256"]) &&
  isPlanRelativePath(value.planRelativePath) &&
  isNonnegativeInteger(value.byteLength) &&
  isNonemptyString(value.contentSha256);

const isSourceNoteMetadata = (value: unknown): value is SourceNoteMetadata =>
  exactObject(value, [
    "vaultRelativePath",
    "realPath",
    "byteLength",
    "contentSha256",
  ]) &&
  isNonemptyString(value.vaultRelativePath) &&
  isNonemptyString(value.realPath) &&
  isNonnegativeInteger(value.byteLength) &&
  isNonemptyString(value.contentSha256);

const isSourceImageMetadata = (value: unknown): value is SourceImageMetadata =>
  exactObject(value, [
    "sourceId",
    "vaultRelativePath",
    "realPath",
    "decodedMime",
    "byteLength",
    "contentSha256",
    "transformedOutputSha256",
  ]) &&
  isNonemptyString(value.sourceId) &&
  isNonemptyString(value.vaultRelativePath) &&
  isNonemptyString(value.realPath) &&
  ["image/png", "image/jpeg", "image/webp"].includes(
    String(value.decodedMime),
  ) &&
  isNonnegativeInteger(value.byteLength) &&
  isNonemptyString(value.contentSha256) &&
  isNonemptyString(value.transformedOutputSha256);

const isApprovalFingerprint = (
  value: unknown,
): value is ApprovalFingerprint => {
  if (
    !exactObject(value, [
      "profileSnapshotSha256",
      "sourceNote",
      "dependencySnapshotSha256",
      "sourceImages",
      "sealedOutputs",
      "targetFolderSnapshot",
    ]) ||
    !isNonemptyString(value.profileSnapshotSha256) ||
    !isNonemptyString(value.dependencySnapshotSha256) ||
    !exactObject(value.sourceNote, ["byteLength", "contentSha256"]) ||
    !isNonnegativeInteger(value.sourceNote.byteLength) ||
    !isNonemptyString(value.sourceNote.contentSha256) ||
    !Array.isArray(value.sourceImages) ||
    !Array.isArray(value.sealedOutputs) ||
    value.sealedOutputs.length === 0 ||
    !isTargetFolderSnapshot(value.targetFolderSnapshot)
  )
    return false;
  let previousSourceId = "";
  for (const sourceImage of value.sourceImages) {
    if (
      !exactObject(sourceImage, [
        "sourceId",
        "byteLength",
        "contentSha256",
        "transformedOutputSha256",
      ]) ||
      !isNonemptyString(sourceImage.sourceId) ||
      !isNonnegativeInteger(sourceImage.byteLength) ||
      !isNonemptyString(sourceImage.contentSha256) ||
      !isNonemptyString(sourceImage.transformedOutputSha256) ||
      sourceImage.sourceId <= previousSourceId
    )
      return false;
    previousSourceId = sourceImage.sourceId;
  }
  let previousOutputPath = "";
  const outputHashes = new Set<string>();
  for (const sealedOutput of value.sealedOutputs) {
    if (
      !isSealedOutput(sealedOutput) ||
      sealedOutput.planRelativePath <= previousOutputPath ||
      outputHashes.has(sealedOutput.contentSha256)
    )
      return false;
    previousOutputPath = sealedOutput.planRelativePath;
    outputHashes.add(sealedOutput.contentSha256);
  }
  return true;
};

const isExportAction = (value: unknown): value is ExportAction =>
  exactObject(value, [
    "kind",
    "documentOrder",
    "targetPath",
    "sealedOutput",
    "sourceOccurrence",
    "approvedPriorTarget",
  ]) &&
  (value.kind === "create" || value.kind === "update") &&
  isNonnegativeInteger(value.documentOrder) &&
  isTargetRelativePath(value.targetPath) &&
  isSealedOutput(value.sealedOutput) &&
  isNonnegativeInteger(value.sourceOccurrence) &&
  isPriorTarget(value.approvedPriorTarget) &&
  ((value.kind === "create" && value.approvedPriorTarget.state === "absent") ||
    (value.kind === "update" &&
      value.approvedPriorTarget.state === "regularFile"));

const isWarningIssue = (value: unknown): value is WarningIssue =>
  isMdxRelayIssue(value) && value.severity === "warning";

const PLAN_FIELD_KEYS = [
  "schemaVersion",
  "generationToken",
  "planId",
  "state",
  "profileSnapshot",
  "profileSnapshotSha256",
  "sourceNote",
  "dependencySnapshot",
  "dependencySnapshotSha256",
  "sourceImages",
  "targetFolderSnapshot",
  "approvalFingerprint",
  "generatedMdx",
  "actions",
  "blobs",
  "issues",
  "createdAtUtc",
  "expiresAtUtc",
] as const;

/**
 * Re-derives every sealed output from its bytes. Blob paths are the lowercase
 * hex of their own digest, so a verified plan can only name single-segment
 * content-addressed files and the store never has to trust a path.
 */
const hasVerifiedBlobs = (
  blobs: unknown,
  blobBytes: ReadonlyMap<string, Uint8Array>,
): blobs is Record<string, SealedOutput> => {
  if (!isRecord(blobs)) return false;
  const entries = Object.entries(blobs);
  if (entries.length !== blobBytes.size) return false;
  if (entries.length > MDX_RELAY_LIMITS.sealedOutputFiles) return false;
  return entries.every(([recordKey, output]) => {
    if (
      !isRecord(output) ||
      typeof output.planRelativePath !== "string" ||
      !CONTENT_ADDRESSED_PATH.test(output.planRelativePath)
    )
      return false;
    const bytes = blobBytes.get(output.planRelativePath);
    if (!bytes) return false;
    const digest = sha256OfBytes(bytes);
    return (
      recordKey === digest &&
      output.contentSha256 === digest &&
      output.byteLength === bytes.byteLength &&
      output.planRelativePath === digest.slice("sha256:".length)
    );
  });
};

/**
 * Digests of sealed blobs that a source-image transform may name.
 *
 * Blob-map membership alone is not enough: a forged transform can point at the
 * generated MDX blob and still recompute a matching plan ID. Ready plans bind
 * transforms to image-embed actions (`documentOrder > 0`); the order-0 action
 * is always the document MDX. No-changes plans have no actions, so the
 * generated-MDX digest is excluded.
 */
const sealedImageTransformDigests = (
  plan: Record<string, unknown>,
): Set<string> | undefined => {
  const blobs = plan.blobs;
  const generatedMdx = plan.generatedMdx;
  if (
    !isRecord(blobs) ||
    !isRecord(generatedMdx) ||
    typeof generatedMdx.contentSha256 !== "string" ||
    !Object.prototype.hasOwnProperty.call(blobs, generatedMdx.contentSha256)
  )
    return undefined;

  if (plan.state === "ready") {
    if (!Array.isArray(plan.actions)) return undefined;
    const imageDigests = new Set<string>();
    let generatedMdxActions = 0;
    for (const action of plan.actions) {
      if (
        !isRecord(action) ||
        !isRecord(action.sealedOutput) ||
        typeof action.documentOrder !== "number" ||
        typeof action.sealedOutput.contentSha256 !== "string"
      )
        return undefined;
      const digest = action.sealedOutput.contentSha256;
      if (!Object.prototype.hasOwnProperty.call(blobs, digest))
        return undefined;
      if (digest === generatedMdx.contentSha256) {
        if (action.documentOrder !== 0) return undefined;
        generatedMdxActions += 1;
      } else {
        if (action.documentOrder === 0) return undefined;
        imageDigests.add(digest);
      }
    }
    return generatedMdxActions === 1 ? imageDigests : undefined;
  }

  if (plan.state === "no-changes") {
    const digests = new Set(Object.keys(blobs));
    digests.delete(generatedMdx.contentSha256);
    return digests;
  }

  return undefined;
};

/** Every source image must name a verified sealed image-transform blob. */
const hasVerifiedSourceImageTransforms = (
  plan: Record<string, unknown>,
): boolean => {
  const sourceImages = plan.sourceImages;
  const allowed = sealedImageTransformDigests(plan);
  if (!Array.isArray(sourceImages) || allowed === undefined) return false;
  return sourceImages.every((image) => {
    if (!isRecord(image)) return false;
    return (
      typeof image.transformedOutputSha256 === "string" &&
      allowed.has(image.transformedOutputSha256)
    );
  });
};

/** Every duplicated capture field must equal the approval fingerprint exactly. */
const mirrorsApprovalCapture = (plan: Record<string, unknown>): boolean => {
  const approval = plan.approvalFingerprint;
  const sourceNote = plan.sourceNote;
  const blobs = plan.blobs;
  if (!isRecord(approval) || !isRecord(sourceNote) || !isRecord(blobs))
    return false;
  if (
    approval.profileSnapshotSha256 !== plan.profileSnapshotSha256 ||
    approval.dependencySnapshotSha256 !== plan.dependencySnapshotSha256 ||
    !deepEquals(approval.sourceNote, {
      byteLength: sourceNote.byteLength,
      contentSha256: sourceNote.contentSha256,
    }) ||
    !deepEquals(approval.targetFolderSnapshot, plan.targetFolderSnapshot) ||
    !Array.isArray(plan.sourceImages) ||
    !plan.sourceImages.every(isRecord) ||
    !deepEquals(
      approval.sourceImages,
      plan.sourceImages.map((image) => ({
        sourceId: image.sourceId,
        byteLength: image.byteLength,
        contentSha256: image.contentSha256,
        transformedOutputSha256: image.transformedOutputSha256,
      })),
    )
  )
    return false;
  const orderedOutputs = Object.values(blobs).sort((left, right) =>
    compareCodeUnits(
      (left as SealedOutput).planRelativePath,
      (right as SealedOutput).planRelativePath,
    ),
  );
  return deepEquals(approval.sealedOutputs, orderedOutputs);
};

/**
 * Target/action count must stay inside the locked file budget even when many
 * actions share one content-addressed blob. Blob-record count is checked with
 * the bytes so a handcrafted draft cannot brand more sealed outputs than the
 * limit permits.
 */
const withinLockedOutputLimits = (
  candidate: Record<string, unknown>,
): boolean => {
  if (
    !Array.isArray(candidate.actions) ||
    candidate.actions.length > MDX_RELAY_LIMITS.sealedOutputFiles
  )
    return false;
  const snapshot = candidate.targetFolderSnapshot;
  if (
    !isRecord(snapshot) ||
    !Array.isArray(snapshot.targets) ||
    snapshot.targets.length > MDX_RELAY_LIMITS.sealedOutputFiles
  )
    return false;
  return (
    isRecord(candidate.blobs) &&
    Object.keys(candidate.blobs).length <= MDX_RELAY_LIMITS.sealedOutputFiles
  );
};

/**
 * Shared structural fields for both plan states: exact keys, snapshots,
 * metadata shapes, approval fingerprint, blob/output coupling for MDX,
 * issues, and timestamps.
 */
const hasSharedPlanStructure = (value: Record<string, unknown>): boolean => {
  if (
    !exactObject(value, PLAN_FIELD_KEYS) ||
    value.schemaVersion !== 1 ||
    typeof value.generationToken !== "string" ||
    value.generationToken.length === 0 ||
    typeof value.planId !== "string" ||
    value.planId.length === 0
  )
    return false;
  if (
    !isNonemptyString(value.profileSnapshot) ||
    !isNonemptyString(value.profileSnapshotSha256) ||
    !isNonemptyString(value.dependencySnapshot) ||
    !isNonemptyString(value.dependencySnapshotSha256) ||
    !isWellFormedUnicode(value.profileSnapshot) ||
    !isWellFormedUnicode(value.dependencySnapshot)
  )
    return false;
  if (
    !isSourceNoteMetadata(value.sourceNote) ||
    !Array.isArray(value.sourceImages) ||
    !value.sourceImages.every(isSourceImageMetadata) ||
    !isTargetFolderSnapshot(value.targetFolderSnapshot) ||
    !isApprovalFingerprint(value.approvalFingerprint)
  )
    return false;

  const approvalFingerprint = value.approvalFingerprint;
  const sourceNoteFingerprint: ApprovalSourceNoteFingerprint = {
    byteLength: value.sourceNote.byteLength,
    contentSha256: value.sourceNote.contentSha256,
  };
  const sourceImageFingerprints: ApprovalSourceImageFingerprint[] =
    value.sourceImages.map(
      ({ sourceId, byteLength, contentSha256, transformedOutputSha256 }) => ({
        sourceId,
        byteLength,
        contentSha256,
        transformedOutputSha256,
      }),
    );
  if (
    value.profileSnapshotSha256 !== approvalFingerprint.profileSnapshotSha256 ||
    !sameValue(sourceNoteFingerprint, approvalFingerprint.sourceNote) ||
    value.dependencySnapshotSha256 !==
      approvalFingerprint.dependencySnapshotSha256 ||
    !sameValue(sourceImageFingerprints, approvalFingerprint.sourceImages) ||
    !sameValue(
      value.targetFolderSnapshot,
      approvalFingerprint.targetFolderSnapshot,
    )
  )
    return false;
  if (
    !isSealedOutput(value.generatedMdx) ||
    !isRecord(value.blobs) ||
    !Object.entries(value.blobs).every(
      ([recordKey, output]) =>
        isSealedOutput(output) && recordKey === output.contentSha256,
    )
  )
    return false;

  const blobs = value.blobs as Record<string, SealedOutput>;
  const generatedMdx = value.generatedMdx as SealedOutput;
  const matchesBlob = (sealedOutput: SealedOutput): boolean => {
    const blob = blobs[sealedOutput.contentSha256];
    return blob !== undefined && sameValue(blob, sealedOutput);
  };
  if (!matchesBlob(generatedMdx)) return false;

  const orderedBlobOutputs = Object.values(blobs).sort((left, right) =>
    compareCodeUnits(left.planRelativePath, right.planRelativePath),
  );
  if (!sameValue(orderedBlobOutputs, value.approvalFingerprint.sealedOutputs))
    return false;

  if (!Array.isArray(value.issues) || !value.issues.every(isWarningIssue))
    return false;
  return (
    isIsoUtc(value.createdAtUtc) &&
    isIsoUtc(value.expiresAtUtc) &&
    Date.parse(value.createdAtUtc) < Date.parse(value.expiresAtUtc)
  );
};

/** Ready plans require non-empty actions coupled to snapshot targets and blobs. */
const hasReadyPlanStructure = (value: Record<string, unknown>): boolean => {
  if (value.state !== "ready" || !hasSharedPlanStructure(value)) return false;
  if (
    !Array.isArray(value.actions) ||
    value.actions.length === 0 ||
    !value.actions.every(isExportAction)
  )
    return false;

  const actions = value.actions;
  const blobs = value.blobs as Record<string, SealedOutput>;
  const generatedMdx = value.generatedMdx as SealedOutput;
  const snapshot = value.targetFolderSnapshot as TargetFolderSnapshot;
  const matchesBlob = (sealedOutput: SealedOutput): boolean => {
    const blob = blobs[sealedOutput.contentSha256];
    return blob !== undefined && sameValue(blob, sealedOutput);
  };
  if (!actions.every((action) => matchesBlob(action.sealedOutput)))
    return false;

  const actionOutputHashes = new Set(
    actions.map((action) => action.sealedOutput.contentSha256),
  );
  const expectedActionOutputHashes = new Set(Object.keys(blobs));
  if (
    !actionOutputHashes.has(generatedMdx.contentSha256) ||
    actionOutputHashes.size !== expectedActionOutputHashes.size ||
    ![...actionOutputHashes].every((contentSha256) =>
      expectedActionOutputHashes.has(contentSha256),
    )
  )
    return false;

  const snapshotTargets = new Map(
    snapshot.targets.map((target) => [target.relativePath, target]),
  );
  const actionTargetPaths = new Set<string>();
  if (snapshotTargets.size !== actions.length) return false;
  for (const action of actions) {
    const target = snapshotTargets.get(action.targetPath);
    if (
      actionTargetPaths.has(action.targetPath) ||
      target === undefined ||
      !sameValue(target.priorState, action.approvedPriorTarget)
    )
      return false;
    actionTargetPaths.add(action.targetPath);
  }
  return true;
};

/**
 * No-changes plans keep reviewable blobs (MDX and images) but leave actions
 * and target-folder snapshot entries genuinely empty. Image transforms may
 * name only image blobs — never the MDX digest.
 */
const hasNoChangesPlanStructure = (value: Record<string, unknown>): boolean => {
  if (value.state !== "no-changes" || !hasSharedPlanStructure(value))
    return false;
  if (!Array.isArray(value.actions) || value.actions.length !== 0) return false;
  const snapshot = value.targetFolderSnapshot as TargetFolderSnapshot;
  if (snapshot.targets.length !== 0) return false;

  const blobs = value.blobs as Record<string, SealedOutput>;
  const generatedMdx = value.generatedMdx as SealedOutput;
  const sourceImages = value.sourceImages as readonly SourceImageMetadata[];
  const imageBlobKeys = new Set(
    Object.keys(blobs).filter(
      (contentSha256) => contentSha256 !== generatedMdx.contentSha256,
    ),
  );
  const namedTransforms = new Set(
    sourceImages.map((image) => image.transformedOutputSha256),
  );
  if (namedTransforms.size !== imageBlobKeys.size) return false;
  return [...namedTransforms].every((digest) => imageBlobKeys.has(digest));
};

/**
 * Recomputes the source-note and every source-image fingerprint from the bytes
 * a live capture supplied. Duplicated metadata proves nothing here: only the
 * bytes do.
 */
const hasVerifiedSources = (
  candidate: Record<string, unknown>,
  sourceBytes: PlanSourceBytes,
): boolean => {
  const sourceNote = candidate.sourceNote;
  const sourceImages = candidate.sourceImages;
  if (
    !isRecord(sourceNote) ||
    !Array.isArray(sourceImages) ||
    typeof sourceNote.byteLength !== "number" ||
    typeof sourceNote.contentSha256 !== "string"
  )
    return false;
  const captured = [];
  for (const image of sourceImages) {
    if (
      !isRecord(image) ||
      typeof image.sourceId !== "string" ||
      typeof image.byteLength !== "number" ||
      typeof image.contentSha256 !== "string"
    )
      return false;
    captured.push({
      sourceId: image.sourceId,
      byteLength: image.byteLength,
      contentSha256: image.contentSha256 as Sha256Digest,
    });
  }
  return (
    verifySourceBytes(
      {
        byteLength: sourceNote.byteLength,
        contentSha256: sourceNote.contentSha256 as Sha256Digest,
      },
      captured,
      sourceBytes,
    ) === undefined
  );
};

/**
 * Complete structural re-admission of a parsed plan and its blob bytes.
 * Returns nothing unless every recomputed digest, mirrored capture field,
 * state-specific structural rule, and the recomputed plan ID agree.
 */
export function verifyPlanEnvelope(
  candidate: unknown,
  blobBytes: ReadonlyMap<string, Uint8Array>,
  sourceBytes: PlanSourceBytes | undefined,
): SealedExportPlanEnvelope | undefined {
  if (
    !isRecord(candidate) ||
    candidate.profileSnapshotSha256 !==
      (typeof candidate.profileSnapshot === "string" &&
      isWellFormedUnicode(candidate.profileSnapshot)
        ? sha256OfUtf8(candidate.profileSnapshot)
        : undefined) ||
    candidate.dependencySnapshotSha256 !==
      (typeof candidate.dependencySnapshot === "string" &&
      isWellFormedUnicode(candidate.dependencySnapshot)
        ? sha256OfUtf8(candidate.dependencySnapshot)
        : undefined) ||
    !hasVerifiedBlobs(candidate.blobs, blobBytes) ||
    !hasVerifiedSourceImageTransforms(candidate) ||
    !mirrorsApprovalCapture(candidate) ||
    !withinLockedOutputLimits(candidate)
  )
    return undefined;

  if (candidate.state === "ready") {
    if (!hasReadyPlanStructure(candidate)) return undefined;
  } else if (candidate.state === "no-changes") {
    if (!hasNoChangesPlanStructure(candidate)) return undefined;
  } else return undefined;

  let identityManifest: string;
  try {
    identityManifest = buildPlanIdentityManifest(candidate);
  } catch {
    return undefined;
  }
  if (computePlanId(identityManifest) !== candidate.planId) return undefined;

  const sourceBytesVerified = sourceBytes !== undefined;
  if (sourceBytes !== undefined && !hasVerifiedSources(candidate, sourceBytes))
    return undefined;

  const planId = candidate.planId as PlanId;
  const plan = deepFreeze(candidate);
  if (candidate.state !== "ready")
    return Object.freeze({
      state: "no-changes" as const,
      sourceBytesVerified,
      planId,
      identityManifest,
      plan: plan as unknown as NoChangesExportPlan,
      blobBytes,
    });
  return Object.freeze(
    sourceBytesVerified
      ? {
          state: "ready" as const,
          sourceBytesVerified: true as const,
          planId,
          identityManifest,
          plan: plan as unknown as VerifiedReadyExportPlan,
          blobBytes,
        }
      : {
          state: "ready" as const,
          sourceBytesVerified: false as const,
          planId,
          identityManifest,
          plan: plan as unknown as ReadyExportPlan,
          blobBytes,
        },
  );
}

/**
 * Load-time verifier for a plan restored from private storage. Anything that
 * does not verify is reported as tampering; a sound but elapsed plan is
 * reported as expired so the caller previews again instead of publishing.
 * Source bytes are optional because storage never holds them: a caller that
 * supplies the live bytes again gets a `sourceBytesVerified` envelope, and a
 * caller that does not gets structural proof alone and no brand.
 */
export function verifyStoredExportPlan(
  candidate: unknown,
  blobBytes: ReadonlyMap<string, Uint8Array>,
  currentUtc: string,
  sourceBytes?: PlanSourceBytes,
): MdxRelayResult<SealedExportPlanEnvelope> {
  const envelope = verifyPlanEnvelope(candidate, blobBytes, sourceBytes);
  if (
    !envelope ||
    !isIsoUtc(currentUtc) ||
    Date.parse(currentUtc) < Date.parse(envelope.plan.createdAtUtc)
  )
    return mdxRelayErr([createIssue(ISSUE_CODES.storageTampered)]);
  if (Date.parse(currentUtc) >= Date.parse(envelope.plan.expiresAtUtc))
    return mdxRelayErr([createIssue(ISSUE_CODES.planExpired)]);
  return mdxRelayOk(envelope);
}
