import type { MdxRelayIssue } from "./issues";

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

export interface SourceImageFingerprint {
  readonly safePathLabel: string;
  readonly contentSha256: Sha256Digest;
  readonly byteLength: number;
}

export interface CaptureFingerprint {
  readonly noteSha256: Sha256Digest;
  readonly sourceImages: readonly SourceImageFingerprint[];
  readonly candidateSetSha256: Sha256Digest;
  readonly profileSnapshotSha256: Sha256Digest;
  readonly repository: RepositoryFingerprint;
}

/** Contains hashes and safe labels only; remote URLs and credentials are excluded. */
export interface RepositoryFingerprint {
  readonly repositoryIdentitySha256: Sha256Digest;
  readonly gitDirectoryIdentitySha256: Sha256Digest;
  readonly branchName: string;
  readonly headOid: string;
  readonly upstreamOid: string;
  readonly remoteTipOid: string;
  readonly indexSha256: Sha256Digest;
  readonly worktreeStatusSha256: Sha256Digest;
  readonly gitConfigurationSha256: Sha256Digest;
  readonly effectivePushDestinationSha256: Sha256Digest;
}

export interface SealedBlob {
  readonly sha256: Sha256Digest;
  readonly byteLength: number;
}

export interface ExportAction {
  readonly kind: "create" | "update";
  readonly documentOrder: number;
  readonly targetPath: string;
  readonly mode: "100644" | "100755";
  readonly blobSha256: Sha256Digest;
  readonly sourceOccurrence: number;
}

export type ExportPlanState = "ready" | "no-changes" | "blocked";

/**
 * Planning lifecycle (production execution is intentionally disconnected in T0):
 *
 * capture -> transform -> seal -> verify -> approve
 */
export interface ExportPlan extends PlanIdentity {
  readonly schemaVersion: 1;
  readonly generationToken: GenerationToken;
  readonly planId: PlanId;
  readonly state: ExportPlanState;
  readonly captureFingerprint: CaptureFingerprint;
  readonly actions: readonly ExportAction[];
  /** Content-addressed blobs are unique even when actions repeat one source embed. */
  readonly blobs: Readonly<Record<Sha256Digest, SealedBlob>>;
  readonly issues: readonly MdxRelayIssue[];
  readonly createdAtUtc: string;
  readonly expiresAtUtc: string;
}

export interface ApprovalRecord extends PlanIdentity {
  readonly repositoryFingerprint: RepositoryFingerprint;
  readonly approvedAtUtc: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const isPlanIdentity = (
  value: unknown,
): value is PlanIdentity & Record<string, unknown> =>
  isRecord(value) &&
  typeof value.generationToken === "string" &&
  typeof value.planId === "string";

const repositoryFingerprintKeys = [
  "repositoryIdentitySha256",
  "gitDirectoryIdentitySha256",
  "branchName",
  "headOid",
  "upstreamOid",
  "remoteTipOid",
  "indexSha256",
  "worktreeStatusSha256",
  "gitConfigurationSha256",
  "effectivePushDestinationSha256",
] as const satisfies readonly (keyof RepositoryFingerprint)[];

const isRepositoryFingerprint = (
  value: unknown,
): value is RepositoryFingerprint =>
  isRecord(value) &&
  repositoryFingerprintKeys.every((key) => typeof value[key] === "string");

export function matchesPlanIdentity(
  actual: unknown,
  expected: unknown,
): boolean {
  if (!isPlanIdentity(actual) || !isPlanIdentity(expected)) {
    return false;
  }
  return (
    actual.generationToken === expected.generationToken &&
    actual.planId === expected.planId
  );
}

function matchesRepositoryFingerprint(
  actual: RepositoryFingerprint,
  expected: RepositoryFingerprint,
): boolean {
  return (
    actual.repositoryIdentitySha256 === expected.repositoryIdentitySha256 &&
    actual.gitDirectoryIdentitySha256 === expected.gitDirectoryIdentitySha256 &&
    actual.branchName === expected.branchName &&
    actual.headOid === expected.headOid &&
    actual.upstreamOid === expected.upstreamOid &&
    actual.remoteTipOid === expected.remoteTipOid &&
    actual.indexSha256 === expected.indexSha256 &&
    actual.worktreeStatusSha256 === expected.worktreeStatusSha256 &&
    actual.gitConfigurationSha256 === expected.gitConfigurationSha256 &&
    actual.effectivePushDestinationSha256 ===
      expected.effectivePushDestinationSha256
  );
}

export function matchesApprovalContext(
  plan: unknown,
  approval: unknown,
  currentRepositoryFingerprint: unknown,
): boolean {
  if (
    !isPlanIdentity(plan) ||
    !isPlanIdentity(approval) ||
    !isRecord(plan.captureFingerprint) ||
    !isRepositoryFingerprint(plan.captureFingerprint.repository) ||
    !isRepositoryFingerprint(approval.repositoryFingerprint) ||
    !isRepositoryFingerprint(currentRepositoryFingerprint)
  ) {
    return false;
  }
  const approvedRepositoryFingerprint = plan.captureFingerprint.repository;
  return (
    matchesPlanIdentity(approval, plan) &&
    matchesRepositoryFingerprint(
      approval.repositoryFingerprint,
      approvedRepositoryFingerprint,
    ) &&
    matchesRepositoryFingerprint(
      currentRepositoryFingerprint,
      approvedRepositoryFingerprint,
    )
  );
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("ExportPlan contract", () => {
    it("represents duplicate embed actions sharing one sealed blob", () => {
      const blob = "sha256:shared" as Sha256Digest;
      const fingerprintDigest = "sha256:fingerprint" as Sha256Digest;
      const plan = {
        schemaVersion: 1,
        generationToken: "generation-1" as GenerationToken,
        planId: "plan-1" as PlanId,
        state: "ready",
        captureFingerprint: {
          noteSha256: fingerprintDigest,
          sourceImages: [],
          candidateSetSha256: fingerprintDigest,
          profileSnapshotSha256: fingerprintDigest,
          repository: {
            repositoryIdentitySha256: fingerprintDigest,
            gitDirectoryIdentitySha256: fingerprintDigest,
            branchName: "feat/app-560-bootstrap-contracts",
            headOid: "a".repeat(40),
            upstreamOid: "",
            remoteTipOid: "",
            indexSha256: fingerprintDigest,
            worktreeStatusSha256: fingerprintDigest,
            gitConfigurationSha256: fingerprintDigest,
            effectivePushDestinationSha256: fingerprintDigest,
          },
        },
        actions: [
          {
            kind: "create",
            documentOrder: 1,
            targetPath: "post/img-1.webp",
            mode: "100644",
            blobSha256: blob,
            sourceOccurrence: 1,
          },
          {
            kind: "create",
            documentOrder: 2,
            targetPath: "post/img-2.webp",
            mode: "100644",
            blobSha256: blob,
            sourceOccurrence: 2,
          },
        ],
        blobs: {
          [blob]: { sha256: blob, byteLength: 1234 },
        },
        issues: [],
        createdAtUtc: "2026-07-19T12:00:00.000Z",
        expiresAtUtc: "2026-07-26T12:00:00.000Z",
      } satisfies ExportPlan;

      expect(plan.actions[0]?.targetPath).not.toBe(plan.actions[1]?.targetPath);
      expect(plan.actions.map(({ blobSha256 }) => blobSha256)).toEqual([
        blob,
        blob,
      ]);
      expect(Object.keys(plan.blobs)).toEqual([blob]);
    });

    it("rejects stale generation and plan identities", () => {
      const generationToken = "generation-1" as GenerationToken;
      const planId = "plan-1" as PlanId;
      const expected = { generationToken, planId } satisfies PlanIdentity;

      expect(matchesPlanIdentity(expected, expected)).toBe(true);
      expect(
        matchesPlanIdentity(
          {
            generationToken: "stale-generation" as GenerationToken,
            planId,
          },
          expected,
        ),
      ).toBe(false);
      expect(
        matchesPlanIdentity(
          {
            generationToken,
            planId: "stale-plan" as PlanId,
          },
          expected,
        ),
      ).toBe(false);
    });

    it("fails closed for malformed and partial plan identities", () => {
      const valid = {
        generationToken: "generation-1" as GenerationToken,
        planId: "plan-1" as PlanId,
      } satisfies PlanIdentity;
      const malformed = [
        null,
        undefined,
        false,
        0,
        "identity",
        {},
        { generationToken: valid.generationToken },
        { planId: valid.planId },
        { ...valid, generationToken: 1 },
        { ...valid, planId: 1 },
      ];

      for (const value of malformed) {
        expect(matchesPlanIdentity(value, valid)).toBe(false);
        expect(matchesPlanIdentity(valid, value)).toBe(false);
      }
      expect(matchesPlanIdentity(valid, { ...valid })).toBe(true);
    });

    it("requires approval for the exact current repository fingerprint", () => {
      const generationToken = "generation-1" as GenerationToken;
      const planId = "plan-1" as PlanId;
      const digest = "sha256:fixture" as Sha256Digest;
      const repositoryFingerprint = {
        repositoryIdentitySha256: digest,
        gitDirectoryIdentitySha256: digest,
        branchName: "feat/app-560-bootstrap-contracts",
        headOid: "a".repeat(40),
        upstreamOid: "b".repeat(40),
        remoteTipOid: "b".repeat(40),
        indexSha256: digest,
        worktreeStatusSha256: digest,
        gitConfigurationSha256: digest,
        effectivePushDestinationSha256: digest,
      } satisfies RepositoryFingerprint;
      const plan = {
        schemaVersion: 1,
        generationToken,
        planId,
        state: "ready",
        captureFingerprint: {
          noteSha256: digest,
          sourceImages: [],
          candidateSetSha256: digest,
          profileSnapshotSha256: digest,
          repository: repositoryFingerprint,
        },
        actions: [],
        blobs: {},
        issues: [],
        createdAtUtc: "2026-07-19T12:00:00.000Z",
        expiresAtUtc: "2026-07-26T12:00:00.000Z",
      } satisfies ExportPlan;
      const approval = {
        generationToken,
        planId,
        repositoryFingerprint,
        approvedAtUtc: "2026-07-19T12:01:00.000Z",
      } satisfies ApprovalRecord;
      const fingerprintMutations = {
        repositoryIdentitySha256:
          "sha256:changed-repository-identity" as Sha256Digest,
        gitDirectoryIdentitySha256:
          "sha256:changed-git-directory-identity" as Sha256Digest,
        branchName: "feat/changed-branch",
        headOid: "c".repeat(40),
        upstreamOid: "d".repeat(40),
        remoteTipOid: "e".repeat(40),
        indexSha256: "sha256:changed-index" as Sha256Digest,
        worktreeStatusSha256: "sha256:changed-worktree-status" as Sha256Digest,
        gitConfigurationSha256:
          "sha256:changed-git-configuration" as Sha256Digest,
        effectivePushDestinationSha256:
          "sha256:changed-push-destination" as Sha256Digest,
      } satisfies {
        readonly [Key in keyof RepositoryFingerprint]: RepositoryFingerprint[Key];
      };

      expect(
        matchesApprovalContext(plan, approval, repositoryFingerprint),
      ).toBe(true);
      expect(
        matchesApprovalContext(
          plan,
          {
            ...approval,
            generationToken: "generation-stale" as GenerationToken,
          },
          repositoryFingerprint,
        ),
      ).toBe(false);
      expect(
        matchesApprovalContext(
          plan,
          { ...approval, planId: "plan-stale" as PlanId },
          repositoryFingerprint,
        ),
      ).toBe(false);
      for (const key of Object.keys(
        fingerprintMutations,
      ) as (keyof RepositoryFingerprint)[]) {
        const mutation = fingerprintMutations[key];
        expect(mutation, key).not.toBe(repositoryFingerprint[key]);
        expect(
          matchesApprovalContext(plan, approval, {
            ...repositoryFingerprint,
            [key]: mutation,
          }),
          `current fingerprint: ${key}`,
        ).toBe(false);
        expect(
          matchesApprovalContext(
            plan,
            {
              ...approval,
              repositoryFingerprint: {
                ...repositoryFingerprint,
                [key]: mutation,
              },
            },
            repositoryFingerprint,
          ),
          `stored approval fingerprint: ${key}`,
        ).toBe(false);
      }

      const partialFingerprint = { ...repositoryFingerprint } as Record<
        string,
        unknown
      >;
      delete partialFingerprint.remoteTipOid;
      const malformedCases: readonly [unknown, unknown, unknown][] = [
        [null, approval, repositoryFingerprint],
        [{}, approval, repositoryFingerprint],
        [
          { ...plan, captureFingerprint: null },
          approval,
          repositoryFingerprint,
        ],
        [{ ...plan, captureFingerprint: {} }, approval, repositoryFingerprint],
        [plan, null, repositoryFingerprint],
        [plan, {}, repositoryFingerprint],
        [
          plan,
          { ...approval, repositoryFingerprint: {} },
          repositoryFingerprint,
        ],
        [
          { ...plan, captureFingerprint: { repository: partialFingerprint } },
          approval,
          repositoryFingerprint,
        ],
        [
          plan,
          { ...approval, repositoryFingerprint: partialFingerprint },
          repositoryFingerprint,
        ],
        [plan, approval, null],
        [plan, approval, {}],
        [plan, approval, partialFingerprint],
        [plan, approval, { ...repositoryFingerprint, branchName: 1 }],
      ];

      for (const values of malformedCases) {
        expect(matchesApprovalContext(...values)).toBe(false);
      }
    });
  });
}
