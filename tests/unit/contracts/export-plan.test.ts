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
  type BlockedPreviewState,
  type CanonicalDependencySnapshot,
  type GenerationToken,
  type NoChangesExportPlan,
  type PlanId,
  type ReadyExportPlan,
  type SealedOutput,
  type Sha256Digest,
  type TargetFolderSnapshot,
  type ValidatedPortableProfileSnapshot,
  type VerifiedReadyExportPlan,
} from "../../../src/contracts/export-plan";
import { parsePortableProfile } from "../../../src/profiles/parse-portable-profile";
import { validateMachineBinding } from "../../../src/profiles/machine-binding";
import { validatePortableProfile } from "../../../src/profiles/portable-profile";
import { DPW_MIND_NET_V1 } from "../../../src/profiles/builtins/dpw-mind-net-v1";

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
const generationToken = "generation-1" as GenerationToken;
const planId = "plan-1" as PlanId;
const output = (path: string, contentSha256: Sha256Digest): SealedOutput => ({
  planRelativePath: path,
  byteLength: 4,
  contentSha256,
});

const targetFolderSnapshot = (): TargetFolderSnapshot => ({
  targetRootRealPath: "/repo/target",
  caseSensitivity: "sensitive",
  targets: [
    {
      relativePath: "content/post.mdx",
      priorState: { state: "absent" },
    },
    {
      relativePath: "public/post/img-1.webp",
      priorState: {
        state: "regularFile",
        contentSha256: digest,
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
    output("outputs/0001", generatedMdxDigest),
    output("outputs/0002", imageOutputDigest),
  ],
  targetFolderSnapshot: targetFolderSnapshot(),
});

const completeReadyPlan = (): VerifiedReadyExportPlan => {
  const generatedMdx = output("outputs/0001", generatedMdxDigest);
  const image = output("outputs/0002", imageOutputDigest);
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
    targetFolderSnapshot: targetFolderSnapshot(),
    approvalFingerprint: approvalFingerprint(),
    generatedMdx,
    targetOutputs: [
      {
        documentOrder: 0,
        targetPath: "content/post.mdx",
        sealedOutput: generatedMdx,
        sourceOccurrence: 0,
      },
      {
        documentOrder: 1,
        targetPath: "public/post/img-1.webp",
        sealedOutput: image,
        sourceOccurrence: 1,
      },
    ],
    actions: [
      {
        kind: "create",
        documentOrder: 0,
        targetPath: "content/post.mdx",
        sealedOutput: generatedMdx,
        sourceOccurrence: 0,
        approvedPriorTarget: { state: "absent" },
      },
      {
        kind: "update",
        documentOrder: 1,
        targetPath: "public/post/img-1.webp",
        sealedOutput: image,
        sourceOccurrence: 1,
        approvedPriorTarget: {
          state: "regularFile",
          contentSha256: digest,
        },
      },
    ],
    blobs: {
      [generatedMdxDigest]: generatedMdx,
      [imageOutputDigest]: image,
    },
    issues: [],
    createdAtUtc: "2026-07-20T00:00:00.000Z",
    expiresAtUtc: "2026-07-27T00:00:00.000Z",
  } as unknown as VerifiedReadyExportPlan;
};

const createBlocker = (): BlockerIssue => createIssue(ISSUE_CODES.invalidMdx);

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
    expect(noChanges.targetFolderSnapshot.targets).toEqual(
      ready.targetFolderSnapshot.targets,
    );
    expect("planId" in blocked).toBe(false);
    expect("generatedMdx" in blocked).toBe(false);
  });

  it("uses a verifier-coherent complete ready-plan fixture", () => {
    const plan = completeReadyPlan();
    expect(Object.keys(plan.blobs).sort()).toEqual(
      [generatedMdxDigest, imageOutputDigest].sort(),
    );
    for (const [recordKey, sealedOutput] of Object.entries(plan.blobs)) {
      expect(recordKey).toBe(sealedOutput.contentSha256);
    }
    for (const action of plan.actions) {
      expect(plan.blobs[action.sealedOutput.contentSha256]).toEqual(
        action.sealedOutput,
      );
      expect(plan.targetFolderSnapshot.targets).toContainEqual({
        relativePath: action.targetPath,
        priorState: action.approvedPriorTarget,
      });
    }
    expect(plan.blobs[plan.generatedMdx.contentSha256]).toEqual(
      plan.generatedMdx,
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
    expect(plan.approvalFingerprint.targetFolderSnapshot).toEqual(
      plan.targetFolderSnapshot,
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
      targetFolderSnapshot: targetFolderSnapshot(),
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
      caseSensitivity: TargetFolderSnapshot["caseSensitivity"],
    ): VerifiedReadyExportPlan => {
      const plan = structuredClone(
        completeReadyPlan(),
      ) as VerifiedReadyExportPlan;
      const snapshot = plan.targetFolderSnapshot as unknown as {
        caseSensitivity: TargetFolderSnapshot["caseSensitivity"];
        targets: { relativePath: string; priorState: unknown }[];
      };
      snapshot.caseSensitivity = caseSensitivity;
      snapshot.targets[1]!.relativePath = "Content/Post.mdx";
      snapshot.targets.sort((left, right) =>
        compareCodeUnitStrings(left.relativePath, right.relativePath),
      );
      (plan.actions[1] as unknown as { targetPath: string }).targetPath =
        "Content/Post.mdx";
      (plan.targetOutputs[1] as unknown as { targetPath: string }).targetPath =
        "Content/Post.mdx";
      (
        plan.approvalFingerprint as unknown as {
          targetFolderSnapshot: TargetFolderSnapshot;
        }
      ).targetFolderSnapshot = structuredClone(plan.targetFolderSnapshot);
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

  it("deep-compares every non-target-folder approval capture field and ordering", () => {
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
          ).planRelativePath = "outputs/changed";
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
            index === 0
              ? { ...sealed, byteLength: sealed.byteLength + 1 }
              : sealed,
        ),
      },
    ];
    for (const stale of staleFingerprints) {
      expect(matchesApprovalContext(plan, transition, stale, now)).toBe(false);
    }
  });

  it("invalidates approval on target-root, target-set, and content-hash changes", () => {
    const plan = completeReadyPlan();
    const transition = { generationToken, planId };
    const currentUtc = "2026-07-20T01:00:00.000Z";
    type SnapshotMutation = readonly [
      string,
      (snapshot: TargetFolderSnapshot) => void,
    ];
    const mutations: SnapshotMutation[] = [
      [
        "targetRootRealPath",
        (f) => {
          (f as { targetRootRealPath: string }).targetRootRealPath =
            "/other/target";
        },
      ],
      [
        "caseSensitivity",
        (f) => {
          (f as { caseSensitivity: string }).caseSensitivity = "insensitive";
        },
      ],
      [
        "targets[0].relativePath",
        (f) => {
          (f.targets[0] as { relativePath: string }).relativePath =
            "content/other.mdx";
        },
      ],
      [
        "targets[0].priorState.create-to-update",
        (f) => {
          (f.targets[0] as { priorState: unknown }).priorState = {
            state: "regularFile",
            contentSha256: digest,
          };
        },
      ],
      [
        "targets[1].priorState.contentSha256",
        (f) => {
          (
            f.targets[1]?.priorState as { contentSha256: Sha256Digest }
          ).contentSha256 = generatedMdxDigest;
        },
      ],
      [
        "targets[1].priorState.update-to-absent",
        (f) => {
          (f.targets[1] as { priorState: unknown }).priorState = {
            state: "absent",
          };
        },
      ],
      [
        "targets.order",
        (f) => {
          (
            f.targets as TargetFolderSnapshot["targets"] as unknown as unknown[]
          ).reverse();
        },
      ],
      [
        "targets.length.remove",
        (f) => {
          (f.targets as unknown as unknown[]).pop();
        },
      ],
      [
        "targets.length.create",
        (f) => {
          (f.targets as unknown as unknown[]).push({
            relativePath: "zz/extra.mdx",
            priorState: { state: "absent" },
          });
        },
      ],
    ];
    expect(mutations).toHaveLength(9);
    for (const [label, mutate] of mutations) {
      const changed = structuredClone(
        approvalFingerprint(),
      ) as ApprovalFingerprint;
      mutate(changed.targetFolderSnapshot);
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
        targetFolderSnapshot: {
          ...targetFolderSnapshot(),
          targets: [
            ...targetFolderSnapshot().targets,
            targetFolderSnapshot().targets[0]!,
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
      "targetFolderSnapshot",
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
      "targetFolderSnapshot",
      "approvalFingerprint",
      "generatedMdx",
      "targetOutputs",
      "actions",
      "blobs",
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
      { ...plan, targetOutputs: [{}] },
      { ...plan, actions: [{}] },
      {
        ...plan,
        blobs: { "sha256:wrong-key": plan.generatedMdx },
      },
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
      let accepted: boolean;
      try {
        accepted = matchesApprovalContext(
          malformed as VerifiedReadyExportPlan,
          transition,
          approvalFingerprint(),
          now,
        );
      } catch {
        accepted = false;
      }
      expect(accepted).toBe(false);
    }
  });

  it("fails closed for malformed nested target-folder snapshot shapes", () => {
    const transition = { generationToken, planId };
    const now = "2026-07-20T01:00:00.000Z";
    type MalformedSnapshotMutation = readonly [
      string,
      (snapshot: Record<string, unknown>) => void,
    ];
    const mutations: MalformedSnapshotMutation[] = [
      [
        "priorState",
        (snapshot) => {
          const targets = snapshot.targets as Record<string, unknown>[];
          targets[0]!.priorState = null;
        },
      ],
      [
        "caseSensitivity",
        (snapshot) => {
          snapshot.caseSensitivity = "unknown";
        },
      ],
      [
        "targetRootRealPath",
        (snapshot) => {
          snapshot.targetRootRealPath = "";
        },
      ],
      [
        "targets",
        (snapshot) => {
          snapshot.targets = null;
        },
      ],
      [
        "legacy state:file",
        (snapshot) => {
          const targets = snapshot.targets as Record<string, unknown>[];
          targets[1]!.priorState = {
            state: "file",
            contentSha256: digest,
          };
        },
      ],
      [
        "legacy symlinkStatus",
        (snapshot) => {
          const targets = snapshot.targets as Record<string, unknown>[];
          targets[0]!.symlinkStatus = "not-symlink";
        },
      ],
      [
        "legacy gitMode",
        (snapshot) => {
          const targets = snapshot.targets as Record<string, unknown>[];
          targets[1]!.priorState = {
            state: "regularFile",
            contentSha256: digest,
            gitMode: "100644",
          };
        },
      ],
    ];

    for (const [label, mutate] of mutations) {
      const malformed = structuredClone(completeReadyPlan()) as unknown as {
        targetFolderSnapshot: Record<string, unknown>;
      };
      mutate(malformed.targetFolderSnapshot);
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
      "Plans/escape",
    ] as const;

    for (const planRelativePath of invalidPaths) {
      const plan = completeReadyPlan();
      const generatedMdx = { ...plan.generatedMdx, planRelativePath };
      const malformed = {
        ...plan,
        generatedMdx,
        blobs: {
          [generatedMdxDigest]: generatedMdx,
          [imageOutputDigest]: plan.blobs[imageOutputDigest]!,
        },
        approvalFingerprint: {
          ...plan.approvalFingerprint,
          sealedOutputs: [generatedMdx, plan.blobs[imageOutputDigest]!].sort(
            (left, right) =>
              compareCodeUnitStrings(
                left.planRelativePath,
                right.planRelativePath,
              ),
          ),
        },
      } as VerifiedReadyExportPlan;
      expect(
        matchesApprovalContext(
          malformed,
          transition,
          malformed.approvalFingerprint,
          now,
        ),
        planRelativePath,
      ).toBe(false);
    }

    const plan = completeReadyPlan();
    expect(
      matchesApprovalContext(plan, transition, plan.approvalFingerprint, now),
    ).toBe(true);
  });

  it("rejects unsafe target action paths before approval", () => {
    const transition = { generationToken, planId };
    const now = "2026-07-20T01:00:00.000Z";
    const invalidPaths = [
      "../post.mdx",
      "./post.mdx",
      "content/../escape.mdx",
      "content//post.mdx",
      "content/",
      "C:/temp/post.mdx",
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

  it("couples action prior states to the ordered target-folder snapshot", () => {
    const transition = { generationToken, planId };
    const now = "2026-07-20T01:00:00.000Z";
    const mismatchedCreate = structuredClone(
      completeReadyPlan(),
    ) as VerifiedReadyExportPlan;
    (
      mismatchedCreate.actions[0] as unknown as {
        kind: string;
        approvedPriorTarget: unknown;
      }
    ).kind = "update";
    (
      mismatchedCreate.actions[0] as unknown as {
        approvedPriorTarget: unknown;
      }
    ).approvedPriorTarget = {
      state: "regularFile",
      contentSha256: digest,
    };
    expect(
      matchesApprovalContext(
        mismatchedCreate,
        transition,
        mismatchedCreate.approvalFingerprint,
        now,
      ),
    ).toBe(false);

    const coherentUpdate = completeReadyPlan();
    expect(
      matchesApprovalContext(
        coherentUpdate,
        transition,
        coherentUpdate.approvalFingerprint,
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
        "targetFolderSnapshot.targetRootRealPath",
        (plan) => {
          (
            plan.targetFolderSnapshot as { targetRootRealPath: string }
          ).targetRootRealPath = "/other/target";
        },
      ],
    ];
    for (const [label, mutate] of mutations) {
      const changed = structuredClone(
        completeReadyPlan(),
      ) as VerifiedReadyExportPlan;
      mutate(changed);
      expect(
        matchesApprovalContext(
          changed,
          transition,
          changed.approvalFingerprint,
          now,
        ),
        label,
      ).toBe(false);
    }
  });

  it("orders sealed output paths by deterministic code-unit order", () => {
    const transition = { generationToken, planId };
    const plan = completeReadyPlan();
    const generatedMdx = {
      ...plan.generatedMdx,
      planRelativePath: "zz/last",
    };
    const imageOutput = {
      ...plan.blobs[imageOutputDigest]!,
      planRelativePath: "aa/first",
    };
    const ordered = {
      ...plan,
      generatedMdx,
      targetOutputs: [
        { ...plan.targetOutputs[0]!, sealedOutput: generatedMdx },
        { ...plan.targetOutputs[1]!, sealedOutput: imageOutput },
      ],
      actions: [
        { ...plan.actions[0]!, sealedOutput: generatedMdx },
        { ...plan.actions[1]!, sealedOutput: imageOutput },
      ] as typeof plan.actions,
      blobs: {
        [generatedMdx.contentSha256]: generatedMdx,
        [imageOutput.contentSha256]: imageOutput,
      },
      approvalFingerprint: {
        ...plan.approvalFingerprint,
        sealedOutputs: [imageOutput, generatedMdx],
      },
    } as VerifiedReadyExportPlan;
    expect(
      matchesApprovalContext(
        ordered,
        transition,
        ordered.approvalFingerprint,
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
    expect(matchesPlanIdentity(transition, { generationToken, planId })).toBe(
      true,
    );
    expect(
      matchesPlanIdentity(transition, {
        generationToken: "other" as GenerationToken,
        planId,
      }),
    ).toBe(false);
  });

  it("rejects every removed Git-shaped field from runtime contracts", () => {
    const plan = completeReadyPlan();
    const transition = { generationToken, planId };
    const now = "2026-07-20T01:00:00.000Z";
    const removedPlanFields = [
      "repositoryFingerprint",
      "commitMessage",
      "author",
      "CommitAuthorSnapshot",
    ] as const;
    for (const field of removedPlanFields) {
      const smuggled = {
        ...plan,
        [field]:
          field === "author" || field === "CommitAuthorSnapshot"
            ? { name: "Example Author", email: "author@example.test" }
            : field === "commitMessage"
              ? output("messages/commit.txt", digest)
              : {
                  realPaths: {
                    repositoryRoot: "/repo",
                    gitDirectory: "/repo/.git",
                    gitCommonDirectory: "/repo/.git",
                  },
                  supportedForm: { isBareRepository: false },
                  branch: { currentBranch: "main" },
                  oids: { head: "a".repeat(40) },
                  remotes: {},
                  stateHashes: {},
                  git: { executableRealPath: "/usr/bin/git" },
                  canonicalCommitAuthor: {
                    name: "Example Author",
                    email: "author@example.test",
                  },
                  targets: [],
                },
      };
      expect(
        matchesApprovalContext(
          smuggled as VerifiedReadyExportPlan,
          transition,
          approvalFingerprint(),
          now,
        ),
        field,
      ).toBe(false);
      expect(JSON.stringify(completeReadyPlan())).not.toContain(`"${field}"`);
    }

    const removedSnapshotKeys = [
      "realPaths",
      "supportedForm",
      "branch",
      "oids",
      "remotes",
      "stateHashes",
      "git",
      "canonicalCommitAuthor",
      "filesystemCaseSensitivity",
    ] as const;
    for (const key of removedSnapshotKeys) {
      const fingerprint = structuredClone(
        approvalFingerprint(),
      ) as ApprovalFingerprint & {
        targetFolderSnapshot: Record<string, unknown>;
      };
      fingerprint.targetFolderSnapshot[key] = { smuggled: true };
      expect(
        matchesApprovalContext(plan, transition, fingerprint, now),
        `snapshot.${key}`,
      ).toBe(false);
    }

    const planWithExpectedGitMode = {
      ...completeReadyPlan(),
      expectedGitMode: "100644",
    };
    expect(
      matchesApprovalContext(
        planWithExpectedGitMode as VerifiedReadyExportPlan,
        transition,
        approvalFingerprint(),
        now,
      ),
    ).toBe(false);
    expect(JSON.stringify(completeReadyPlan())).not.toContain(
      "expectedGitMode",
    );
    expect(
      Object.prototype.hasOwnProperty.call(
        completeReadyPlan().actions[0],
        "expectedGitMode",
      ),
    ).toBe(false);

    const legacyFileState = structuredClone(
      completeReadyPlan(),
    ) as VerifiedReadyExportPlan;
    (
      legacyFileState.actions[1] as unknown as { approvedPriorTarget: unknown }
    ).approvedPriorTarget = {
      state: "file",
      contentSha256: digest,
      gitMode: "100644",
    };
    (
      legacyFileState.targetFolderSnapshot.targets[1] as unknown as {
        priorState: unknown;
      }
    ).priorState = {
      state: "file",
      contentSha256: digest,
      gitMode: "100644",
    };
    (
      legacyFileState.approvalFingerprint.targetFolderSnapshot
        .targets[1] as unknown as { priorState: unknown }
    ).priorState = {
      state: "file",
      contentSha256: digest,
      gitMode: "100644",
    };
    expect(
      matchesApprovalContext(
        legacyFileState,
        transition,
        legacyFileState.approvalFingerprint,
        now,
      ),
    ).toBe(false);

    const withSymlinkStatus = structuredClone(
      completeReadyPlan(),
    ) as VerifiedReadyExportPlan;
    (
      withSymlinkStatus.targetFolderSnapshot.targets[0] as unknown as {
        symlinkStatus: string;
      }
    ).symlinkStatus = "not-symlink";
    (
      withSymlinkStatus.approvalFingerprint.targetFolderSnapshot
        .targets[0] as unknown as { symlinkStatus: string }
    ).symlinkStatus = "not-symlink";
    expect(
      matchesApprovalContext(
        withSymlinkStatus,
        transition,
        withSymlinkStatus.approvalFingerprint,
        now,
      ),
    ).toBe(false);

    const profileWithGit = {
      ...structuredClone(DPW_MIND_NET_V1),
      repository: { branch: "main", remote: "origin" },
      commit: { message: "Publish {title}" },
    };
    expect(parsePortableProfile(profileWithGit)).toBeUndefined();
    expect(validatePortableProfile(profileWithGit).ok).toBe(false);

    expect(
      validateMachineBinding({
        schemaVersion: 1,
        profileId: "dpw-mind-net-v1",
        repositoryRoot: "/Users/example/sites/dpw-mind-net",
        repositoryUrl: "https://example.invalid/dpw-mind-net.git",
      }).ok,
    ).toBe(false);
    expect(
      validateMachineBinding({
        schemaVersion: 1,
        profileId: "dpw-mind-net-v1",
        targetRoot: "/Users/example/sites/dpw-mind-net",
        repositoryRoot: "/Users/example/sites/dpw-mind-net",
      }).ok,
    ).toBe(false);

    const serializedPlan = JSON.stringify(completeReadyPlan());
    for (const token of [
      "repositoryFingerprint",
      "expectedGitMode",
      "gitMode",
      "commitMessage",
      "canonicalCommitAuthor",
      "symlinkStatus",
      '"state":"file"',
      "GitFileMode",
    ])
      expect(serializedPlan).not.toContain(token);
  });
});
