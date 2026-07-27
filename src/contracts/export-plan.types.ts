import type { BlockerIssue, WarningIssue } from "./issues";

declare const generationTokenBrand: unique symbol;
export type GenerationToken = string & {
  readonly [generationTokenBrand]: "GenerationToken";
};
declare const planIdBrand: unique symbol;
export type PlanId = string & { readonly [planIdBrand]: "PlanId" };
export interface PlanIdentity {
  readonly generationToken: GenerationToken;
  readonly planId: PlanId;
}
declare const sha256Brand: unique symbol;
export type Sha256Digest = string & { readonly [sha256Brand]: "Sha256Digest" };

declare const validatedPortableProfileSnapshotBrand: unique symbol;
export type ValidatedPortableProfileSnapshot = string & {
  readonly [validatedPortableProfileSnapshotBrand]: "ValidatedPortableProfileSnapshot";
};
declare const canonicalDependencySnapshotBrand: unique symbol;
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
  /** Plan-relative, never absolute, never under plans/ in any case form. */
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
  /** Updates must preserve the approved prior mode; creates seal "100644". */
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
