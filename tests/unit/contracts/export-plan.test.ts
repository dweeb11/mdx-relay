import { describe, expect, it } from "vitest";

import {
  createIssue,
  ISSUE_CODES,
  type BlockerIssue,
} from "../../../src/contracts/issues";
import {
  matchesApprovalContext,
  matchesPlanIdentity,
  type ApprovalFingerprint,
  type ApprovalRecord,
  type ApprovalSealedOutputFingerprint,
  type ApprovalSourceImageFingerprint,
  type ApprovalTransitionIdentity,
  type ApprovedPriorTarget,
  type BlockedPreviewState,
  type CanonicalDependencySnapshot,
  type GenerationToken,
  type GitFileMode,
  type NoChangesExportPlan,
  type PlanId,
  type ReadyExportPlan,
  type RepositoryFingerprint,
  type RepositoryTargetFingerprint,
  type SealedOutput,
  type Sha256Digest,
  type ValidatedPortableProfileSnapshot,
  type VerifiedReadyExportPlan,
} from "../../../src/contracts/export-plan";

const compareCodeUnitStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

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
        ({ sourceId, byteLength, contentSha256, transformedOutputSha256 }) => ({
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
        compareCodeUnitStrings(left.planRelativePath, right.planRelativePath),
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

  it("rejects case-folded target collisions only on insensitive filesystems", () => {
    const caseVariantPlan = (
      filesystemCaseSensitivity: RepositoryFingerprint["filesystemCaseSensitivity"],
    ): VerifiedReadyExportPlan => {
      const plan = structuredClone(
        completeReadyPlan(),
      ) as VerifiedReadyExportPlan;
      const repository = plan.repositoryFingerprint as unknown as {
        filesystemCaseSensitivity: RepositoryFingerprint["filesystemCaseSensitivity"];
        targets: RepositoryTargetFingerprint[];
      };
      repository.filesystemCaseSensitivity = filesystemCaseSensitivity;
      (repository.targets[1] as { normalizedPath: string }).normalizedPath =
        "Content/Post.mdx";
      repository.targets.sort((left, right) =>
        compareCodeUnitStrings(left.normalizedPath, right.normalizedPath),
      );
      (plan.actions[1] as unknown as { targetPath: string }).targetPath =
        "Content/Post.mdx";
      (
        plan.approvalFingerprint as unknown as {
          repositoryFingerprint: RepositoryFingerprint;
        }
      ).repositoryFingerprint = structuredClone(plan.repositoryFingerprint);
      return plan;
    };
    const transition = { generationToken, planId };
    const currentUtc = "2026-07-20T01:00:00.000Z";
    const sensitivePlan = caseVariantPlan("sensitive");
    expect(
      matchesApprovalContext(
        sensitivePlan,
        transition,
        sensitivePlan.approvalFingerprint,
        currentUtc,
      ),
    ).toBe(true);
    const insensitivePlan = caseVariantPlan("insensitive");
    expect(
      matchesApprovalContext(
        insensitivePlan,
        transition,
        insensitivePlan.approvalFingerprint,
        currentUtc,
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
          (f as { profileSnapshotSha256: Sha256Digest }).profileSnapshotSha256 =
            digest;
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
          (f.sourceImages[0] as { contentSha256: Sha256Digest }).contentSha256 =
            digest;
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
      expect(matchesApprovalContext(plan, transition, stale, now)).toBe(false);
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
          (f.realPaths as { repositoryRoot: string }).repositoryRoot = "/other";
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
          (f.supportedForm as { isBareRepository: boolean }).isBareRepository =
            true;
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
          (f.supportedForm as { isLinkedWorktree: boolean }).isLinkedWorktree =
            true;
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
          (f.targets[0] as { normalizedPath: string }).normalizedPath = "a.mdx";
        },
      ],
      [
        "targets[0].symlinkStatus",
        (f) => {
          (f.targets[0] as { symlinkStatus: string }).symlinkStatus = "symlink";
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
      const malformed = { ...approvalFingerprint() } as Record<string, unknown>;
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

  it("fails closed for malformed nested repository fingerprint shapes", () => {
    const transition = { generationToken, planId };
    const now = "2026-07-20T01:00:00.000Z";
    type MalformedRepositoryMutation = readonly [
      string,
      (repository: Record<string, unknown>) => void,
    ];
    const mutations: MalformedRepositoryMutation[] = [
      [
        "approvedPriorTarget",
        (repository) => {
          const targets = repository.targets as Record<string, unknown>[];
          targets[0]!.approvedPriorTarget = null;
        },
      ],
      [
        "supportedForm",
        (repository) => {
          repository.supportedForm = {};
        },
      ],
      [
        "branch",
        (repository) => {
          repository.branch = {};
        },
      ],
      [
        "oids",
        (repository) => {
          repository.oids = {};
        },
      ],
      [
        "remotes",
        (repository) => {
          repository.remotes = null;
        },
      ],
      [
        "remotes.fetch",
        (repository) => {
          (repository.remotes as Record<string, unknown>).fetch = {};
        },
      ],
      [
        "stateHashes",
        (repository) => {
          repository.stateHashes = {};
        },
      ],
      [
        "git",
        (repository) => {
          repository.git = {};
        },
      ],
      [
        "canonicalCommitAuthor",
        (repository) => {
          repository.canonicalCommitAuthor = {};
        },
      ],
      [
        "targets",
        (repository) => {
          repository.targets = null;
        },
      ],
    ];

    for (const [label, mutate] of mutations) {
      const malformed = structuredClone(completeReadyPlan()) as unknown as {
        repositoryFingerprint: Record<string, unknown>;
      };
      mutate(malformed.repositoryFingerprint);
      expect(
        matchesApprovalContext(
          malformed as unknown as VerifiedReadyExportPlan,
          transition,
          approvalFingerprint(),
          now,
        ),
        label,
      ).toBe(false);
    }

    expect(
      matchesApprovalContext(
        {
          ...completeReadyPlan(),
          profileSnapshot: "" as ValidatedPortableProfileSnapshot,
        },
        transition,
        approvalFingerprint(),
        now,
      ),
      "empty profile snapshot",
    ).toBe(false);
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
      "Plans/plan-1/blob",
      "PLANS/recovery.json",
      "outputs/CON",
      "outputs/con.blob",
      "nul/blob",
      "outputs/com1",
      "outputs/lpt9.blob",
      "outputs/blob.",
      "outputs/blob ",
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
      "content/CON",
      "content/con.mdx",
      "AUX/post.mdx",
      "content/prn.txt",
      "content/com9",
      "content/lpt1.mdx",
      "content/post.mdx.",
      "content/post.mdx ",
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

  it("binds expected git modes to the approved prior target modes", () => {
    const transition = { generationToken, planId };
    const now = "2026-07-20T01:00:00.000Z";
    const withActionMode = (
      actionIndex: number,
      expectedGitMode: GitFileMode,
    ): VerifiedReadyExportPlan => {
      const plan = structuredClone(
        completeReadyPlan(),
      ) as VerifiedReadyExportPlan;
      (
        plan.actions[actionIndex] as unknown as {
          expectedGitMode: GitFileMode;
        }
      ).expectedGitMode = expectedGitMode;
      return plan;
    };
    const chmodCreate = withActionMode(0, "100755");
    expect(
      matchesApprovalContext(
        chmodCreate,
        transition,
        chmodCreate.approvalFingerprint,
        now,
      ),
    ).toBe(false);
    const chmodUpdate = withActionMode(1, "100755");
    expect(
      matchesApprovalContext(
        chmodUpdate,
        transition,
        chmodUpdate.approvalFingerprint,
        now,
      ),
    ).toBe(false);
    const executableUpdate = structuredClone(
      completeReadyPlan(),
    ) as VerifiedReadyExportPlan;
    const setPriorMode = (target: RepositoryTargetFingerprint | undefined) => {
      (target?.approvedPriorTarget as { gitMode: GitFileMode }).gitMode =
        "100755";
    };
    setPriorMode(executableUpdate.repositoryFingerprint.targets[1]);
    setPriorMode(
      executableUpdate.approvalFingerprint.repositoryFingerprint.targets[1],
    );
    const updateAction = executableUpdate.actions[1] as unknown as {
      expectedGitMode: GitFileMode;
      approvedPriorTarget: { gitMode: GitFileMode };
    };
    updateAction.approvedPriorTarget.gitMode = "100755";
    updateAction.expectedGitMode = "100755";
    expect(
      matchesApprovalContext(
        executableUpdate,
        transition,
        executableUpdate.approvalFingerprint,
        now,
      ),
    ).toBe(true);
  });

  it("validates warning issues against the registry before trusting plans", () => {
    const transition = { generationToken, planId };
    const now = "2026-07-20T01:00:00.000Z";
    const withIssues = (issues: unknown): VerifiedReadyExportPlan =>
      ({ ...completeReadyPlan(), issues }) as VerifiedReadyExportPlan;
    const plainWarning = createIssue(ISSUE_CODES.summaryMissing);
    const decoratedWarning = createIssue(
      ISSUE_CODES.wikilinksFlattened,
      { count: 2 },
      {
        sourceRange: {
          start: { line: 1, column: 0, offset: 0 },
          end: { line: 1, column: 4, offset: 4 },
        },
        safePathLabel: "notes/example.md",
      },
    );
    expect(
      matchesApprovalContext(
        withIssues([plainWarning, decoratedWarning]),
        transition,
        approvalFingerprint(),
        now,
      ),
    ).toBe(true);
    const blocker = createBlocker();
    const rejectedIssueLists: readonly (readonly unknown[])[] = [
      [{ severity: "warning", displayDetails: { summary: "secret" } }],
      [{ ...plainWarning, displayDetails: { summary: "attacker text" } }],
      [
        {
          ...decoratedWarning,
          displayDetails: { ...decoratedWarning.displayDetails, count: -1 },
        },
      ],
      [
        {
          ...plainWarning,
          displayDetails: {
            ...plainWarning.displayDetails,
            leaked: "secret",
          },
        },
      ],
      [{ ...plainWarning, code: blocker.code }],
      [{ ...blocker, severity: "warning" }],
      [{ ...plainWarning, stage: "git" }],
      [{ ...plainWarning, recoveryActions: [] }],
      [{ ...plainWarning, extra: true }],
      [{ ...plainWarning, sourceRange: {} }],
      [{ ...plainWarning, sourceRange: { start: {}, end: {} } }],
      [
        {
          ...plainWarning,
          sourceRange: {
            start: { line: 2, column: 0, offset: 9 },
            end: { line: 1, column: 0, offset: 3 },
          },
        },
      ],
      [
        {
          ...plainWarning,
          sourceRange: {
            start: { line: 1, column: 5, offset: 3 },
            end: { line: 1, column: 2, offset: 9 },
          },
        },
      ],
      [{ ...plainWarning, safePathLabel: "../secret" }],
      [{ ...plainWarning, safePathLabel: 7 }],
      [null],
      ["warning"],
    ];
    for (const issues of rejectedIssueLists) {
      expect(
        matchesApprovalContext(
          withIssues(issues),
          transition,
          approvalFingerprint(),
          now,
        ),
        JSON.stringify(issues),
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

  it("rejects plans whose top-level duplicates diverge from approval", () => {
    const transition = { generationToken, planId };
    const now = "2026-07-20T01:00:00.000Z";
    type PlanMutation = (plan: VerifiedReadyExportPlan) => void;
    const mutations: readonly [string, PlanMutation][] = [
      [
        "profileSnapshotSha256",
        (plan) => {
          (
            plan as unknown as { profileSnapshotSha256: Sha256Digest }
          ).profileSnapshotSha256 = digest;
        },
      ],
      [
        "sourceNote.byteLength",
        (plan) => {
          (plan.sourceNote as { byteLength: number }).byteLength += 1;
        },
      ],
      [
        "dependencySnapshotSha256",
        (plan) => {
          (
            plan as unknown as { dependencySnapshotSha256: Sha256Digest }
          ).dependencySnapshotSha256 = digest;
        },
      ],
      [
        "sourceImages[0].contentSha256",
        (plan) => {
          (
            plan.sourceImages[0] as { contentSha256: Sha256Digest }
          ).contentSha256 = digest;
        },
      ],
      [
        "repositoryFingerprint.branch.currentBranch",
        (plan) => {
          (
            plan.repositoryFingerprint.branch as { currentBranch: string }
          ).currentBranch = "other";
        },
      ],
      [
        "author.name",
        (plan) => {
          (plan.author as { name: string }).name = "Other Author";
        },
      ],
    ];

    for (const [label, mutate] of mutations) {
      const plan = structuredClone(
        completeReadyPlan(),
      ) as VerifiedReadyExportPlan;
      mutate(plan);
      expect(
        matchesApprovalContext(plan, transition, plan.approvalFingerprint, now),
        label,
      ).toBe(false);
    }
  });

  it("orders sealed output paths by deterministic code-unit order", () => {
    const plan = completeReadyPlan();
    const generatedMdx = {
      ...plan.generatedMdx,
      planRelativePath: "z-output",
    };
    const imageOutput = {
      ...plan.actions[1]!.sealedOutput,
      planRelativePath: "ä-output",
    };
    const commitMessage = {
      ...plan.commitMessage,
      planRelativePath: "a-commit",
    };
    const deterministicPlan = {
      ...plan,
      generatedMdx,
      actions: [
        { ...plan.actions[0], sealedOutput: generatedMdx },
        { ...plan.actions[1], sealedOutput: imageOutput },
      ],
      blobs: {
        [generatedMdx.contentSha256]: generatedMdx,
        [imageOutput.contentSha256]: imageOutput,
        [commitMessage.contentSha256]: commitMessage,
      },
      commitMessage,
      approvalFingerprint: {
        ...plan.approvalFingerprint,
        sealedOutputs: [commitMessage, generatedMdx, imageOutput],
      },
    } as unknown as VerifiedReadyExportPlan;

    expect(
      matchesApprovalContext(
        deterministicPlan,
        { generationToken, planId },
        deterministicPlan.approvalFingerprint,
        "2026-07-20T01:00:00.000Z",
      ),
    ).toBe(true);
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
