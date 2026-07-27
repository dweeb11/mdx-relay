import {
  hasExactKeys,
  isNonemptyString,
  isNonnegativeInteger,
  isRecord,
} from "../core/predicates";
import { isMdxRelayIssue, type WarningIssue } from "./issues";
import type {
  ApprovalFingerprint,
  ApprovalSourceImageFingerprint,
  ApprovalSourceNoteFingerprint,
  ApprovedPriorTarget,
  ExportAction,
  PlanIdentity,
  ReadyExportPlan,
  RepositoryFingerprint,
  SealedOutput,
  SourceImageMetadata,
  SourceNoteMetadata,
  VerifiedReadyExportPlan,
} from "./export-plan.types";

const exactObject = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> =>
  isRecord(value) && hasExactKeys(value, keys);

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

const compareCodeUnitStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const isIsoUtc = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  )
    return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
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
const isSealedOutput = (value: unknown): value is SealedOutput =>
  exactObject(value, ["planRelativePath", "byteLength", "contentSha256"]) &&
  isPlanRelativePath(value.planRelativePath) &&
  isNonnegativeInteger(value.byteLength) &&
  isNonemptyString(value.contentSha256);
const isPlanIdentity = (value: unknown): value is PlanIdentity =>
  isRecord(value) &&
  isNonemptyString(value.generationToken) &&
  isNonemptyString(value.planId);
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

/** Stored warning issues must equal registry-owned policy exactly. */
const isWarningIssue = (value: unknown): value is WarningIssue =>
  isMdxRelayIssue(value) && value.severity === "warning";

export function matchesPlanIdentity(
  actual: unknown,
  expected: unknown,
): boolean {
  return (
    isPlanIdentity(actual) &&
    isPlanIdentity(expected) &&
    actual.generationToken === expected.generationToken &&
    actual.planId === expected.planId
  );
}

const hasFullReadyPlanShape = (value: unknown): value is ReadyExportPlan => {
  if (
    !exactObject(value, [
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
    ]) ||
    value.schemaVersion !== 1 ||
    value.state !== "ready" ||
    !isPlanIdentity(value)
  )
    return false;
  if (
    !isNonemptyString(value.profileSnapshot) ||
    !isNonemptyString(value.profileSnapshotSha256) ||
    !isNonemptyString(value.dependencySnapshot) ||
    !isNonemptyString(value.dependencySnapshotSha256)
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
  if (
    !Array.isArray(value.actions) ||
    value.actions.length === 0 ||
    !value.actions.every(isExportAction)
  )
    return false;

  const blobs = value.blobs as Record<string, SealedOutput>;
  const generatedMdx = value.generatedMdx as SealedOutput;
  const commitMessage = value.commitMessage as SealedOutput;
  const matchesBlob = (sealedOutput: SealedOutput): boolean => {
    const blob = blobs[sealedOutput.contentSha256];
    return blob !== undefined && sameValue(blob, sealedOutput);
  };
  if (
    !matchesBlob(generatedMdx) ||
    !matchesBlob(commitMessage) ||
    !value.actions.every((action) => matchesBlob(action.sealedOutput))
  )
    return false;

  const actionOutputHashes = new Set(
    value.actions.map((action) => action.sealedOutput.contentSha256),
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

  const orderedBlobOutputs = Object.values(blobs).sort((left, right) =>
    compareCodeUnitStrings(left.planRelativePath, right.planRelativePath),
  );
  if (!sameValue(orderedBlobOutputs, value.approvalFingerprint.sealedOutputs))
    return false;

  const repositoryTargets = new Map(
    value.repositoryFingerprint.targets.map((target) => [
      target.normalizedPath,
      target,
    ]),
  );
  const actionTargetPaths = new Set<string>();
  if (repositoryTargets.size !== value.actions.length) return false;
  for (const action of value.actions) {
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

/**
 * Final approval gate. Static callers must supply a fully verified ready plan;
 * runtime input is still checked fail-closed for complete shape, expiry, exact
 * post-seal identity, and every complete approval-fingerprint field.
 */
export function matchesApprovalContext(
  plan: VerifiedReadyExportPlan,
  transition: unknown,
  currentApprovalFingerprint: unknown,
  currentUtc: string,
): boolean {
  if (
    !hasFullReadyPlanShape(plan) ||
    !isPlanIdentity(transition) ||
    !isApprovalFingerprint(currentApprovalFingerprint) ||
    !isIsoUtc(currentUtc)
  )
    return false;
  const now = Date.parse(currentUtc);
  if (
    now < Date.parse(plan.createdAtUtc) ||
    now >= Date.parse(plan.expiresAtUtc)
  )
    return false;
  return (
    matchesPlanIdentity(transition, plan) &&
    sameValue(currentApprovalFingerprint, plan.approvalFingerprint)
  );
}
