import {
  createIssue,
  ISSUE_CODES,
  type BlockerIssue,
  type WarningIssue,
} from "./issues";

export declare const generationTokenBrand: unique symbol;
export type GenerationToken = string & {
  readonly [generationTokenBrand]: "GenerationToken";
};
export declare const planIdBrand: unique symbol;
export type PlanId = string & { readonly [planIdBrand]: "PlanId" };
export interface PlanIdentity {
  readonly generationToken: GenerationToken;
  readonly planId: PlanId;
}
export declare const sha256Brand: unique symbol;
export type Sha256Digest = string & { readonly [sha256Brand]: "Sha256Digest" };

export declare const validatedPortableProfileSnapshotBrand: unique symbol;
export type ValidatedPortableProfileSnapshot = string & {
  readonly [validatedPortableProfileSnapshotBrand]: "ValidatedPortableProfileSnapshot";
};
export declare const canonicalDependencySnapshotBrand: unique symbol;
export type CanonicalDependencySnapshot = string & {
  readonly [canonicalDependencySnapshotBrand]: "CanonicalDependencySnapshot";
};

export interface SourceNoteMetadata {
  readonly vaultRelativePath: string;
  readonly realPath: string;
  readonly byteLength: number;
  readonly contentSha256: Sha256Digest;
}
export interface SourceImageMetadata {
  readonly sourceId: string;
  readonly vaultRelativePath: string;
  readonly realPath: string;
  readonly decodedMime: "image/png" | "image/jpeg" | "image/webp";
  readonly byteLength: number;
  readonly contentSha256: Sha256Digest;
  readonly transformedOutputSha256: Sha256Digest;
}
export interface SealedOutput {
  /** Plan-relative, never absolute and never prefixed by plans/<planId>/. */
  readonly planRelativePath: string;
  readonly byteLength: number;
  readonly contentSha256: Sha256Digest;
}
export type GitFileMode = "100644" | "100755";
export type ApprovedPriorTarget =
  | Readonly<{ state: "absent" }>
  | Readonly<{
      state: "file";
      contentSha256: Sha256Digest;
      gitMode: GitFileMode;
    }>;

interface ExportActionFields {
  readonly documentOrder: number;
  readonly targetPath: string;
  readonly expectedGitMode: GitFileMode;
  readonly sealedOutput: SealedOutput;
  readonly sourceOccurrence: number;
}
export type ExportAction =
  | Readonly<
      ExportActionFields & {
        kind: "create";
        approvedPriorTarget: Readonly<{ state: "absent" }>;
      }
    >
  | Readonly<
      ExportActionFields & {
        kind: "update";
        approvedPriorTarget: Readonly<{
          state: "file";
          contentSha256: Sha256Digest;
          gitMode: GitFileMode;
        }>;
      }
    >;

export interface CommitAuthorSnapshot {
  readonly name: string;
  readonly email: string;
}

export interface RepositoryRealPaths {
  readonly repositoryRoot: string;
  readonly gitDirectory: string;
  readonly gitCommonDirectory: string;
}

/** Exact successful preflight outcomes required for a ready plan. */
export interface SupportedRepositoryFormChecks {
  readonly isBareRepository: false;
  readonly configuredRootMatchesTopLevel: true;
  readonly gitDirectoryMatchesCommonDirectory: true;
  readonly isLinkedWorktree: false;
  readonly coreSparseCheckout: false;
  readonly extensionsWorktreeConfig: false;
  readonly worktreeSparseCheckout: false;
  readonly hasPlannedPathSubmoduleBoundary: false;
  readonly hasNestedRepositoryBoundary: false;
  readonly hasStorageOverlap: false;
  readonly effectiveFetchUrlCount: 1;
  readonly effectivePushUrlCount: 1;
}

export interface RepositoryBranchFingerprint {
  readonly currentBranch: string;
  readonly configuredBranch: string;
  readonly upstreamRemote: string;
  readonly upstreamMergeRef: string;
}
export interface RepositoryOidFingerprint {
  readonly head: string;
  readonly localUpstream: string;
  readonly pushDestinationTip: string;
}
export interface RedactedRemoteFingerprint {
  readonly sha256: Sha256Digest;
  readonly redactedDisplay: string;
}
export interface RepositoryStateHashes {
  readonly porcelainStatusSha256: Sha256Digest;
  readonly indexSha256: Sha256Digest;
  readonly relevantConfigSha256: Sha256Digest;
  readonly plannedPathAttributesSha256: Sha256Digest;
}
export interface GitRuntimeFingerprint {
  readonly executableRealPath: string;
  readonly version: string;
}
export interface RepositoryTargetFingerprint {
  /** Normalized repository-relative path; targets are ordered by this field. */
  readonly normalizedPath: string;
  /** Ready plans can only seal targets proven not to be symlinks. */
  readonly symlinkStatus: "not-symlink";
  readonly approvedPriorTarget: ApprovedPriorTarget;
}

/** Structured repository state captured for approval and rechecked at export. */
export interface RepositoryFingerprint {
  readonly realPaths: RepositoryRealPaths;
  readonly supportedForm: SupportedRepositoryFormChecks;
  readonly filesystemCaseSensitivity: "sensitive" | "insensitive";
  readonly branch: RepositoryBranchFingerprint;
  readonly oids: RepositoryOidFingerprint;
  readonly remotes: Readonly<{
    fetch: RedactedRemoteFingerprint;
    push: RedactedRemoteFingerprint;
  }>;
  readonly stateHashes: RepositoryStateHashes;
  readonly git: GitRuntimeFingerprint;
  readonly canonicalCommitAuthor: CommitAuthorSnapshot;
  readonly targets: readonly RepositoryTargetFingerprint[];
}

export interface ApprovalSourceNoteFingerprint {
  readonly byteLength: number;
  readonly contentSha256: Sha256Digest;
}
export interface ApprovalSourceImageFingerprint {
  readonly sourceId: string;
  readonly byteLength: number;
  readonly contentSha256: Sha256Digest;
  readonly transformedOutputSha256: Sha256Digest;
}
export interface ApprovalSealedOutputFingerprint {
  readonly planRelativePath: string;
  readonly byteLength: number;
  readonly contentSha256: Sha256Digest;
}
/**
 * Complete independently recapturable approval context. Ordered source images
 * and sealed outputs use sourceId and planRelativePath order respectively.
 */
export interface ApprovalFingerprint {
  readonly profileSnapshotSha256: Sha256Digest;
  readonly sourceNote: ApprovalSourceNoteFingerprint;
  readonly dependencySnapshotSha256: Sha256Digest;
  readonly sourceImages: readonly ApprovalSourceImageFingerprint[];
  readonly sealedOutputs: readonly ApprovalSealedOutputFingerprint[];
  readonly repositoryFingerprint: RepositoryFingerprint;
}

export type ExportPlanState = "ready" | "no-changes";

interface SealedExportPlanFields extends PlanIdentity {
  readonly schemaVersion: 1;
  readonly profileSnapshot: ValidatedPortableProfileSnapshot;
  readonly profileSnapshotSha256: Sha256Digest;
  readonly sourceNote: SourceNoteMetadata;
  readonly dependencySnapshot: CanonicalDependencySnapshot;
  readonly dependencySnapshotSha256: Sha256Digest;
  readonly sourceImages: readonly SourceImageMetadata[];
  readonly repositoryFingerprint: RepositoryFingerprint;
  readonly approvalFingerprint: ApprovalFingerprint;
  readonly generatedMdx: SealedOutput;
  /** Content-addressed outputs; each record key must equal output contentSha256. */
  readonly blobs: Readonly<Record<Sha256Digest, SealedOutput>>;
  readonly commitMessage: SealedOutput;
  readonly author: CommitAuthorSnapshot;
  readonly createdAtUtc: string;
  readonly expiresAtUtc: string;
}

export type ReadyExportPlan = Readonly<
  SealedExportPlanFields & {
    readonly state: "ready";
    readonly actions: readonly [ExportAction, ...ExportAction[]];
    readonly issues: readonly WarningIssue[];
  }
>;
export type NoChangesExportPlan = Readonly<
  SealedExportPlanFields & {
    readonly state: "no-changes";
    readonly actions: readonly [];
    readonly issues: readonly WarningIssue[];
  }
>;
export type ExportPlan = ReadyExportPlan | NoChangesExportPlan;

// capture -> transform -> seal -> verify -> preview -> approve
// generationToken-only pre-seal; generationToken+planId post-seal.
/** Transient blocker preview: no planId and no sealed artifacts exist. */
export interface BlockedPreviewState {
  readonly state: "blocked";
  readonly generationToken: GenerationToken;
  readonly issues: readonly [BlockerIssue, ...BlockerIssue[]];
}

/**
 * Nominal authority produced by the future T4 canonical plan verifier. Before
 * branding, that verifier MUST: canonicalize and recompute profile/dependency
 * hashes; recompute the source-note and source-image content hashes; recompute
 * every transformed and sealed-output hash and byte length; verify
 * action-to-blob equality and every blob record key/path; require the generated
 * MDX, every unique image/blob output, and commit message exactly once in the
 * ordered approvalFingerprint.sealedOutputs; require every duplicated profile,
 * source-note, dependency, source-image, sealed-output, and repository field to
 * equal approvalFingerprint; couple action targets/prior states to ordered
 * repository targets; reject expired plans and blocker-severity issues; and
 * recompute planId from the RFC 8785 identity manifest. Preview, approval, and
 * execution accept only this brand. T0 defines but does not implement the sealer.
 */
declare const verifiedReadyExportPlanBrand: unique symbol;
export type VerifiedReadyExportPlan = ReadyExportPlan & {
  readonly [verifiedReadyExportPlanBrand]: "VerifiedReadyExportPlan";
};

/** Durable approval authority contains no duplicated transient state. */
export interface ApprovalRecord {
  readonly planId: PlanId;
}
/** Post-seal rendered transition identity. */
export type ApprovalTransitionIdentity = Readonly<PlanIdentity>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
) => {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === [...keys].sort()[index])
  );
};
const isNonemptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const isNonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;
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
  for (const target of targets) {
    if (
      !exactObject(target, [
        "normalizedPath",
        "symlinkStatus",
        "approvedPriorTarget",
      ]) ||
      !isRepositoryTargetPath(target.normalizedPath) ||
      target.symlinkStatus !== "not-symlink" ||
      !isPriorTarget(target.approvedPriorTarget) ||
      target.normalizedPath <= previous
    )
      return false;
    previous = target.normalizedPath;
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
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    );
};
const isPlanRelativePath = (value: unknown): value is string =>
  hasPortableRelativePathShape(value) && !value.startsWith("plans/");
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
    left.planRelativePath.localeCompare(right.planRelativePath),
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
      !sameValue(target.approvedPriorTarget, action.approvedPriorTarget)
    )
      return false;
    actionTargetPaths.add(action.targetPath);
  }

  if (
    !Array.isArray(value.issues) ||
    !value.issues.every(
      (issue) => isRecord(issue) && issue.severity === "warning",
    )
  )
    return false;
  if (
    !exactObject(value.author, ["name", "email"]) ||
    !isNonemptyString(value.author.name) ||
    !isNonemptyString(value.author.email)
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

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  const digest = "sha256:fixture" as Sha256Digest;
  const canonicalEmptyObjectDigest =
    "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a" as Sha256Digest;
  const generatedMdxDigest =
    "sha256:da051ed12857ecf428f4d929a4b096a4a8a733a25181a0660ade992db0c95aaa" as Sha256Digest;
  const sourceImageOneDigest =
    "sha256:d7bdd545f09d8a73c2b990337c8211d708a04ccd9748627685e4fc79cc038039" as Sha256Digest;
  const sourceImageTwoDigest =
    "sha256:6987740fb624e3e9943ec5d9ac5519b72cea1b35fb4bde5719df3923a36c08f7" as Sha256Digest;
  const imageOutputDigest = sourceImageOneDigest;
  const commitMessageDigest =
    "sha256:004798f9139fd39da9fce235e552618fc0b4e7326470781051a6d27f8521f429" as Sha256Digest;
  const generationToken = "generation-1" as GenerationToken;
  const planId = "plan-1" as PlanId;
  const output = (path: string, contentSha256: Sha256Digest): SealedOutput => ({
    planRelativePath: path,
    byteLength: 4,
    contentSha256,
  });
  const repositoryFingerprint = (): RepositoryFingerprint => ({
    realPaths: {
      repositoryRoot: "/repo",
      gitDirectory: "/repo/.git",
      gitCommonDirectory: "/repo/.git",
    },
    supportedForm: {
      isBareRepository: false,
      configuredRootMatchesTopLevel: true,
      gitDirectoryMatchesCommonDirectory: true,
      isLinkedWorktree: false,
      coreSparseCheckout: false,
      extensionsWorktreeConfig: false,
      worktreeSparseCheckout: false,
      hasPlannedPathSubmoduleBoundary: false,
      hasNestedRepositoryBoundary: false,
      hasStorageOverlap: false,
      effectiveFetchUrlCount: 1,
      effectivePushUrlCount: 1,
    },
    filesystemCaseSensitivity: "sensitive",
    branch: {
      currentBranch: "main",
      configuredBranch: "main",
      upstreamRemote: "origin",
      upstreamMergeRef: "refs/heads/main",
    },
    oids: {
      head: "a".repeat(40),
      localUpstream: "a".repeat(40),
      pushDestinationTip: "a".repeat(40),
    },
    remotes: {
      fetch: {
        sha256: digest,
        redactedDisplay: "https://example.test/repo.git",
      },
      push: { sha256: digest, redactedDisplay: "ssh://example.test/repo.git" },
    },
    stateHashes: {
      porcelainStatusSha256: digest,
      indexSha256: digest,
      relevantConfigSha256: digest,
      plannedPathAttributesSha256: digest,
    },
    git: { executableRealPath: "/usr/bin/git", version: "git version 2.50.1" },
    canonicalCommitAuthor: {
      name: "Example Author",
      email: "author@example.test",
    },
    targets: [
      {
        normalizedPath: "content/post.mdx",
        symlinkStatus: "not-symlink",
        approvedPriorTarget: { state: "absent" },
      },
      {
        normalizedPath: "public/post/img-1.webp",
        symlinkStatus: "not-symlink",
        approvedPriorTarget: {
          state: "file",
          contentSha256: digest,
          gitMode: "100644",
        },
      },
    ],
  });
  const approvalFingerprint = (): ApprovalFingerprint => ({
    profileSnapshotSha256: canonicalEmptyObjectDigest,
    sourceNote: { byteLength: 4, contentSha256: digest },
    dependencySnapshotSha256: canonicalEmptyObjectDigest,
    sourceImages: [
      {
        sourceId: "image-1",
        byteLength: 4,
        contentSha256: sourceImageOneDigest,
        transformedOutputSha256: imageOutputDigest,
      },
      {
        sourceId: "image-2",
        byteLength: 4,
        contentSha256: sourceImageTwoDigest,
        transformedOutputSha256: imageOutputDigest,
      },
    ],
    sealedOutputs: [
      output("messages/commit.txt", commitMessageDigest),
      output("outputs/0001", generatedMdxDigest),
      output("outputs/0002", imageOutputDigest),
    ],
    repositoryFingerprint: repositoryFingerprint(),
  });
  const completeReadyPlan = (): VerifiedReadyExportPlan => {
    const generatedMdx = output("outputs/0001", generatedMdxDigest);
    const image = output("outputs/0002", imageOutputDigest);
    const commitMessage = output("messages/commit.txt", commitMessageDigest);
    return {
      schemaVersion: 1,
      generationToken,
      planId,
      state: "ready",
      profileSnapshot: "{}" as ValidatedPortableProfileSnapshot,
      profileSnapshotSha256: canonicalEmptyObjectDigest,
      sourceNote: {
        vaultRelativePath: "notes/example.md",
        realPath: "/vault/notes/example.md",
        byteLength: 4,
        contentSha256: digest,
      },
      dependencySnapshot: "{}" as CanonicalDependencySnapshot,
      dependencySnapshotSha256: canonicalEmptyObjectDigest,
      sourceImages: [
        {
          sourceId: "image-1",
          vaultRelativePath: "assets/image.png",
          realPath: "/vault/assets/image.png",
          decodedMime: "image/png",
          byteLength: 4,
          contentSha256: sourceImageOneDigest,
          transformedOutputSha256: imageOutputDigest,
        },
        {
          sourceId: "image-2",
          vaultRelativePath: "assets/image-copy.png",
          realPath: "/vault/assets/image-copy.png",
          decodedMime: "image/png",
          byteLength: 4,
          contentSha256: sourceImageTwoDigest,
          transformedOutputSha256: imageOutputDigest,
        },
      ],
      repositoryFingerprint: repositoryFingerprint(),
      approvalFingerprint: approvalFingerprint(),
      generatedMdx,
      actions: [
        {
          kind: "create",
          documentOrder: 0,
          targetPath: "content/post.mdx",
          expectedGitMode: "100644",
          sealedOutput: generatedMdx,
          sourceOccurrence: 0,
          approvedPriorTarget: { state: "absent" },
        },
        {
          kind: "update",
          documentOrder: 1,
          targetPath: "public/post/img-1.webp",
          expectedGitMode: "100644",
          sealedOutput: image,
          sourceOccurrence: 1,
          approvedPriorTarget: {
            state: "file",
            contentSha256: digest,
            gitMode: "100644",
          },
        },
      ],
      blobs: {
        [generatedMdxDigest]: generatedMdx,
        [imageOutputDigest]: image,
        [commitMessageDigest]: commitMessage,
      },
      commitMessage,
      author: { name: "Example Author", email: "author@example.test" },
      issues: [],
      createdAtUtc: "2026-07-20T00:00:00.000Z",
      expiresAtUtc: "2026-07-27T00:00:00.000Z",
    } as unknown as VerifiedReadyExportPlan;
  };

  describe("ExportPlan contract", () => {
    it("discriminates ready, no-changes, and unsealed blocked preview states", () => {
      const ready = completeReadyPlan();
      const noChanges = {
        ...ready,
        state: "no-changes",
        actions: [] as const,
      } satisfies NoChangesExportPlan;
      const blocked = {
        state: "blocked",
        generationToken,
        issues: [createBlocker()],
      } satisfies BlockedPreviewState;
      const invalidReady: ReadyExportPlan = {
        ...ready,
        // @ts-expect-error ready plans require a nonempty action tuple
        actions: [],
      };
      const invalidNoChanges: NoChangesExportPlan = {
        ...noChanges,
        // @ts-expect-error no-changes plans require exactly no actions
        actions: ready.actions,
      };
      void invalidReady;
      void invalidNoChanges;
      expect(ready.actions).toHaveLength(2);
      expect(noChanges.actions).toEqual([]);
      expect("planId" in blocked).toBe(false);
      expect("generatedMdx" in blocked).toBe(false);
    });

    it("uses a verifier-coherent complete ready-plan fixture", () => {
      const plan = completeReadyPlan();
      expect(Object.keys(plan.blobs).sort()).toEqual(
        [generatedMdxDigest, imageOutputDigest, commitMessageDigest].sort(),
      );
      for (const [recordKey, sealedOutput] of Object.entries(plan.blobs)) {
        expect(recordKey).toBe(sealedOutput.contentSha256);
      }
      for (const action of plan.actions) {
        expect(plan.blobs[action.sealedOutput.contentSha256]).toEqual(
          action.sealedOutput,
        );
        expect(plan.repositoryFingerprint.targets).toContainEqual({
          normalizedPath: action.targetPath,
          symlinkStatus: "not-symlink",
          approvedPriorTarget: action.approvedPriorTarget,
        });
      }
      expect(plan.blobs[plan.generatedMdx.contentSha256]).toEqual(
        plan.generatedMdx,
      );
      expect(plan.blobs[plan.commitMessage.contentSha256]).toEqual(
        plan.commitMessage,
      );
      expect(plan.sourceImages[0]?.transformedOutputSha256).toBe(
        imageOutputDigest,
      );
      expect(plan.approvalFingerprint).toEqual(approvalFingerprint());
      expect(plan.approvalFingerprint.profileSnapshotSha256).toBe(
        plan.profileSnapshotSha256,
      );
      expect(plan.approvalFingerprint.sourceNote).toEqual({
        byteLength: plan.sourceNote.byteLength,
        contentSha256: plan.sourceNote.contentSha256,
      });
      expect(plan.approvalFingerprint.dependencySnapshotSha256).toBe(
        plan.dependencySnapshotSha256,
      );
      expect(plan.approvalFingerprint.sourceImages).toEqual(
        plan.sourceImages.map(
          ({
            sourceId,
            byteLength,
            contentSha256,
            transformedOutputSha256,
          }) => ({
            sourceId,
            byteLength,
            contentSha256,
            transformedOutputSha256,
          }),
        ),
      );
      expect(plan.approvalFingerprint.repositoryFingerprint).toEqual(
        plan.repositoryFingerprint,
      );
      expect(plan.approvalFingerprint.sealedOutputs).toEqual(
        Object.values(plan.blobs).sort((left, right) =>
          left.planRelativePath.localeCompare(right.planRelativePath),
        ),
      );
    });

    it("accepts only a complete branded ready plan and explicit nonexpired UTC", () => {
      const plan = completeReadyPlan();
      const transition = {
        generationToken,
        planId,
      } satisfies ApprovalTransitionIdentity;
      expect(
        matchesApprovalContext(
          plan,
          transition,
          approvalFingerprint(),
          "2026-07-20T01:00:00.000Z",
        ),
      ).toBe(true);
      expect(
        matchesApprovalContext(
          plan,
          transition,
          approvalFingerprint(),
          plan.expiresAtUtc,
        ),
      ).toBe(false);
      expect(
        matchesApprovalContext(
          plan,
          transition,
          approvalFingerprint(),
          "not-utc",
        ),
      ).toBe(false);
      expect(
        matchesApprovalContext(
          plan,
          { ...transition, planId: "stale" as PlanId },
          approvalFingerprint(),
          "2026-07-20T01:00:00.000Z",
        ),
      ).toBe(false);
      const partial = {
        generationToken,
        planId,
        state: "ready",
        repositoryFingerprint: repositoryFingerprint(),
      };
      expect(
        matchesApprovalContext(
          partial as VerifiedReadyExportPlan,
          transition,
          approvalFingerprint(),
          "2026-07-20T01:00:00.000Z",
        ),
      ).toBe(false);
    });

    it("deep-compares every non-repository approval capture field and ordering", () => {
      const plan = completeReadyPlan();
      const transition = { generationToken, planId };
      const now = "2026-07-20T01:00:00.000Z";
      type ApprovalMutation = readonly [
        string,
        (fingerprint: ApprovalFingerprint) => void,
      ];
      const mutations: ApprovalMutation[] = [
        [
          "profileSnapshotSha256",
          (f) => {
            (
              f as { profileSnapshotSha256: Sha256Digest }
            ).profileSnapshotSha256 = digest;
          },
        ],
        [
          "sourceNote.byteLength",
          (f) => {
            (f.sourceNote as { byteLength: number }).byteLength = 5;
          },
        ],
        [
          "sourceNote.contentSha256",
          (f) => {
            (f.sourceNote as { contentSha256: Sha256Digest }).contentSha256 =
              generatedMdxDigest;
          },
        ],
        [
          "dependencySnapshotSha256",
          (f) => {
            (
              f as { dependencySnapshotSha256: Sha256Digest }
            ).dependencySnapshotSha256 = digest;
          },
        ],
        [
          "sourceImages[0].sourceId",
          (f) => {
            (f.sourceImages[0] as { sourceId: string }).sourceId = "image-0";
          },
        ],
        [
          "sourceImages[0].byteLength",
          (f) => {
            (f.sourceImages[0] as { byteLength: number }).byteLength = 5;
          },
        ],
        [
          "sourceImages[0].contentSha256",
          (f) => {
            (
              f.sourceImages[0] as { contentSha256: Sha256Digest }
            ).contentSha256 = digest;
          },
        ],
        [
          "sourceImages[0].transformedOutputSha256",
          (f) => {
            (
              f.sourceImages[0] as { transformedOutputSha256: Sha256Digest }
            ).transformedOutputSha256 = generatedMdxDigest;
          },
        ],
        [
          "sourceImages.order",
          (f) => {
            (f.sourceImages as ApprovalSourceImageFingerprint[]).reverse();
          },
        ],
        [
          "sourceImages.length",
          (f) => {
            (f.sourceImages as ApprovalSourceImageFingerprint[]).pop();
          },
        ],
        [
          "sealedOutputs[0].planRelativePath",
          (f) => {
            (
              f.sealedOutputs[0] as { planRelativePath: string }
            ).planRelativePath = "messages/changed.txt";
          },
        ],
        [
          "sealedOutputs[0].byteLength",
          (f) => {
            (f.sealedOutputs[0] as { byteLength: number }).byteLength = 5;
          },
        ],
        [
          "sealedOutputs[0].contentSha256",
          (f) => {
            (
              f.sealedOutputs[0] as { contentSha256: Sha256Digest }
            ).contentSha256 = digest;
          },
        ],
        [
          "sealedOutputs.order",
          (f) => {
            (f.sealedOutputs as ApprovalSealedOutputFingerprint[]).reverse();
          },
        ],
        [
          "sealedOutputs.length",
          (f) => {
            (f.sealedOutputs as ApprovalSealedOutputFingerprint[]).pop();
          },
        ],
      ];
      expect(mutations).toHaveLength(15);
      for (const [label, mutate] of mutations) {
        const changed = structuredClone(
          approvalFingerprint(),
        ) as ApprovalFingerprint;
        mutate(changed);
        expect(
          matchesApprovalContext(plan, transition, changed, now),
          label,
        ).toBe(false);
      }
    });

    it("rejects stale source, profile, dependency, and sealed-output recaptures", () => {
      const plan = completeReadyPlan();
      const transition = { generationToken, planId };
      const now = "2026-07-20T01:00:00.000Z";
      const staleFingerprints: ApprovalFingerprint[] = [
        {
          ...approvalFingerprint(),
          sourceNote: { byteLength: 5, contentSha256: digest },
        },
        { ...approvalFingerprint(), profileSnapshotSha256: digest },
        { ...approvalFingerprint(), dependencySnapshotSha256: digest },
        {
          ...approvalFingerprint(),
          sealedOutputs: approvalFingerprint().sealedOutputs.map(
            (sealed, index) =>
              index === 1
                ? { ...sealed, byteLength: sealed.byteLength + 1 }
                : sealed,
          ),
        },
      ];
      for (const stale of staleFingerprints) {
        expect(matchesApprovalContext(plan, transition, stale, now)).toBe(
          false,
        );
      }
    });

    it("compares every nested repository field and ordered target field", () => {
      const plan = completeReadyPlan();
      const transition = { generationToken, planId };
      const currentUtc = "2026-07-20T01:00:00.000Z";
      type RepositoryMutation = readonly [
        string,
        (fingerprint: RepositoryFingerprint) => void,
      ];
      const mutations: RepositoryMutation[] = [
        [
          "realPaths.repositoryRoot",
          (f) => {
            (f.realPaths as { repositoryRoot: string }).repositoryRoot =
              "/other";
          },
        ],
        [
          "realPaths.gitDirectory",
          (f) => {
            (f.realPaths as { gitDirectory: string }).gitDirectory =
              "/other/.git";
          },
        ],
        [
          "realPaths.gitCommonDirectory",
          (f) => {
            (f.realPaths as { gitCommonDirectory: string }).gitCommonDirectory =
              "/common";
          },
        ],
        [
          "supportedForm.isBareRepository",
          (f) => {
            (
              f.supportedForm as { isBareRepository: boolean }
            ).isBareRepository = true;
          },
        ],
        [
          "supportedForm.configuredRootMatchesTopLevel",
          (f) => {
            (
              f.supportedForm as { configuredRootMatchesTopLevel: boolean }
            ).configuredRootMatchesTopLevel = false;
          },
        ],
        [
          "supportedForm.gitDirectoryMatchesCommonDirectory",
          (f) => {
            (
              f.supportedForm as { gitDirectoryMatchesCommonDirectory: boolean }
            ).gitDirectoryMatchesCommonDirectory = false;
          },
        ],
        [
          "supportedForm.isLinkedWorktree",
          (f) => {
            (
              f.supportedForm as { isLinkedWorktree: boolean }
            ).isLinkedWorktree = true;
          },
        ],
        [
          "supportedForm.coreSparseCheckout",
          (f) => {
            (
              f.supportedForm as { coreSparseCheckout: boolean }
            ).coreSparseCheckout = true;
          },
        ],
        [
          "supportedForm.extensionsWorktreeConfig",
          (f) => {
            (
              f.supportedForm as { extensionsWorktreeConfig: boolean }
            ).extensionsWorktreeConfig = true;
          },
        ],
        [
          "supportedForm.worktreeSparseCheckout",
          (f) => {
            (
              f.supportedForm as { worktreeSparseCheckout: boolean }
            ).worktreeSparseCheckout = true;
          },
        ],
        [
          "supportedForm.hasPlannedPathSubmoduleBoundary",
          (f) => {
            (
              f.supportedForm as { hasPlannedPathSubmoduleBoundary: boolean }
            ).hasPlannedPathSubmoduleBoundary = true;
          },
        ],
        [
          "supportedForm.hasNestedRepositoryBoundary",
          (f) => {
            (
              f.supportedForm as { hasNestedRepositoryBoundary: boolean }
            ).hasNestedRepositoryBoundary = true;
          },
        ],
        [
          "supportedForm.hasStorageOverlap",
          (f) => {
            (
              f.supportedForm as { hasStorageOverlap: boolean }
            ).hasStorageOverlap = true;
          },
        ],
        [
          "supportedForm.effectiveFetchUrlCount",
          (f) => {
            (
              f.supportedForm as { effectiveFetchUrlCount: number }
            ).effectiveFetchUrlCount = 2;
          },
        ],
        [
          "supportedForm.effectivePushUrlCount",
          (f) => {
            (
              f.supportedForm as { effectivePushUrlCount: number }
            ).effectivePushUrlCount = 2;
          },
        ],
        [
          "filesystemCaseSensitivity",
          (f) => {
            (
              f as { filesystemCaseSensitivity: string }
            ).filesystemCaseSensitivity = "insensitive";
          },
        ],
        ...(
          [
            "currentBranch",
            "configuredBranch",
            "upstreamRemote",
            "upstreamMergeRef",
          ] as const
        ).map(
          (key): RepositoryMutation => [
            `branch.${key}`,
            (f) => {
              (f.branch as unknown as Record<string, string>)[key] = "changed";
            },
          ],
        ),
        ...(["head", "localUpstream", "pushDestinationTip"] as const).map(
          (key): RepositoryMutation => [
            `oids.${key}`,
            (f) => {
              (f.oids as unknown as Record<string, string>)[key] = "changed";
            },
          ],
        ),
        ...(["fetch", "push"] as const).flatMap((remote) =>
          (["sha256", "redactedDisplay"] as const).map(
            (key): RepositoryMutation => [
              `remotes.${remote}.${key}`,
              (f) => {
                (f.remotes[remote] as unknown as Record<string, string>)[key] =
                  "changed";
              },
            ],
          ),
        ),
        ...(
          [
            "porcelainStatusSha256",
            "indexSha256",
            "relevantConfigSha256",
            "plannedPathAttributesSha256",
          ] as const
        ).map(
          (key): RepositoryMutation => [
            `stateHashes.${key}`,
            (f) => {
              (f.stateHashes as unknown as Record<string, string>)[key] =
                "changed";
            },
          ],
        ),
        ...(["executableRealPath", "version"] as const).map(
          (key): RepositoryMutation => [
            `git.${key}`,
            (f) => {
              (f.git as unknown as Record<string, string>)[key] = "changed";
            },
          ],
        ),
        ...(["name", "email"] as const).map(
          (key): RepositoryMutation => [
            `canonicalCommitAuthor.${key}`,
            (f) => {
              (f.canonicalCommitAuthor as unknown as Record<string, string>)[
                key
              ] = "changed";
            },
          ],
        ),
        [
          "targets[0].normalizedPath",
          (f) => {
            (f.targets[0] as { normalizedPath: string }).normalizedPath =
              "a.mdx";
          },
        ],
        [
          "targets[0].symlinkStatus",
          (f) => {
            (f.targets[0] as { symlinkStatus: string }).symlinkStatus =
              "symlink";
          },
        ],
        [
          "targets[0].approvedPriorTarget",
          (f) => {
            (
              f.targets[0] as { approvedPriorTarget: ApprovedPriorTarget }
            ).approvedPriorTarget = {
              state: "file",
              contentSha256: digest,
              gitMode: "100644",
            };
          },
        ],
        [
          "targets[1].approvedPriorTarget.contentSha256",
          (f) => {
            (
              f.targets[1]?.approvedPriorTarget as {
                contentSha256: Sha256Digest;
              }
            ).contentSha256 = "sha256:changed" as Sha256Digest;
          },
        ],
        [
          "targets[1].approvedPriorTarget.gitMode",
          (f) => {
            (
              f.targets[1]?.approvedPriorTarget as { gitMode: GitFileMode }
            ).gitMode = "100755";
          },
        ],
        [
          "targets.order",
          (f) => {
            (f.targets as RepositoryTargetFingerprint[]).reverse();
          },
        ],
        [
          "targets.length",
          (f) => {
            (f.targets as RepositoryTargetFingerprint[]).pop();
          },
        ],
      ];
      expect(mutations).toHaveLength(42);
      for (const [label, mutate] of mutations) {
        const changed = structuredClone(
          approvalFingerprint(),
        ) as ApprovalFingerprint;
        mutate(changed.repositoryFingerprint);
        expect(
          matchesApprovalContext(plan, transition, changed, currentUtc),
          label,
        ).toBe(false);
      }
    });

    it("fails closed for malformed fingerprints and missing ready-plan top-level fields", () => {
      const plan = completeReadyPlan();
      const transition = { generationToken, planId };
      const now = "2026-07-20T01:00:00.000Z";
      for (const malformed of [
        null,
        {},
        { ...approvalFingerprint(), extra: true },
        { ...approvalFingerprint(), sourceImages: [{}] },
        {
          ...approvalFingerprint(),
          repositoryFingerprint: {
            ...repositoryFingerprint(),
            targets: [
              ...repositoryFingerprint().targets,
              repositoryFingerprint().targets[0],
            ],
          },
        },
      ]) {
        expect(matchesApprovalContext(plan, transition, malformed, now)).toBe(
          false,
        );
      }
      for (const key of [
        "profileSnapshotSha256",
        "sourceNote",
        "dependencySnapshotSha256",
        "sourceImages",
        "sealedOutputs",
        "repositoryFingerprint",
      ] as const) {
        const malformed = { ...approvalFingerprint() } as Record<
          string,
          unknown
        >;
        delete malformed[key];
        expect(
          matchesApprovalContext(plan, transition, malformed, now),
          `current.${key}`,
        ).toBe(false);
      }
      for (const key of [
        "profileSnapshot",
        "sourceNote",
        "dependencySnapshot",
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
      ] as const) {
        const malformed = { ...plan } as Record<string, unknown>;
        delete malformed[key];
        expect(
          matchesApprovalContext(
            malformed as VerifiedReadyExportPlan,
            transition,
            approvalFingerprint(),
            now,
          ),
          key,
        ).toBe(false);
      }
      const malformedPlans: readonly Record<string, unknown>[] = [
        { ...plan, sourceNote: {} },
        { ...plan, sourceImages: [{}] },
        { ...plan, generatedMdx: {} },
        { ...plan, actions: [{}] },
        {
          ...plan,
          blobs: { "sha256:wrong-key": plan.generatedMdx },
        },
        { ...plan, commitMessage: {} },
        { ...plan, author: {} },
        { ...plan, issues: [createBlocker()] },
        { ...plan, state: "no-changes" },
        {
          ...plan,
          createdAtUtc: plan.expiresAtUtc,
          expiresAtUtc: plan.createdAtUtc,
        },
        { ...plan, extra: true },
      ];
      for (const malformed of malformedPlans) {
        expect(
          matchesApprovalContext(
            malformed as VerifiedReadyExportPlan,
            transition,
            approvalFingerprint(),
            now,
          ),
          JSON.stringify(malformed),
        ).toBe(false);
      }
    });

    it("rejects unsafe sealed output paths before approval", () => {
      const transition = { generationToken, planId };
      const now = "2026-07-20T01:00:00.000Z";
      const invalidPaths = [
        "../recovery.json",
        "./blob",
        "outputs/../escape",
        "outputs//0001",
        "outputs/",
        "C:/temp/blob",
        "C:\\temp\\blob",
        "\\\\server\\share\\blob",
        "outputs\\0001",
        "outputs/\u0000blob",
        "/absolute/blob",
        "plans/plan-1/blob",
      ] as const;

      for (const planRelativePath of invalidPaths) {
        const plan = completeReadyPlan();
        const malformed = {
          ...plan,
          commitMessage: { ...plan.commitMessage, planRelativePath },
        } as VerifiedReadyExportPlan;
        expect(
          matchesApprovalContext(
            malformed,
            transition,
            plan.approvalFingerprint,
            now,
          ),
          planRelativePath,
        ).toBe(false);
      }

      expect(
        matchesApprovalContext(
          completeReadyPlan(),
          transition,
          approvalFingerprint(),
          now,
        ),
      ).toBe(true);
    });

    it("rejects unsafe repository action target paths before approval", () => {
      const transition = { generationToken, planId };
      const now = "2026-07-20T01:00:00.000Z";
      const invalidPaths = [
        "../outside.mdx",
        "./post.mdx",
        "content/../outside.mdx",
        "content//post.mdx",
        "content/",
        "C:/temp/post.mdx",
        "C:\\temp\\post.mdx",
        "\\\\server\\share\\post.mdx",
        "content\\post.mdx",
        "content/\u0000post.mdx",
        "/tmp/post.mdx",
        ".git/config",
        "content/.GIT/config",
      ] as const;

      for (const targetPath of invalidPaths) {
        const plan = completeReadyPlan();
        const malformed = {
          ...plan,
          actions: [
            { ...plan.actions[0], targetPath },
            plan.actions[1]!,
          ] as typeof plan.actions,
        } as VerifiedReadyExportPlan;
        expect(
          matchesApprovalContext(
            malformed,
            transition,
            plan.approvalFingerprint,
            now,
          ),
          targetPath,
        ).toBe(false);
      }
    });

    it("requires approved roles and actions to match the exact blob set", () => {
      const transition = { generationToken, planId };
      const now = "2026-07-20T01:00:00.000Z";
      const plan = completeReadyPlan();
      const imageOutput = plan.actions[1]!.sealedOutput;
      const mismatchedPlans = [
        {
          ...plan,
          generatedMdx: {
            ...plan.generatedMdx,
            planRelativePath: "outputs/0003",
          },
        },
        { ...plan, commitMessage: plan.generatedMdx },
        {
          ...plan,
          actions: [
            { ...plan.actions[0], sealedOutput: imageOutput },
            plan.actions[1]!,
          ],
        },
        {
          ...plan,
          approvalFingerprint: {
            ...plan.approvalFingerprint,
            sealedOutputs: plan.approvalFingerprint.sealedOutputs.slice(1),
          },
        },
      ] as const;

      for (const malformed of mismatchedPlans) {
        expect(
          matchesApprovalContext(
            malformed as VerifiedReadyExportPlan,
            transition,
            malformed.approvalFingerprint,
            now,
          ),
          JSON.stringify(malformed),
        ).toBe(false);
      }
    });

    it("keeps durable approval plan-only and post-seal transition dual-bound", () => {
      const approval = { planId } satisfies ApprovalRecord;
      const transition = {
        generationToken,
        planId,
      } satisfies ApprovalTransitionIdentity;
      expect(Object.keys(approval)).toEqual(["planId"]);
      expect(matchesPlanIdentity(transition, completeReadyPlan())).toBe(true);
      expect(
        matchesPlanIdentity(
          { ...transition, generationToken: "stale" as GenerationToken },
          completeReadyPlan(),
        ),
      ).toBe(false);
    });
  });

  function createBlocker(): BlockerIssue {
    return createIssue(ISSUE_CODES.invalidMdx);
  }
}
