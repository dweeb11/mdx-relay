import { describe, expect, it } from "vitest";

import { sha256OfBytes, sha256OfUtf8 } from "../../../src/canonical/hash";
import type {
  ApprovedPriorTarget,
  CanonicalDependencySnapshot,
  GenerationToken,
  RepositoryFingerprint,
  RepositoryTargetFingerprint,
  ValidatedPortableProfileSnapshot,
} from "../../../src/contracts/export-plan";
import { createIssue, ISSUE_CODES } from "../../../src/contracts/issues";
import { MDX_RELAY_LIMITS } from "../../../src/core/limits";
import {
  buildExportPlan,
  type ExportPlanBuildInput,
  type ExportPlanDraft,
  type PlanSourceBytes,
} from "../../../src/planning/build-export-plan";
import {
  buildPlanIdentityManifest,
  computePlanId,
  verifyPlanEnvelope,
  verifyStoredExportPlan,
} from "../../../src/planning/plan-verification";
import { sealExportPlan } from "../../../src/planning/seal-export-plan";
import { DPW_MIND_NET_V1 } from "../../../src/profiles/builtins/dpw-mind-net-v1";

const utf8 = (value: string) => new TextEncoder().encode(value);
const digest = (value: string) => sha256OfBytes(utf8(value));

const PROFILE_SNAPSHOT = JSON.stringify(DPW_MIND_NET_V1);
const DEPENDENCY_SNAPSHOT = '{"images":["assets/a.png"]}';
const MDX_BYTES = utf8("---\ntitle: Example\n---\n\nBody\n");
const IMAGE_BYTES = utf8("webp-bytes");
const NOW = "2026-07-20T01:00:00.000Z";

/** Every source fingerprint below is derived from the bytes, never asserted. */
const NOTE_BYTES = utf8("# Example\n\nBody\n");
const SOURCE_A_BYTES = utf8("png-source-a");
const SOURCE_B_BYTES = utf8("png-source-b");

const sourceBytes = (): PlanSourceBytes => ({
  note: NOTE_BYTES,
  images: new Map([["image-a", SOURCE_A_BYTES]]),
});

const repositoryState = (): Omit<RepositoryFingerprint, "targets"> => ({
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
      sha256: digest("fetch"),
      redactedDisplay: "https://host/repo.git",
    },
    push: { sha256: digest("push"), redactedDisplay: "https://host/repo.git" },
  },
  stateHashes: {
    porcelainStatusSha256: digest("status"),
    indexSha256: digest("index"),
    relevantConfigSha256: digest("config"),
    plannedPathAttributesSha256: digest("attributes"),
  },
  git: { executableRealPath: "/usr/bin/git", version: "git version 2.50.1" },
  canonicalCommitAuthor: {
    name: "Example Author",
    email: "author@example.test",
  },
});

const targetsWith = (
  overrides: Readonly<Record<string, ApprovedPriorTarget>> = {},
): readonly RepositoryTargetFingerprint[] =>
  ["content/posts/example.mdx", "public/posts/example/img-1.webp"].map(
    (normalizedPath) => ({
      normalizedPath,
      symlinkStatus: "not-symlink" as const,
      approvedPriorTarget: overrides[normalizedPath] ?? { state: "absent" },
    }),
  );

const buildInput = (
  overrides: Partial<ExportPlanBuildInput> = {},
): ExportPlanBuildInput => {
  const repository = overrides.repository ?? repositoryState();
  const targets = overrides.priorTargets ?? targetsWith();
  return {
    generationToken: "generation-1" as GenerationToken,
    profile: DPW_MIND_NET_V1,
    profileSnapshot: PROFILE_SNAPSHOT as ValidatedPortableProfileSnapshot,
    profileSnapshotSha256: sha256OfUtf8(PROFILE_SNAPSHOT),
    dependencySnapshot: DEPENDENCY_SNAPSHOT as CanonicalDependencySnapshot,
    dependencySnapshotSha256: sha256OfUtf8(DEPENDENCY_SNAPSHOT),
    sourceNote: {
      vaultRelativePath: "notes/example.md",
      realPath: "/vault/notes/example.md",
      byteLength: NOTE_BYTES.byteLength,
      contentSha256: sha256OfBytes(NOTE_BYTES),
    },
    sourceImages: [
      {
        sourceId: "image-a",
        vaultRelativePath: "assets/a.png",
        realPath: "/vault/assets/a.png",
        decodedMime: "image/png",
        byteLength: SOURCE_A_BYTES.byteLength,
        contentSha256: sha256OfBytes(SOURCE_A_BYTES),
      },
    ],
    sourceBytes: sourceBytes(),
    documentSlug: "example",
    documentTitle: "Example",
    generatedMdxBytes: MDX_BYTES,
    transformedImages: [{ sourceId: "image-a", bytes: IMAGE_BYTES }],
    imageEmbeds: [{ sourceId: "image-a", assetFileName: "img-1.webp" }],
    repository,
    priorTargets: targets,
    warnings: [createIssue(ISSUE_CODES.imageAltTextMissing, { count: 1 })],
    finalCapture: {
      profileSnapshotSha256: sha256OfUtf8(PROFILE_SNAPSHOT),
      dependencySnapshotSha256: sha256OfUtf8(DEPENDENCY_SNAPSHOT),
      sourceNote: {
        byteLength: NOTE_BYTES.byteLength,
        contentSha256: sha256OfBytes(NOTE_BYTES),
      },
      sourceImages: [
        {
          sourceId: "image-a",
          byteLength: SOURCE_A_BYTES.byteLength,
          contentSha256: sha256OfBytes(SOURCE_A_BYTES),
        },
      ],
      repository,
      targets,
    },
    createdAtUtc: "2026-07-20T00:00:00.000Z",
    expiresAtUtc: "2026-07-27T00:00:00.000Z",
    ...overrides,
  };
};

const draftFor = (
  overrides: Partial<ExportPlanBuildInput> = {},
): ExportPlanDraft => {
  const result = buildExportPlan(buildInput(overrides));
  if (!result.ok) throw new Error(`expected a draft: ${result.error[0].code}`);
  return result.value;
};

const sealOrThrow = (overrides: Partial<ExportPlanBuildInput> = {}) => {
  const result = sealExportPlan(draftFor(overrides));
  if (!result.ok) throw new Error(`expected a seal: ${result.error[0].code}`);
  return result.value;
};

const unchangedTargets = (): readonly RepositoryTargetFingerprint[] =>
  targetsWith({
    "content/posts/example.mdx": {
      state: "file",
      contentSha256: sha256OfBytes(MDX_BYTES),
      gitMode: "100644",
    },
    "public/posts/example/img-1.webp": {
      state: "file",
      contentSha256: sha256OfBytes(IMAGE_BYTES),
      gitMode: "100644",
    },
  });

/** Round-trips through JSON exactly as private storage does. */
const restored = (envelope: {
  readonly plan: unknown;
}): Record<string, unknown> =>
  JSON.parse(JSON.stringify(envelope.plan)) as Record<string, unknown>;

/** Applies a mutation and recomputes the unkeyed content-derived plan ID. */
const reseal = (
  envelope: { readonly plan: unknown },
  mutate: (plan: Record<string, unknown>) => void,
): Record<string, unknown> => {
  const plan = restored(envelope);
  mutate(plan);
  plan.planId = computePlanId(buildPlanIdentityManifest(plan));
  return plan;
};

const tamperCode = (
  plan: unknown,
  blobBytes: ReadonlyMap<string, Uint8Array>,
  currentUtc = NOW,
  sources: PlanSourceBytes | undefined = sourceBytes(),
): string | undefined => {
  const result = verifyStoredExportPlan(plan, blobBytes, currentUtc, sources);
  return result.ok ? undefined : result.error[0].code;
};

/** Verification with no live source bytes: structural proof only, no brand. */
const structuralCode = (
  plan: unknown,
  blobBytes: ReadonlyMap<string, Uint8Array>,
): string | undefined => {
  const result = verifyStoredExportPlan(plan, blobBytes, NOW);
  return result.ok ? undefined : result.error[0].code;
};

/**
 * Expands a ready plan to `actionCount` targets that all reuse the existing
 * image sealed output, keeping blob membership and approval mirrors coherent
 * so only the action/target count gate can reject the candidate.
 */
const expandSharedImageActions = (
  plan: Record<string, unknown>,
  actionCount: number,
): void => {
  const actions = plan.actions as Record<string, unknown>[];
  const mdxAction = actions[0]!;
  const imageAction = actions[1]!;
  const expanded = [mdxAction];
  for (let index = 0; index < actionCount - 1; index += 1) {
    expanded.push({
      ...imageAction,
      documentOrder: index + 1,
      // Zero-pad so document order stays lexicographically sorted for the
      // frozen repository-target path ordering gate.
      targetPath: `public/posts/example/img-${String(index + 1).padStart(3, "0")}.webp`,
      sourceOccurrence: index + 1,
    });
  }
  plan.actions = expanded;
  const targets = expanded
    .map((action) => ({
      normalizedPath: action.targetPath as string,
      symlinkStatus: "not-symlink" as const,
      approvedPriorTarget: action.approvedPriorTarget,
    }))
    .sort((left, right) =>
      left.normalizedPath < right.normalizedPath
        ? -1
        : left.normalizedPath > right.normalizedPath
          ? 1
          : 0,
    );
  const repository = {
    ...(plan.repositoryFingerprint as Record<string, unknown>),
    targets,
  };
  plan.repositoryFingerprint = repository;
  (
    plan.approvalFingerprint as { repositoryFingerprint: unknown }
  ).repositoryFingerprint = repository;
};

/**
 * Expands a ready plan to `actionOutputCount` distinct action-output blobs
 * (MDX plus unique image outputs) plus the existing commit-message blob, and
 * mirrors the new bytes into `blobBytes` so only the sealed-output count gate
 * can reject the candidate.
 */
const expandDistinctActionOutputBlobs = (
  plan: Record<string, unknown>,
  blobBytes: Map<string, Uint8Array>,
  actionOutputCount: number,
): void => {
  const actions = plan.actions as Record<string, unknown>[];
  const mdxAction = actions[0]!;
  const imageAction = actions[1]!;
  const blobs = { ...(plan.blobs as Record<string, unknown>) };
  const commitMessage = plan.commitMessage as { contentSha256: string };
  for (const key of Object.keys(blobs)) {
    if (
      key !==
        (mdxAction.sealedOutput as { contentSha256: string }).contentSha256 &&
      key !== commitMessage.contentSha256
    )
      delete blobs[key];
  }
  for (const [path] of [...blobBytes]) {
    const digestKey = `sha256:${path}`;
    if (
      digestKey !==
        (mdxAction.sealedOutput as { contentSha256: string }).contentSha256 &&
      digestKey !== commitMessage.contentSha256
    )
      blobBytes.delete(path);
  }

  const expanded = [mdxAction];
  for (let index = 0; index < actionOutputCount - 1; index += 1) {
    const bytes = utf8(`distinct-image-output-${index}`);
    const contentSha256 = sha256OfBytes(bytes);
    const planRelativePath = contentSha256.slice("sha256:".length);
    const sealedOutput = {
      planRelativePath,
      byteLength: bytes.byteLength,
      contentSha256,
    };
    blobs[contentSha256] = sealedOutput;
    blobBytes.set(planRelativePath, bytes);
    expanded.push({
      ...imageAction,
      documentOrder: index + 1,
      targetPath: `public/posts/example/img-${String(index + 1).padStart(3, "0")}.webp`,
      sourceOccurrence: index + 1,
      sealedOutput,
    });
  }
  plan.actions = expanded;
  plan.blobs = blobs;
  const orderedOutputs = Object.values(blobs).sort((left, right) => {
    const leftPath = (left as { planRelativePath: string }).planRelativePath;
    const rightPath = (right as { planRelativePath: string }).planRelativePath;
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  });
  (plan.approvalFingerprint as { sealedOutputs: unknown }).sealedOutputs =
    orderedOutputs;
  const imageDigest = (
    expanded[1] as { sealedOutput: { contentSha256: string } }
  ).sealedOutput.contentSha256;
  (
    plan.sourceImages as { transformedOutputSha256: string }[]
  )[0]!.transformedOutputSha256 = imageDigest;
  (
    plan.approvalFingerprint as {
      sourceImages: { transformedOutputSha256: string }[];
    }
  ).sourceImages[0]!.transformedOutputSha256 = imageDigest;
  const targets = expanded
    .map((action) => ({
      normalizedPath: action.targetPath as string,
      symlinkStatus: "not-symlink" as const,
      approvedPriorTarget: action.approvedPriorTarget,
    }))
    .sort((left, right) =>
      left.normalizedPath < right.normalizedPath
        ? -1
        : left.normalizedPath > right.normalizedPath
          ? 1
          : 0,
    );
  const repository = {
    ...(plan.repositoryFingerprint as Record<string, unknown>),
    targets,
  };
  plan.repositoryFingerprint = repository;
  (
    plan.approvalFingerprint as { repositoryFingerprint: unknown }
  ).repositoryFingerprint = repository;
};

describe("plan identity", () => {
  it("excludes only the generation token and plan ID from plan identity", () => {
    const manifest = buildPlanIdentityManifest({
      planId: "plan-x",
      generationToken: "generation-1",
      state: "ready",
      createdAtUtc: "2026-07-20T00:00:00.000Z",
    });
    expect(manifest).toBe(
      '{"createdAtUtc":"2026-07-20T00:00:00.000Z","state":"ready"}',
    );
    expect(computePlanId(manifest)).toMatch(/^plan-[0-9a-f]{64}$/u);
  });
});

describe("verifyStoredExportPlan", () => {
  it("re-admits an untouched plan restored from JSON", () => {
    const envelope = sealOrThrow();
    const result = verifyStoredExportPlan(
      restored(envelope),
      envelope.blobBytes,
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.planId).toBe(envelope.planId);
      expect(result.value.identityManifest).toBe(envelope.identityManifest);
    }
  });

  it("rejects a recomputed plan whose actions exceed the locked file budget", () => {
    const envelope = sealOrThrow();
    const overLimit = reseal(envelope, (plan) =>
      expandSharedImageActions(plan, MDX_RELAY_LIMITS.sealedOutputFiles + 1),
    );
    expect(tamperCode(overLimit, envelope.blobBytes)).toBe(
      ISSUE_CODES.storageTampered,
    );
    expect(structuralCode(overLimit, envelope.blobBytes)).toBe(
      ISSUE_CODES.storageTampered,
    );

    const atLimit = reseal(envelope, (plan) =>
      expandSharedImageActions(plan, MDX_RELAY_LIMITS.sealedOutputFiles),
    );
    expect(tamperCode(atLimit, envelope.blobBytes)).toBeUndefined();
  });

  it("rejects fifty distinct action-output blobs plus a commit-message blob", () => {
    const envelope = sealOrThrow();
    const overBlobBytes = new Map(envelope.blobBytes);
    const overLimit = reseal(envelope, (plan) =>
      expandDistinctActionOutputBlobs(
        plan,
        overBlobBytes,
        MDX_RELAY_LIMITS.sealedOutputFiles,
      ),
    );
    expect(Object.keys((overLimit.blobs as object) ?? {}).length).toBe(
      MDX_RELAY_LIMITS.sealedOutputFiles + 1,
    );
    expect(tamperCode(overLimit, overBlobBytes)).toBe(
      ISSUE_CODES.storageTampered,
    );
    expect(structuralCode(overLimit, overBlobBytes)).toBe(
      ISSUE_CODES.storageTampered,
    );
    expect(
      verifyPlanEnvelope(overLimit, overBlobBytes, sourceBytes()),
    ).toBeUndefined();

    const draft = draftFor();
    const handcrafted = restored({ plan: draft.plan });
    const handcraftedBytes = new Map(draft.blobBytes);
    expandDistinctActionOutputBlobs(
      handcrafted,
      handcraftedBytes,
      MDX_RELAY_LIMITS.sealedOutputFiles,
    );
    expect(
      sealExportPlan({
        plan: handcrafted as unknown as ExportPlanDraft["plan"],
        blobBytes: handcraftedBytes,
        sourceBytes: draft.sourceBytes,
      }).ok,
    ).toBe(false);

    const atLimitBytes = new Map(envelope.blobBytes);
    const atLimit = reseal(envelope, (plan) =>
      expandDistinctActionOutputBlobs(
        plan,
        atLimitBytes,
        MDX_RELAY_LIMITS.sealedOutputFiles - 1,
      ),
    );
    expect(Object.keys((atLimit.blobs as object) ?? {}).length).toBe(
      MDX_RELAY_LIMITS.sealedOutputFiles,
    );
    expect(tamperCode(atLimit, atLimitBytes)).toBeUndefined();
    expect(
      sealExportPlan({
        plan: atLimit as unknown as ExportPlanDraft["plan"],
        blobBytes: atLimitBytes,
        sourceBytes: sourceBytes(),
      }).ok,
    ).toBe(true);
  });

  it("rejects every tampered field, blob, and identity as storage tampering", () => {
    const envelope = sealOrThrow();
    const { blobBytes } = envelope;
    const mdxPath = envelope.plan.generatedMdx.planRelativePath;

    const mutations: readonly [
      string,
      (plan: Record<string, unknown>) => void,
    ][] = [
      ["planId", (plan) => void (plan.planId = "plan-forged")],
      ["schemaVersion", (plan) => void (plan.schemaVersion = 2)],
      ["generationToken", (plan) => void (plan.generationToken = "")],
      [
        "profileSnapshot",
        (plan) => void (plan.profileSnapshot = '{"tampered":true}'),
      ],
      [
        "dependencySnapshotSha256",
        (plan) => void (plan.dependencySnapshotSha256 = digest("other")),
      ],
      [
        "blobs.byteLength",
        (plan) => {
          const blobs = plan.blobs as Record<string, { byteLength: number }>;
          blobs[Object.keys(blobs)[0]!]!.byteLength += 1;
        },
      ],
      [
        "blobs.extraEntry",
        (plan) => {
          const blobs = plan.blobs as Record<string, unknown>;
          blobs[`sha256:${"0".repeat(64)}`] = {
            planRelativePath: "0".repeat(64),
            byteLength: 1,
            contentSha256: `sha256:${"0".repeat(64)}`,
          };
        },
      ],
      [
        "blobs.pathEscape",
        (plan) => {
          const blobs = plan.blobs as Record<
            string,
            { planRelativePath: string }
          >;
          blobs[Object.keys(blobs)[0]!]!.planRelativePath = "../escape";
        },
      ],
      [
        "approvalFingerprint.sealedOutputs",
        (plan) => {
          const approval = plan.approvalFingerprint as {
            sealedOutputs: unknown[];
          };
          approval.sealedOutputs = approval.sealedOutputs.slice(1);
        },
      ],
      [
        "approvalFingerprint.repositoryFingerprint",
        (plan) => {
          const approval = plan.approvalFingerprint as {
            repositoryFingerprint: { branch: { currentBranch: string } };
          };
          approval.repositoryFingerprint.branch.currentBranch = "other";
        },
      ],
      [
        "actions.targetPath",
        (plan) => {
          const actions = plan.actions as { targetPath: string }[];
          actions[0]!.targetPath = "content/posts/other.mdx";
        },
      ],
      [
        "actions.expectedGitMode",
        (plan) => {
          const actions = plan.actions as { expectedGitMode: string }[];
          actions[0]!.expectedGitMode = "100755";
        },
      ],
      [
        "issues.blockerInjected",
        (plan) => void (plan.issues = [createIssue(ISSUE_CODES.invalidMdx)]),
      ],
      [
        "issues.forgedSummary",
        (plan) => {
          const issues = plan.issues as {
            displayDetails: { summary: string };
          }[];
          issues[0]!.displayDetails.summary = "attacker text";
        },
      ],
      [
        "author",
        (plan) =>
          void (plan.author = { name: "Other", email: "other@example.test" }),
      ],
      [
        "expiresAtUtc",
        (plan) => void (plan.expiresAtUtc = "2026-07-19T00:00:00.000Z"),
      ],
    ];

    for (const [label, mutate] of mutations) {
      const plan = restored(envelope);
      mutate(plan);
      expect(tamperCode(plan, blobBytes), label).toBe(
        ISSUE_CODES.storageTampered,
      );
    }

    const flipped = Uint8Array.from(
      blobBytes.get(mdxPath)!,
      (byte) => byte ^ 0xff,
    );
    expect(
      tamperCode(
        restored(envelope),
        new Map([...blobBytes, [mdxPath, flipped]]),
      ),
      "blob bytes",
    ).toBe(ISSUE_CODES.storageTampered);

    const missing = new Map(blobBytes);
    missing.delete(mdxPath);
    expect(tamperCode(restored(envelope), missing), "missing blob").toBe(
      ISSUE_CODES.storageTampered,
    );

    for (const malformed of [null, "plan", [], {}, { planId: 1 }])
      expect(tamperCode(malformed, blobBytes), String(malformed)).toBe(
        ISSUE_CODES.storageTampered,
      );
  });

  it("rejects forgeries that recompute a matching plan ID over tampered content", () => {
    const envelope = sealOrThrow();
    const resealed = (mutate: (plan: Record<string, unknown>) => void) => {
      const plan = restored(envelope);
      mutate(plan);
      plan.planId = computePlanId(buildPlanIdentityManifest(plan));
      return plan;
    };

    const forgeries: readonly [
      string,
      (plan: Record<string, unknown>) => void,
    ][] = [
      [
        "profileSnapshot without its digest",
        (plan) => void (plan.profileSnapshot = '{"tampered":true}'),
      ],
      [
        "executable mode on a create action",
        (plan) => {
          const actions = plan.actions as { expectedGitMode: string }[];
          actions[0]!.expectedGitMode = "100755";
        },
      ],
      [
        "approval capture divergence",
        (plan) => {
          const approval = plan.approvalFingerprint as {
            repositoryFingerprint: { oids: { head: string } };
          };
          approval.repositoryFingerprint.oids.head = "b".repeat(40);
        },
      ],
      [
        "unplanned target appended",
        (plan) => {
          const repository = plan.repositoryFingerprint as {
            targets: unknown[];
          };
          repository.targets.push({
            normalizedPath: "zz/extra.mdx",
            symlinkStatus: "not-symlink",
            approvedPriorTarget: { state: "absent" },
          });
          const approval = plan.approvalFingerprint as {
            repositoryFingerprint: { targets: unknown[] };
          };
          approval.repositoryFingerprint.targets = repository.targets;
        },
      ],
      [
        "blocker issue promoted into the plan",
        (plan) => void (plan.issues = [createIssue(ISSUE_CODES.invalidMdx)]),
      ],
      [
        "action pointed at a blob it does not own",
        (plan) => {
          const actions = plan.actions as { sealedOutput: unknown }[];
          actions[0]!.sealedOutput = plan.commitMessage as Record<
            string,
            unknown
          >;
        },
      ],
    ];

    for (const [label, mutate] of forgeries)
      expect(tamperCode(resealed(mutate), envelope.blobBytes), label).toBe(
        ISSUE_CODES.storageTampered,
      );

    // The same reseal of an untouched plan still verifies, so the rejections
    // above come from the structural gates rather than the reseal itself.
    expect(
      tamperCode(
        resealed(() => {}),
        envelope.blobBytes,
      ),
    ).toBeUndefined();
  });

  it("recomputes every source fingerprint from bytes before branding", () => {
    const envelope = sealOrThrow();
    const stored = restored(envelope);

    // Storage never holds source bytes, so a restored plan carries structural
    // proof only until a live capture supplies them again.
    const unbranded = verifyStoredExportPlan(stored, envelope.blobBytes, NOW);
    expect(unbranded.ok && unbranded.value.sourceBytesVerified).toBe(false);
    const branded = verifyStoredExportPlan(
      stored,
      envelope.blobBytes,
      NOW,
      sourceBytes(),
    );
    expect(branded.ok && branded.value.sourceBytesVerified).toBe(true);

    const forgeries: readonly [
      string,
      (plan: Record<string, unknown>) => void,
    ][] = [
      [
        "source note digest",
        (plan) => {
          const note = plan.sourceNote as { contentSha256: string };
          note.contentSha256 = digest("forged-note");
          (
            plan.approvalFingerprint as {
              sourceNote: { contentSha256: string };
            }
          ).sourceNote.contentSha256 = note.contentSha256;
        },
      ],
      [
        "source note length",
        (plan) => {
          const note = plan.sourceNote as { byteLength: number };
          note.byteLength += 1;
          (
            plan.approvalFingerprint as { sourceNote: { byteLength: number } }
          ).sourceNote.byteLength = note.byteLength;
        },
      ],
      [
        "source image digest",
        (plan) => {
          const images = plan.sourceImages as { contentSha256: string }[];
          images[0]!.contentSha256 = digest("forged-image");
          (
            plan.approvalFingerprint as {
              sourceImages: { contentSha256: string }[];
            }
          ).sourceImages[0]!.contentSha256 = images[0]!.contentSha256;
        },
      ],
      [
        "source image length",
        (plan) => {
          const images = plan.sourceImages as { byteLength: number }[];
          images[0]!.byteLength += 1;
          (
            plan.approvalFingerprint as {
              sourceImages: { byteLength: number }[];
            }
          ).sourceImages[0]!.byteLength = images[0]!.byteLength;
        },
      ],
    ];

    for (const [label, mutate] of forgeries) {
      const forged = reseal(envelope, mutate);
      // Every duplicated copy agrees and the unkeyed plan ID recomputes, so
      // comparing metadata against metadata accepts the forgery outright.
      expect(
        structuralCode(forged, envelope.blobBytes),
        `${label} (metadata only)`,
      ).toBeUndefined();
      // Recomputing from the bytes the capture actually read does not.
      expect(tamperCode(forged, envelope.blobBytes), label).toBe(
        ISSUE_CODES.storageTampered,
      );
    }

    const wrongBytes: readonly [string, PlanSourceBytes][] = [
      [
        "different note bytes",
        {
          note: utf8("# Other\n"),
          images: new Map([["image-a", SOURCE_A_BYTES]]),
        },
      ],
      ["no image bytes", { note: NOTE_BYTES, images: new Map() }],
      [
        "an extra image",
        {
          note: NOTE_BYTES,
          images: new Map([
            ["image-a", SOURCE_A_BYTES],
            ["image-b", SOURCE_B_BYTES],
          ]),
        },
      ],
      [
        "an unrelated image",
        { note: NOTE_BYTES, images: new Map([["image-a", SOURCE_B_BYTES]]) },
      ],
    ];
    for (const [label, supplied] of wrongBytes)
      expect(tamperCode(stored, envelope.blobBytes, NOW, supplied), label).toBe(
        ISSUE_CODES.storageTampered,
      );
  });

  it("rejects transformed source digests that do not name a sealed image blob", () => {
    const envelope = sealOrThrow();
    expect(envelope.state).toBe("ready");
    const plan = envelope.plan as {
      actions: readonly {
        documentOrder: number;
        sealedOutput: { contentSha256: string };
      }[];
      commitMessage: { contentSha256: string };
      sourceImages: readonly { transformedOutputSha256: string }[];
    };
    const imageDigest = plan.sourceImages[0]!.transformedOutputSha256;
    const mdxDigest = plan.actions.find((action) => action.documentOrder === 0)!
      .sealedOutput.contentSha256;
    const commitDigest = plan.commitMessage.contentSha256;
    expect(mdxDigest).not.toBe(imageDigest);
    expect(commitDigest).not.toBe(imageDigest);

    const forgeTransform = (sealed: typeof envelope, digestValue: string) =>
      reseal(sealed, (candidate) => {
        (
          candidate.sourceImages as { transformedOutputSha256: string }[]
        )[0]!.transformedOutputSha256 = digestValue;
        (
          candidate.approvalFingerprint as {
            sourceImages: { transformedOutputSha256: string }[];
          }
        ).sourceImages[0]!.transformedOutputSha256 = digestValue;
      });

    for (const [label, digestValue] of [
      ["a forged digest", digest("forged-transform")],
      ["the generated MDX blob", mdxDigest],
      ["the commit-message blob", commitDigest],
    ] as const) {
      const forged = forgeTransform(envelope, digestValue);
      expect(structuralCode(forged, envelope.blobBytes), label).toBe(
        ISSUE_CODES.storageTampered,
      );
      expect(tamperCode(forged, envelope.blobBytes), label).toBe(
        ISSUE_CODES.storageTampered,
      );
    }

    const swappedDocumentOrder = reseal(envelope, (candidate) => {
      const actions = candidate.actions as {
        documentOrder: number;
        sealedOutput: { contentSha256: string };
      }[];
      const mdxAction = actions.find(
        (action) => action.sealedOutput.contentSha256 === mdxDigest,
      )!;
      const imageAction = actions.find(
        (action) => action.sealedOutput.contentSha256 === imageDigest,
      )!;
      [mdxAction.documentOrder, imageAction.documentOrder] = [
        imageAction.documentOrder,
        mdxAction.documentOrder,
      ];
      (
        candidate.sourceImages as { transformedOutputSha256: string }[]
      )[0]!.transformedOutputSha256 = mdxDigest;
      (
        candidate.approvalFingerprint as {
          sourceImages: { transformedOutputSha256: string }[];
        }
      ).sourceImages[0]!.transformedOutputSha256 = mdxDigest;
    });
    expect(
      structuralCode(swappedDocumentOrder, envelope.blobBytes),
      "generated MDX moved to image order",
    ).toBe(ISSUE_CODES.storageTampered);
    expect(
      tamperCode(swappedDocumentOrder, envelope.blobBytes),
      "generated MDX moved to image order",
    ).toBe(ISSUE_CODES.storageTampered);

    const unchanged = unchangedTargets();
    const noChanges = sealOrThrow({
      priorTargets: unchanged,
      finalCapture: { ...buildInput().finalCapture, targets: unchanged },
    });
    expect(noChanges.state).toBe("no-changes");
    const noChangesMdxDigest = (
      noChanges.plan as { generatedMdx: { contentSha256: string } }
    ).generatedMdx.contentSha256;
    for (const [label, digestValue] of [
      ["no-changes forged digest", digest("forged-transform")],
      [
        "no-changes commit-message blob",
        (noChanges.plan as { commitMessage: { contentSha256: string } })
          .commitMessage.contentSha256,
      ],
      ["no-changes generated-MDX blob", noChangesMdxDigest],
    ] as const) {
      const forged = forgeTransform(noChanges, digestValue);
      expect(structuralCode(forged, noChanges.blobBytes), label).toBe(
        ISSUE_CODES.storageTampered,
      );
      expect(tamperCode(forged, noChanges.blobBytes), label).toBe(
        ISSUE_CODES.storageTampered,
      );
      expect(
        verifyPlanEnvelope(forged, noChanges.blobBytes, undefined),
        label,
      ).toBeUndefined();
    }
  });

  it("rejects malformed source-image entries as storage tampering without throwing", () => {
    const envelope = sealOrThrow();
    const { blobBytes } = envelope;
    const original = (
      restored(envelope).sourceImages as Record<string, unknown>[]
    )[0]!;

    const malformedEntries: readonly unknown[] = [
      null,
      undefined,
      "image",
      1,
      true,
      [],
      [original],
    ];

    for (const entry of malformedEntries) {
      const plan = restored(envelope);
      plan.sourceImages = [entry];
      expect(
        () => verifyStoredExportPlan(plan, blobBytes, NOW, sourceBytes()),
        String(entry),
      ).not.toThrow();
      expect(tamperCode(plan, blobBytes), String(entry)).toBe(
        ISSUE_CODES.storageTampered,
      );
      expect(structuralCode(plan, blobBytes), String(entry)).toBe(
        ISSUE_CODES.storageTampered,
      );
    }

    // Non-record values that can cross the JSON.parse storage boundary.
    const fromJson = JSON.parse(
      JSON.stringify({ sourceImages: [null, true, 0, "x", []] }),
    ) as { sourceImages: unknown[] };
    for (const entry of fromJson.sourceImages) {
      const plan = restored(envelope);
      plan.sourceImages = [entry];
      expect(
        () => verifyStoredExportPlan(plan, blobBytes, NOW),
        `json:${String(entry)}`,
      ).not.toThrow();
      expect(structuralCode(plan, blobBytes), `json:${String(entry)}`).toBe(
        ISSUE_CODES.storageTampered,
      );
    }

    // Record-shaped but incomplete / wrong-typed fields must also fail closed.
    const incompleteRecords: readonly Record<string, unknown>[] = [
      {},
      { ...original, transformedOutputSha256: null },
      { ...original, transformedOutputSha256: 1 },
      { ...original, sourceId: null },
      { ...original, byteLength: "1" },
    ];
    for (const entry of incompleteRecords) {
      const plan = restored(envelope);
      plan.sourceImages = [entry];
      (
        plan.approvalFingerprint as { sourceImages: Record<string, unknown>[] }
      ).sourceImages = [
        {
          sourceId: entry.sourceId,
          byteLength: entry.byteLength,
          contentSha256: entry.contentSha256,
          transformedOutputSha256: entry.transformedOutputSha256,
        },
      ];
      expect(
        () => verifyStoredExportPlan(plan, blobBytes, NOW, sourceBytes()),
        JSON.stringify(entry),
      ).not.toThrow();
      expect(tamperCode(plan, blobBytes), JSON.stringify(entry)).toBe(
        ISSUE_CODES.storageTampered,
      );
    }
  });

  it("applies the whole frozen structural gate to no-changes plans", () => {
    const targets = unchangedTargets();
    const envelope = sealOrThrow({
      priorTargets: targets,
      finalCapture: { ...buildInput().finalCapture, targets },
    });
    expect(envelope.state).toBe("no-changes");
    expect(tamperCode(restored(envelope), envelope.blobBytes)).toBeUndefined();

    const mirrorRepository = (plan: Record<string, unknown>) => {
      (
        plan.approvalFingerprint as { repositoryFingerprint: unknown }
      ).repositoryFingerprint = plan.repositoryFingerprint;
    };

    const forgeries: readonly [
      string,
      (plan: Record<string, unknown>) => void,
    ][] = [
      [
        "unsupported repository form",
        (plan) => {
          (
            (plan.repositoryFingerprint as Record<string, unknown>)
              .supportedForm as { isBareRepository: boolean }
          ).isBareRepository = true;
          mirrorRepository(plan);
        },
      ],
      [
        "unknown filesystem case sensitivity",
        (plan) => {
          (
            plan.repositoryFingerprint as { filesystemCaseSensitivity: string }
          ).filesystemCaseSensitivity = "unknown";
          mirrorRepository(plan);
        },
      ],
      [
        "empty repository real path",
        (plan) => {
          (
            (plan.repositoryFingerprint as Record<string, unknown>)
              .realPaths as { repositoryRoot: string }
          ).repositoryRoot = "";
          mirrorRepository(plan);
        },
      ],
      [
        "extra repository field",
        (plan) => {
          (plan.repositoryFingerprint as Record<string, unknown>).extra = true;
          mirrorRepository(plan);
        },
      ],
      [
        "unsupported decoded image type",
        (plan) => {
          (plan.sourceImages as { decodedMime: string }[])[0]!.decodedMime =
            "image/gif";
        },
      ],
      [
        "incomplete source note metadata",
        (plan) => {
          delete (plan.sourceNote as Record<string, unknown>).realPath;
        },
      ],
      [
        "source images out of order",
        (plan) => {
          const images = plan.sourceImages as Record<string, unknown>[];
          images.push({ ...images[0]!, sourceId: "image-A" });
          const approval = plan.approvalFingerprint as {
            sourceImages: Record<string, unknown>[];
          };
          approval.sourceImages = images.map(
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
          );
        },
      ],
      [
        "extra author field",
        (plan) => {
          (plan.author as Record<string, unknown>).signature = "forged";
        },
      ],
      [
        "an action smuggled into a no-changes plan",
        (plan) => {
          plan.actions = [
            {
              kind: "create",
              documentOrder: 0,
              targetPath: "content/posts/example.mdx",
              expectedGitMode: "100644",
              sealedOutput: plan.generatedMdx,
              sourceOccurrence: 0,
              approvedPriorTarget: { state: "absent" },
            },
          ];
        },
      ],
      [
        "a repository target smuggled into a no-changes plan",
        (plan) => {
          (plan.repositoryFingerprint as { targets: unknown[] }).targets = [
            {
              normalizedPath: "content/posts/example.mdx",
              symlinkStatus: "not-symlink",
              approvedPriorTarget: { state: "absent" },
            },
          ];
          mirrorRepository(plan);
        },
      ],
      [
        "a blocker issue promoted into the plan",
        (plan) => void (plan.issues = [createIssue(ISSUE_CODES.invalidMdx)]),
      ],
      [
        "created after it expires",
        (plan) => {
          plan.createdAtUtc = "2026-07-28T00:00:00.000Z";
          plan.expiresAtUtc = "2026-07-27T00:00:00.000Z";
        },
      ],
    ];

    for (const [label, mutate] of forgeries)
      expect(
        tamperCode(reseal(envelope, mutate), envelope.blobBytes),
        label,
      ).toBe(ISSUE_CODES.storageTampered);

    // The same reseal of an untouched no-changes plan still verifies, so every
    // rejection above comes from the structural gate rather than the reseal.
    expect(
      tamperCode(
        reseal(envelope, () => {}),
        envelope.blobBytes,
      ),
    ).toBeUndefined();
  });

  it("separates elapsed plans from tampering and rejects unusable clocks", () => {
    const envelope = sealOrThrow();
    expect(
      tamperCode(
        restored(envelope),
        envelope.blobBytes,
        envelope.plan.expiresAtUtc,
      ),
    ).toBe(ISSUE_CODES.planExpired);
    expect(
      tamperCode(
        restored(envelope),
        envelope.blobBytes,
        "2026-08-01T00:00:00.000Z",
      ),
    ).toBe(ISSUE_CODES.planExpired);
    expect(
      tamperCode(
        restored(envelope),
        envelope.blobBytes,
        envelope.plan.createdAtUtc,
      ),
    ).toBeUndefined();
    for (const clock of ["not-utc", "2026-07-20T00:00:00Z", ""])
      expect(tamperCode(restored(envelope), envelope.blobBytes, clock)).toBe(
        ISSUE_CODES.storageTampered,
      );
    expect(
      tamperCode(
        restored(envelope),
        envelope.blobBytes,
        "2026-07-19T23:59:59.999Z",
      ),
    ).toBe(ISSUE_CODES.storageTampered);
  });
});
