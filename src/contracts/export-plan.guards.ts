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
  SealedOutput,
  SourceImageMetadata,
  SourceNoteMetadata,
  TargetFolderSnapshot,
  TargetOutputAssociation,
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
const isTargetRelativePath = (value: unknown): value is string =>
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

const isTargetOutputAssociation = (
  value: unknown,
): value is TargetOutputAssociation =>
  exactObject(value, [
    "documentOrder",
    "targetPath",
    "sealedOutput",
    "sourceOccurrence",
  ]) &&
  isNonnegativeInteger(value.documentOrder) &&
  isTargetRelativePath(value.targetPath) &&
  isSealedOutput(value.sealedOutput) &&
  isNonnegativeInteger(value.sourceOccurrence);

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
      "targetFolderSnapshot",
      "approvalFingerprint",
      "generatedMdx",
      "targetOutputs",
      "actions",
      "blobs",
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
  if (
    !Array.isArray(value.actions) ||
    value.actions.length === 0 ||
    !value.actions.every(isExportAction)
  )
    return false;
  if (
    !Array.isArray(value.targetOutputs) ||
    value.targetOutputs.length !== value.actions.length ||
    !value.targetOutputs.every(isTargetOutputAssociation)
  )
    return false;

  const targetOutputs = value.targetOutputs;
  const blobs = value.blobs as Record<string, SealedOutput>;
  const generatedMdx = value.generatedMdx as SealedOutput;
  const matchesBlob = (sealedOutput: SealedOutput): boolean => {
    const blob = blobs[sealedOutput.contentSha256];
    return blob !== undefined && sameValue(blob, sealedOutput);
  };
  if (
    !matchesBlob(generatedMdx) ||
    !value.actions.every((action) => matchesBlob(action.sealedOutput)) ||
    value.actions.some(
      (action, index) =>
        !sameValue(action.sealedOutput, targetOutputs[index]!.sealedOutput) ||
        action.documentOrder !== targetOutputs[index]!.documentOrder ||
        action.targetPath !== targetOutputs[index]!.targetPath ||
        action.sourceOccurrence !== targetOutputs[index]!.sourceOccurrence,
    )
  )
    return false;

  const actionOutputHashes = new Set(
    value.actions.map((action) => action.sealedOutput.contentSha256),
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

  const orderedBlobOutputs = Object.values(blobs).sort((left, right) =>
    compareCodeUnitStrings(left.planRelativePath, right.planRelativePath),
  );
  if (!sameValue(orderedBlobOutputs, value.approvalFingerprint.sealedOutputs))
    return false;

  const snapshotTargets = new Map(
    value.targetFolderSnapshot.targets.map((target) => [
      target.relativePath,
      target,
    ]),
  );
  const actionTargetPaths = new Set<string>();
  if (snapshotTargets.size !== value.actions.length) return false;
  for (const action of value.actions) {
    const target = snapshotTargets.get(action.targetPath);
    if (
      actionTargetPaths.has(action.targetPath) ||
      target === undefined ||
      !sameValue(target.priorState, action.approvedPriorTarget)
    )
      return false;
    actionTargetPaths.add(action.targetPath);
  }

  if (!Array.isArray(value.issues) || !value.issues.every(isWarningIssue))
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
