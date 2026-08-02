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

/**
 * Prior state of one approved target path beneath the configured target root.
 * Symlink, containment, and file-type safety are rechecked live and are never
 * cached as trust flags here.
 */
export type TargetPriorState =
  | Readonly<{ state: "absent" }>
  | Readonly<{
      state: "regularFile";
      contentSha256: Sha256Digest;
    }>;

/** Action-coupled name for the sealed prior state of one write target. */
export type ApprovedPriorTarget = TargetPriorState;

export interface TargetSnapshotEntry {
  /** Normalized target-root-relative path; targets are ordered by this field. */
  readonly relativePath: string;
  readonly priorState: TargetPriorState;
}

/**
 * Bounded local destination state captured for approval and rechecked before
 * any write. Ready plans include one entry per create/update action; no-change
 * plans carry an empty target list.
 */
export interface TargetFolderSnapshot {
  readonly targetRootRealPath: string;
  readonly caseSensitivity: "sensitive" | "insensitive";
  readonly targets: readonly TargetSnapshotEntry[];
}

interface ExportActionFields {
  readonly documentOrder: number;
  readonly targetPath: string;
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
          state: "regularFile";
          contentSha256: Sha256Digest;
        }>;
      }
    >;

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
  readonly targetFolderSnapshot: TargetFolderSnapshot;
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
  readonly targetFolderSnapshot: TargetFolderSnapshot;
  readonly approvalFingerprint: ApprovalFingerprint;
  readonly generatedMdx: SealedOutput;
  /** Content-addressed outputs; each record key must equal output contentSha256. */
  readonly blobs: Readonly<Record<Sha256Digest, SealedOutput>>;
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
 * Nominal authority produced by the canonical plan verifier. Before branding,
 * that verifier MUST: canonicalize and recompute profile/dependency hashes;
 * recompute the source-note and source-image content hashes; recompute every
 * transformed and sealed-output hash and byte length; verify action-to-blob
 * equality and every blob record key/path; require the generated MDX and every
 * unique image/blob output exactly once in the ordered
 * approvalFingerprint.sealedOutputs; require every duplicated profile,
 * source-note, dependency, source-image, sealed-output, and target-folder
 * field to equal approvalFingerprint; couple action targets/prior states to
 * ordered target-folder snapshot entries; reject expired plans and
 * blocker-severity issues; and recompute planId from the RFC 8785 identity
 * manifest. Preview, approval, and execution accept only this brand.
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
