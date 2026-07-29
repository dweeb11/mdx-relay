import type {
  ApprovalFingerprint,
  ApprovalSourceImageFingerprint,
  ApprovalSourceNoteFingerprint,
  ApprovedPriorTarget,
  ExportAction,
  NoChangesExportPlan,
  PlanId,
  ReadyExportPlan,
  RepositoryFingerprint,
  SealedOutput,
  Sha256Digest,
  SourceImageMetadata,
  SourceNoteMetadata,
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
const isRepositoryTargetPath = (value: unknown): value is string =>
  hasPortableRelativePathShape(value) &&
  !value.split("/").some((segment) => segment.toLowerCase() === ".git");

const isPriorTarget = (value: unknown): value is ApprovedPriorTarget => {
  if (!isRecord(value)) return false;
  if (value.state === "absent") return hasExactKeys(value, ["state"]);
  return (
    value.state === "file" &&
    hasExactKeys(value, ["state", "contentSha256", "gitMode"]) &&
    isNonemptyString(value.contentSha256) &&
    (value.gitMode === "100644" || value.gitMode === "100755")
  );
};

const repositoryTargetKey = (
  normalizedPath: string,
  caseSensitivity: RepositoryFingerprint["filesystemCaseSensitivity"],
): string =>
  caseSensitivity === "insensitive"
    ? normalizedPath.toLowerCase()
    : normalizedPath;

const isRepositoryFingerprint = (
  value: unknown,
): value is RepositoryFingerprint => {
  if (
    !exactObject(value, [
      "realPaths",
      "supportedForm",
      "filesystemCaseSensitivity",
      "branch",
      "oids",
      "remotes",
      "stateHashes",
      "git",
      "canonicalCommitAuthor",
      "targets",
    ])
  )
    return false;
  const {
    realPaths,
    supportedForm,
    branch,
    oids,
    remotes,
    stateHashes,
    git,
    canonicalCommitAuthor,
    targets,
  } = value;
  if (
    !exactObject(realPaths, [
      "repositoryRoot",
      "gitDirectory",
      "gitCommonDirectory",
    ]) ||
    !Object.values(realPaths).every(isNonemptyString)
  )
    return false;
  if (
    !exactObject(supportedForm, [
      "isBareRepository",
      "configuredRootMatchesTopLevel",
      "gitDirectoryMatchesCommonDirectory",
      "isLinkedWorktree",
      "coreSparseCheckout",
      "extensionsWorktreeConfig",
      "worktreeSparseCheckout",
      "hasPlannedPathSubmoduleBoundary",
      "hasNestedRepositoryBoundary",
      "hasStorageOverlap",
      "effectiveFetchUrlCount",
      "effectivePushUrlCount",
    ])
  )
    return false;
  if (
    supportedForm.isBareRepository !== false ||
    supportedForm.configuredRootMatchesTopLevel !== true ||
    supportedForm.gitDirectoryMatchesCommonDirectory !== true ||
    supportedForm.isLinkedWorktree !== false ||
    supportedForm.coreSparseCheckout !== false ||
    supportedForm.extensionsWorktreeConfig !== false ||
    supportedForm.worktreeSparseCheckout !== false ||
    supportedForm.hasPlannedPathSubmoduleBoundary !== false ||
    supportedForm.hasNestedRepositoryBoundary !== false ||
    supportedForm.hasStorageOverlap !== false ||
    supportedForm.effectiveFetchUrlCount !== 1 ||
    supportedForm.effectivePushUrlCount !== 1
  )
    return false;
  if (
    value.filesystemCaseSensitivity !== "sensitive" &&
    value.filesystemCaseSensitivity !== "insensitive"
  )
    return false;
  if (
    !exactObject(branch, [
      "currentBranch",
      "configuredBranch",
      "upstreamRemote",
      "upstreamMergeRef",
    ]) ||
    !Object.values(branch).every(isNonemptyString)
  )
    return false;
  if (
    !exactObject(oids, ["head", "localUpstream", "pushDestinationTip"]) ||
    !Object.values(oids).every(isNonemptyString)
  )
    return false;
  if (!exactObject(remotes, ["fetch", "push"])) return false;
  for (const remote of [remotes.fetch, remotes.push])
    if (
      !exactObject(remote, ["sha256", "redactedDisplay"]) ||
      !isNonemptyString(remote.sha256) ||
      !isNonemptyString(remote.redactedDisplay)
    )
      return false;
  if (
    !exactObject(stateHashes, [
      "porcelainStatusSha256",
      "indexSha256",
      "relevantConfigSha256",
      "plannedPathAttributesSha256",
    ]) ||
    !Object.values(stateHashes).every(isNonemptyString)
  )
    return false;
  if (
    !exactObject(git, ["executableRealPath", "version"]) ||
    !Object.values(git).every(isNonemptyString)
  )
    return false;
  if (
    !exactObject(canonicalCommitAuthor, ["name", "email"]) ||
    !Object.values(canonicalCommitAuthor).every(isNonemptyString)
  )
    return false;
  if (!Array.isArray(targets)) return false;
  let previous = "";
  const targetKeys = new Set<string>();
  for (const target of targets) {
    const targetKey =
      isRecord(target) && typeof target.normalizedPath === "string"
        ? repositoryTargetKey(
            target.normalizedPath,
            value.filesystemCaseSensitivity,
          )
        : "";
    if (
      !exactObject(target, [
        "normalizedPath",
        "symlinkStatus",
        "approvedPriorTarget",
      ]) ||
      !isRepositoryTargetPath(target.normalizedPath) ||
      target.symlinkStatus !== "not-symlink" ||
      !isPriorTarget(target.approvedPriorTarget) ||
      target.normalizedPath <= previous ||
      targetKeys.has(targetKey)
    )
      return false;
    previous = target.normalizedPath;
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
      "repositoryFingerprint",
    ]) ||
    !isNonemptyString(value.profileSnapshotSha256) ||
    !isNonemptyString(value.dependencySnapshotSha256) ||
    !exactObject(value.sourceNote, ["byteLength", "contentSha256"]) ||
    !isNonnegativeInteger(value.sourceNote.byteLength) ||
    !isNonemptyString(value.sourceNote.contentSha256) ||
    !Array.isArray(value.sourceImages) ||
    !Array.isArray(value.sealedOutputs) ||
    value.sealedOutputs.length === 0 ||
    !isRepositoryFingerprint(value.repositoryFingerprint)
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
    "expectedGitMode",
    "sealedOutput",
    "sourceOccurrence",
    "approvedPriorTarget",
  ]) &&
  (value.kind === "create" || value.kind === "update") &&
  isNonnegativeInteger(value.documentOrder) &&
  isRepositoryTargetPath(value.targetPath) &&
  (value.expectedGitMode === "100644" || value.expectedGitMode === "100755") &&
  isSealedOutput(value.sealedOutput) &&
  isNonnegativeInteger(value.sourceOccurrence) &&
  isPriorTarget(value.approvedPriorTarget) &&
  ((value.kind === "create" && value.approvedPriorTarget.state === "absent") ||
    (value.kind === "update" && value.approvedPriorTarget.state === "file"));

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
  "repositoryFingerprint",
  "approvalFingerprint",
  "generatedMdx",
  "actions",
  "blobs",
  "commitMessage",
  "author",
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
 * generated MDX or commit-message blob and still recompute a matching plan ID.
 * Ready plans bind transforms to image-embed actions (`documentOrder > 0`); the
 * order-0 action is always the document MDX. No-changes plans have no actions,
 * so both the commit-message and generated-MDX digests are excluded.
 */
const sealedImageTransformDigests = (
  plan: Record<string, unknown>,
): Set<string> | undefined => {
  const blobs = plan.blobs;
  const commitMessage = plan.commitMessage;
  const generatedMdx = plan.generatedMdx;
  if (
    !isRecord(blobs) ||
    !isRecord(commitMessage) ||
    !isRecord(generatedMdx) ||
    typeof commitMessage.contentSha256 !== "string" ||
    typeof generatedMdx.contentSha256 !== "string" ||
    !Object.prototype.hasOwnProperty.call(blobs, commitMessage.contentSha256) ||
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
    digests.delete(commitMessage.contentSha256);
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
    !deepEquals(approval.repositoryFingerprint, plan.repositoryFingerprint) ||
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
  const repository = candidate.repositoryFingerprint;
  if (
    !isRecord(repository) ||
    !Array.isArray(repository.targets) ||
    repository.targets.length > MDX_RELAY_LIMITS.sealedOutputFiles
  )
    return false;
  return (
    isRecord(candidate.blobs) &&
    Object.keys(candidate.blobs).length <= MDX_RELAY_LIMITS.sealedOutputFiles
  );
};

/**
 * Shared structural fields for both plan states: exact keys, snapshots,
 * metadata shapes, approval fingerprint, blob/output coupling for MDX and
 * commit message, author/issues, and timestamps.
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
    !isRepositoryFingerprint(value.repositoryFingerprint) ||
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
      value.repositoryFingerprint,
      approvalFingerprint.repositoryFingerprint,
    )
  )
    return false;
  if (
    !isSealedOutput(value.generatedMdx) ||
    !isRecord(value.blobs) ||
    !Object.entries(value.blobs).every(
      ([recordKey, output]) =>
        isSealedOutput(output) && recordKey === output.contentSha256,
    ) ||
    !isSealedOutput(value.commitMessage)
  )
    return false;

  const blobs = value.blobs as Record<string, SealedOutput>;
  const generatedMdx = value.generatedMdx as SealedOutput;
  const commitMessage = value.commitMessage as SealedOutput;
  const matchesBlob = (sealedOutput: SealedOutput): boolean => {
    const blob = blobs[sealedOutput.contentSha256];
    return blob !== undefined && sameValue(blob, sealedOutput);
  };
  if (!matchesBlob(generatedMdx) || !matchesBlob(commitMessage)) return false;

  const orderedBlobOutputs = Object.values(blobs).sort((left, right) =>
    compareCodeUnits(left.planRelativePath, right.planRelativePath),
  );
  if (!sameValue(orderedBlobOutputs, value.approvalFingerprint.sealedOutputs))
    return false;

  if (!Array.isArray(value.issues) || !value.issues.every(isWarningIssue))
    return false;
  if (
    !exactObject(value.author, ["name", "email"]) ||
    !isNonemptyString(value.author.name) ||
    !isNonemptyString(value.author.email) ||
    !sameValue(value.author, value.repositoryFingerprint.canonicalCommitAuthor)
  )
    return false;
  return (
    isIsoUtc(value.createdAtUtc) &&
    isIsoUtc(value.expiresAtUtc) &&
    Date.parse(value.createdAtUtc) < Date.parse(value.expiresAtUtc)
  );
};

/** Ready plans require non-empty actions coupled to repository targets and blobs. */
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
  const commitMessage = value.commitMessage as SealedOutput;
  const repository = value.repositoryFingerprint as RepositoryFingerprint;
  const matchesBlob = (sealedOutput: SealedOutput): boolean => {
    const blob = blobs[sealedOutput.contentSha256];
    return blob !== undefined && sameValue(blob, sealedOutput);
  };
  if (!actions.every((action) => matchesBlob(action.sealedOutput)))
    return false;

  const actionOutputHashes = new Set(
    actions.map((action) => action.sealedOutput.contentSha256),
  );
  const expectedActionOutputHashes = new Set(
    Object.keys(blobs).filter(
      (contentSha256) => contentSha256 !== commitMessage.contentSha256,
    ),
  );
  if (
    !actionOutputHashes.has(generatedMdx.contentSha256) ||
    actionOutputHashes.size !== expectedActionOutputHashes.size ||
    ![...actionOutputHashes].every((contentSha256) =>
      expectedActionOutputHashes.has(contentSha256),
    )
  )
    return false;

  const repositoryTargets = new Map(
    repository.targets.map((target) => [target.normalizedPath, target]),
  );
  const actionTargetPaths = new Set<string>();
  if (repositoryTargets.size !== actions.length) return false;
  for (const action of actions) {
    const target = repositoryTargets.get(action.targetPath);
    if (
      actionTargetPaths.has(action.targetPath) ||
      target === undefined ||
      !sameValue(target.approvedPriorTarget, action.approvedPriorTarget) ||
      (action.approvedPriorTarget.state === "file"
        ? action.expectedGitMode !== action.approvedPriorTarget.gitMode
        : action.expectedGitMode !== "100644")
    )
      return false;
    actionTargetPaths.add(action.targetPath);
  }
  return true;
};

/**
 * No-changes plans keep reviewable blobs (MDX, images, commit message) but
 * leave actions and repository targets genuinely empty. Image transforms may
 * name only image blobs — never the MDX or commit-message digests.
 */
const hasNoChangesPlanStructure = (value: Record<string, unknown>): boolean => {
  if (value.state !== "no-changes" || !hasSharedPlanStructure(value))
    return false;
  if (!Array.isArray(value.actions) || value.actions.length !== 0) return false;
  const repository = value.repositoryFingerprint as RepositoryFingerprint;
  if (repository.targets.length !== 0) return false;

  const blobs = value.blobs as Record<string, SealedOutput>;
  const generatedMdx = value.generatedMdx as SealedOutput;
  const commitMessage = value.commitMessage as SealedOutput;
  const sourceImages = value.sourceImages as readonly SourceImageMetadata[];
  const imageBlobKeys = new Set(
    Object.keys(blobs).filter(
      (contentSha256) =>
        contentSha256 !== commitMessage.contentSha256 &&
        contentSha256 !== generatedMdx.contentSha256,
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
