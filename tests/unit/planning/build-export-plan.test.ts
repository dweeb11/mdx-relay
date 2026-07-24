import { describe, expect, it } from "vitest";

import type {
  ApprovedPriorTarget,
  CanonicalDependencySnapshot,
  GenerationToken,
  RepositoryFingerprint,
  RepositoryTargetFingerprint,
  SourceNoteMetadata,
  ValidatedPortableProfileSnapshot,
} from "../../../src/contracts/export-plan";
import { createIssue, ISSUE_CODES } from "../../../src/contracts/issues";
import { MDX_RELAY_LIMITS } from "../../../src/core/limits";
import {
  buildExportPlan,
  deepEquals,
  isPortableRepositoryPath,
  isWellFormedUnicode,
  MAX_PORTABLE_PATH_SEGMENT_LENGTH,
  MAX_PORTABLE_REPOSITORY_PATH_LENGTH,
  sha256OfBytes,
  verifySourceBytes,
  type CanonicalSourceImage,
  type ExportPlanBuildInput,
  type FinalCaptureBarrier,
  type PlanSourceBytes,
} from "../../../src/planning/build-export-plan";
import { DPW_MIND_NET_V1 } from "../../../src/profiles/builtins/dpw-mind-net-v1";

const digest = (value: string) =>
  sha256OfBytes(new TextEncoder().encode(value));
const utf8 = (value: string) => new TextEncoder().encode(value);

const MDX_BYTES = utf8("---\ntitle: Example\n---\n\nBody\n");
const IMAGE_ONE_BYTES = utf8("webp-one");
const IMAGE_TWO_BYTES = utf8("webp-two");

/** Every source fingerprint below is derived from the bytes, never asserted. */
const NOTE_BYTES = utf8("# Example\n\nBody\n");
const SOURCE_A_BYTES = utf8("png-source-a");
const SOURCE_B_BYTES = utf8("png-source-b-longer");

const sourceBytes = (): PlanSourceBytes => ({
  note: NOTE_BYTES,
  images: new Map([
    ["image-a", SOURCE_A_BYTES],
    ["image-b", SOURCE_B_BYTES],
  ]),
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

const sourceNote = (): SourceNoteMetadata => ({
  vaultRelativePath: "notes/example.md",
  realPath: "/vault/notes/example.md",
  byteLength: NOTE_BYTES.byteLength,
  contentSha256: sha256OfBytes(NOTE_BYTES),
});

const sourceImages = (): readonly CanonicalSourceImage[] => [
  {
    sourceId: "image-b",
    vaultRelativePath: "assets/b.png",
    realPath: "/vault/assets/b.png",
    decodedMime: "image/png",
    byteLength: SOURCE_B_BYTES.byteLength,
    contentSha256: sha256OfBytes(SOURCE_B_BYTES),
  },
  {
    sourceId: "image-a",
    vaultRelativePath: "assets/a.png",
    realPath: "/vault/assets/a.png",
    decodedMime: "image/png",
    byteLength: SOURCE_A_BYTES.byteLength,
    contentSha256: sha256OfBytes(SOURCE_A_BYTES),
  },
];

const absent: ApprovedPriorTarget = { state: "absent" };

const priorTargets = (
  overrides: Readonly<Record<string, ApprovedPriorTarget>> = {},
): readonly RepositoryTargetFingerprint[] =>
  [
    "content/posts/example.mdx",
    "public/posts/example/img-1.webp",
    "public/posts/example/img-2.webp",
  ].map((normalizedPath) => ({
    normalizedPath,
    symlinkStatus: "not-symlink" as const,
    approvedPriorTarget: overrides[normalizedPath] ?? absent,
  }));

const barrierFor = (input: {
  readonly repository: Omit<RepositoryFingerprint, "targets">;
  readonly targets: readonly RepositoryTargetFingerprint[];
}): FinalCaptureBarrier => ({
  profileSnapshotSha256: digest("profile"),
  dependencySnapshotSha256: digest("dependency"),
  sourceNote: {
    byteLength: NOTE_BYTES.byteLength,
    contentSha256: sha256OfBytes(NOTE_BYTES),
  },
  sourceImages: sourceImages().map(
    ({ sourceId, byteLength, contentSha256 }) => ({
      sourceId,
      byteLength,
      contentSha256,
    }),
  ),
  repository: input.repository,
  targets: input.targets,
});

const buildInput = (
  overrides: Partial<ExportPlanBuildInput> = {},
): ExportPlanBuildInput => {
  const repository = overrides.repository ?? repositoryState();
  const targets = overrides.priorTargets ?? priorTargets();
  return {
    generationToken: "generation-1" as GenerationToken,
    profile: DPW_MIND_NET_V1,
    profileSnapshot: "{}" as ValidatedPortableProfileSnapshot,
    profileSnapshotSha256: digest("profile"),
    dependencySnapshot: "{}" as CanonicalDependencySnapshot,
    dependencySnapshotSha256: digest("dependency"),
    sourceNote: sourceNote(),
    sourceImages: sourceImages(),
    sourceBytes: sourceBytes(),
    documentSlug: "example",
    documentTitle: "Example",
    generatedMdxBytes: MDX_BYTES,
    transformedImages: [
      { sourceId: "image-a", bytes: IMAGE_ONE_BYTES },
      { sourceId: "image-b", bytes: IMAGE_TWO_BYTES },
    ],
    imageEmbeds: [
      { sourceId: "image-a", assetFileName: "img-1.webp" },
      { sourceId: "image-b", assetFileName: "img-2.webp" },
    ],
    repository,
    priorTargets: targets,
    warnings: [createIssue(ISSUE_CODES.imageAltTextMissing, { count: 2 })],
    finalCapture: barrierFor({ repository, targets }),
    createdAtUtc: "2026-07-20T00:00:00.000Z",
    expiresAtUtc: "2026-07-27T00:00:00.000Z",
    ...overrides,
  };
};

const buildOrThrow = (overrides: Partial<ExportPlanBuildInput> = {}) => {
  const result = buildExportPlan(buildInput(overrides));
  if (!result.ok) throw new Error(`expected a plan: ${result.error[0].code}`);
  return result.value;
};

const blockerCode = (input: ExportPlanBuildInput): string | undefined => {
  const result = buildExportPlan(input);
  return result.ok ? undefined : result.error[0].code;
};

describe("buildExportPlan", () => {
  it("derives ordered actions, target modes, and content-addressed blobs", () => {
    const { plan, blobBytes } = buildOrThrow();

    expect(plan.state).toBe("ready");
    expect(plan.actions.map((action) => action.targetPath)).toEqual([
      "content/posts/example.mdx",
      "public/posts/example/img-1.webp",
      "public/posts/example/img-2.webp",
    ]);
    expect(plan.actions.map((action) => action.documentOrder)).toEqual([
      0, 1, 2,
    ]);
    expect(plan.actions.map((action) => action.sourceOccurrence)).toEqual([
      0, 1, 1,
    ]);
    expect(plan.actions.every((action) => action.kind === "create")).toBe(true);
    expect(
      plan.actions.every((action) => action.expectedGitMode === "100644"),
    ).toBe(true);

    for (const output of Object.values(plan.blobs)) {
      expect(output.contentSha256).toBe(`sha256:${output.planRelativePath}`);
      expect(sha256OfBytes(blobBytes.get(output.planRelativePath)!)).toBe(
        output.contentSha256,
      );
    }
    expect(Object.keys(plan.blobs)).toHaveLength(4);
    expect(plan.blobs[plan.generatedMdx.contentSha256]).toEqual(
      plan.generatedMdx,
    );
    expect(plan.blobs[plan.commitMessage.contentSha256]).toEqual(
      plan.commitMessage,
    );
    expect(plan.author).toEqual(
      plan.repositoryFingerprint.canonicalCommitAuthor,
    );
    expect(
      plan.repositoryFingerprint.targets.map((t) => t.normalizedPath),
    ).toEqual([
      "content/posts/example.mdx",
      "public/posts/example/img-1.webp",
      "public/posts/example/img-2.webp",
    ]);
  });

  it("keeps sealed outputs, source images, and approval capture deterministically ordered", () => {
    const { plan } = buildOrThrow();

    expect(plan.sourceImages.map((image) => image.sourceId)).toEqual([
      "image-a",
      "image-b",
    ]);
    const paths = plan.approvalFingerprint.sealedOutputs.map(
      (output) => output.planRelativePath,
    );
    expect(paths).toEqual([...paths].sort());
    expect(new Set(paths).size).toBe(paths.length);
    expect(plan.approvalFingerprint.sealedOutputs).toEqual(
      Object.values(plan.blobs).sort((left, right) =>
        left.planRelativePath < right.planRelativePath ? -1 : 1,
      ),
    );
    expect(plan.approvalFingerprint.repositoryFingerprint).toEqual(
      plan.repositoryFingerprint,
    );
    expect(plan.approvalFingerprint.sourceNote).toEqual({
      byteLength: plan.sourceNote.byteLength,
      contentSha256: plan.sourceNote.contentSha256,
    });
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
  });

  it("produces byte-identical plans for identical input regardless of generation", () => {
    const first = buildOrThrow().plan;
    const second = buildOrThrow().plan;
    const otherGeneration = buildOrThrow({
      generationToken: "generation-2" as GenerationToken,
    }).plan;

    expect(deepEquals(first, second)).toBe(true);
    expect(deepEquals(first, otherGeneration)).toBe(false);
    expect(
      deepEquals(
        { ...first, generationToken: "x" },
        { ...otherGeneration, generationToken: "x" },
      ),
    ).toBe(true);
  });

  it("collapses duplicate embeds to one blob with one action per occurrence", () => {
    const { plan, blobBytes } = buildOrThrow({
      imageEmbeds: [
        { sourceId: "image-a", assetFileName: "img-1.webp" },
        { sourceId: "image-a", assetFileName: "img-2.webp" },
      ],
    });

    const imageActions = plan.actions.slice(1);
    expect(imageActions.map((action) => action.sourceOccurrence)).toEqual([
      1, 2,
    ]);
    expect(imageActions[0]!.sealedOutput).toEqual(
      imageActions[1]!.sealedOutput,
    );
    // generated MDX + one shared image blob + commit message.
    expect(Object.keys(plan.blobs)).toHaveLength(3);
    expect(blobBytes.size).toBe(3);
  });

  it("preserves the approved prior mode on updates and reports no changes when nothing moved", () => {
    const executable: ApprovedPriorTarget = {
      state: "file",
      contentSha256: sha256OfBytes(IMAGE_ONE_BYTES),
      gitMode: "100755",
    };
    const partial = buildOrThrow({
      priorTargets: priorTargets({
        "public/posts/example/img-1.webp": executable,
      }),
      finalCapture: barrierFor({
        repository: repositoryState(),
        targets: priorTargets({
          "public/posts/example/img-1.webp": executable,
        }),
      }),
    }).plan;
    const updated = partial.actions.find(
      (action) => action.targetPath === "public/posts/example/img-1.webp",
    )!;
    expect(updated.kind).toBe("update");
    expect(updated.expectedGitMode).toBe("100755");
    expect(updated.approvedPriorTarget).toEqual(executable);

    const unchanged = priorTargets({
      "content/posts/example.mdx": {
        state: "file",
        contentSha256: sha256OfBytes(MDX_BYTES),
        gitMode: "100644",
      },
      "public/posts/example/img-1.webp": {
        state: "file",
        contentSha256: sha256OfBytes(IMAGE_ONE_BYTES),
        gitMode: "100644",
      },
      "public/posts/example/img-2.webp": {
        state: "file",
        contentSha256: sha256OfBytes(IMAGE_TWO_BYTES),
        gitMode: "100644",
      },
    });
    const noChanges = buildOrThrow({
      priorTargets: unchanged,
      finalCapture: barrierFor({
        repository: repositoryState(),
        targets: unchanged,
      }),
    }).plan;
    expect(noChanges.state).toBe("no-changes");
    expect(noChanges.actions).toEqual([]);
    expect(noChanges.repositoryFingerprint.targets).toEqual([]);
    expect(Object.keys(noChanges.blobs)).toHaveLength(4);
  });

  it("renders the commit message without treating replacement patterns as expansion", () => {
    const { plan, blobBytes } = buildOrThrow({
      documentTitle: "$& and $` cash",
    });
    const bytes = blobBytes.get(plan.commitMessage.planRelativePath)!;
    expect(new TextDecoder().decode(bytes)).toBe("Publish $& and $` cash\n");
  });

  it("fails closed on unsafe slugs and colliding target paths", () => {
    for (const documentSlug of ["..", ".", "", "a/b", ".git", "con", "name."])
      expect(blockerCode(buildInput({ documentSlug })), documentSlug).toBe(
        ISSUE_CODES.unsafePath,
      );

    const collidingEmbeds = [
      { sourceId: "image-a", assetFileName: "img-1.webp" },
      { sourceId: "image-b", assetFileName: "IMG-1.webp" },
    ];
    const collidingTargets = [
      "content/posts/example.mdx",
      "public/posts/example/img-1.webp",
      "public/posts/example/IMG-1.webp",
    ].map((normalizedPath) => ({
      normalizedPath,
      symlinkStatus: "not-symlink" as const,
      approvedPriorTarget: absent,
    }));
    const insensitive = {
      ...repositoryState(),
      filesystemCaseSensitivity: "insensitive" as const,
    };
    expect(
      blockerCode(
        buildInput({
          imageEmbeds: collidingEmbeds,
          repository: insensitive,
          priorTargets: collidingTargets,
          finalCapture: barrierFor({
            repository: insensitive,
            targets: collidingTargets,
          }),
        }),
      ),
    ).toBe(ISSUE_CODES.unsafePath);
    expect(
      blockerCode(
        buildInput({
          imageEmbeds: collidingEmbeds,
          priorTargets: collidingTargets,
          finalCapture: barrierFor({
            repository: repositoryState(),
            targets: collidingTargets,
          }),
        }),
      ),
    ).toBeUndefined();
  });

  it("rejects overlong slugs and planned target paths with UNSAFE_PATH", () => {
    const overlongSlug = "a".repeat(MAX_PORTABLE_PATH_SEGMENT_LENGTH + 1);
    expect(blockerCode(buildInput({ documentSlug: overlongSlug }))).toBe(
      ISSUE_CODES.unsafePath,
    );

    // Segment-valid slug whose composed MDX filename exceeds NAME_MAX.
    const slugForOverlongMdxSegment = "a".repeat(
      MAX_PORTABLE_PATH_SEGMENT_LENGTH - ".mdx".length + 1,
    );
    expect(
      blockerCode(buildInput({ documentSlug: slugForOverlongMdxSegment })),
    ).toBe(ISSUE_CODES.unsafePath);

    // Segment-valid slug that still pushes the composed repository path past
    // the bounded portable-path contract used for profile roots.
    const contentRoot = DPW_MIND_NET_V1.output.contentRoot;
    const maxSlugForPath =
      MAX_PORTABLE_REPOSITORY_PATH_LENGTH -
      contentRoot.length -
      1 -
      ".mdx".length;
    const overlongPathSlug = "b".repeat(maxSlugForPath + 1);
    expect(overlongPathSlug.length).toBeLessThanOrEqual(
      MAX_PORTABLE_PATH_SEGMENT_LENGTH,
    );
    expect(blockerCode(buildInput({ documentSlug: overlongPathSlug }))).toBe(
      ISSUE_CODES.unsafePath,
    );

    const maxSafeSlug = "c".repeat(
      Math.min(
        maxSlugForPath,
        MAX_PORTABLE_PATH_SEGMENT_LENGTH - ".mdx".length,
      ),
    );
    const repository = repositoryState();
    const safeTargets = [
      {
        normalizedPath: `${contentRoot}/${maxSafeSlug}.mdx`,
        symlinkStatus: "not-symlink" as const,
        approvedPriorTarget: absent,
      },
    ];
    expect(
      blockerCode(
        buildInput({
          documentSlug: maxSafeSlug,
          imageEmbeds: [],
          sourceImages: [],
          transformedImages: [],
          sourceBytes: { note: NOTE_BYTES, images: new Map() },
          priorTargets: safeTargets,
          finalCapture: {
            ...barrierFor({ repository, targets: safeTargets }),
            sourceImages: [],
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("requires probed prior state for exactly the planned target set", () => {
    expect(
      blockerCode(buildInput({ priorTargets: priorTargets().slice(1) })),
    ).toBe(ISSUE_CODES.repositoryPreflightFailed);
    expect(
      blockerCode(
        buildInput({
          priorTargets: [
            ...priorTargets(),
            {
              normalizedPath: "content/posts/other.mdx",
              symlinkStatus: "not-symlink",
              approvedPriorTarget: absent,
            },
          ],
        }),
      ),
    ).toBe(ISSUE_CODES.repositoryPreflightFailed);
  });

  it("fails closed when capture inputs are incoherent", () => {
    expect(
      blockerCode(
        buildInput({
          transformedImages: [{ sourceId: "image-a", bytes: IMAGE_ONE_BYTES }],
        }),
      ),
    ).toBe(ISSUE_CODES.staleDuringPlanning);
    expect(
      blockerCode(
        buildInput({
          transformedImages: [
            { sourceId: "image-a", bytes: IMAGE_ONE_BYTES },
            { sourceId: "image-a", bytes: IMAGE_TWO_BYTES },
          ],
        }),
      ),
    ).toBe(ISSUE_CODES.staleDuringPlanning);
    expect(
      blockerCode(
        buildInput({
          sourceImages: [...sourceImages(), ...sourceImages().slice(0, 1)],
        }),
      ),
    ).toBe(ISSUE_CODES.staleDuringPlanning);
    expect(
      blockerCode(
        buildInput({
          imageEmbeds: [{ sourceId: "image-c", assetFileName: "img-1.webp" }],
        }),
      ),
    ).toBe(ISSUE_CODES.staleDuringPlanning);
  });

  it("discards the plan when the final capture barrier disagrees", () => {
    const mutations: readonly [
      string,
      (barrier: FinalCaptureBarrier) => FinalCaptureBarrier,
    ][] = [
      [
        "profileSnapshotSha256",
        (barrier) => ({ ...barrier, profileSnapshotSha256: digest("other") }),
      ],
      [
        "dependencySnapshotSha256",
        (barrier) => ({
          ...barrier,
          dependencySnapshotSha256: digest("other"),
        }),
      ],
      [
        "sourceNote.contentSha256",
        (barrier) => ({
          ...barrier,
          sourceNote: { ...barrier.sourceNote, contentSha256: digest("edit") },
        }),
      ],
      [
        "sourceNote.byteLength",
        (barrier) => ({
          ...barrier,
          sourceNote: { ...barrier.sourceNote, byteLength: 43 },
        }),
      ],
      [
        "sourceImages.contentSha256",
        (barrier) => ({
          ...barrier,
          sourceImages: barrier.sourceImages.map((image, index) =>
            index === 0 ? { ...image, contentSha256: digest("edit") } : image,
          ),
        }),
      ],
      [
        "sourceImages.length",
        (barrier) => ({
          ...barrier,
          sourceImages: barrier.sourceImages.slice(1),
        }),
      ],
      [
        "repository.oids.head",
        (barrier) => ({
          ...barrier,
          repository: {
            ...barrier.repository,
            oids: { ...barrier.repository.oids, head: "b".repeat(40) },
          },
        }),
      ],
      [
        "repository.stateHashes.indexSha256",
        (barrier) => ({
          ...barrier,
          repository: {
            ...barrier.repository,
            stateHashes: {
              ...barrier.repository.stateHashes,
              indexSha256: digest("moved"),
            },
          },
        }),
      ],
      [
        "targets.approvedPriorTarget",
        (barrier) => ({
          ...barrier,
          targets: barrier.targets.map((target, index) =>
            index === 0
              ? {
                  ...target,
                  approvedPriorTarget: {
                    state: "file",
                    contentSha256: digest("appeared"),
                    gitMode: "100644",
                  },
                }
              : target,
          ),
        }),
      ],
      [
        "targets.length",
        (barrier) => ({ ...barrier, targets: barrier.targets.slice(1) }),
      ],
    ];

    for (const [label, mutate] of mutations) {
      const input = buildInput();
      expect(
        blockerCode({ ...input, finalCapture: mutate(input.finalCapture) }),
        label,
      ).toBe(ISSUE_CODES.staleDuringPlanning);
    }
    expect(blockerCode(buildInput())).toBeUndefined();
  });

  it("enforces the sealed output count, size, and total size limits exactly", () => {
    const embedCount = MDX_RELAY_LIMITS.sealedOutputFiles - 1;
    const withImageCount = (
      count: number,
      outputBytes?: number,
    ): ExportPlanBuildInput => {
      const imageSourceBytes = Array.from({ length: count }, (_, index) =>
        utf8(`png-source-${index}`),
      );
      const images = Array.from({ length: count }, (_, index) => ({
        sourceId: `image-${String(index).padStart(3, "0")}`,
        vaultRelativePath: `assets/${index}.png`,
        realPath: `/vault/assets/${index}.png`,
        decodedMime: "image/png" as const,
        byteLength: imageSourceBytes[index]!.byteLength,
        contentSha256: sha256OfBytes(imageSourceBytes[index]!),
      }));
      const targets = [
        {
          normalizedPath: "content/posts/example.mdx",
          symlinkStatus: "not-symlink" as const,
          approvedPriorTarget: absent,
        },
        ...images.map((_, index) => ({
          normalizedPath: `public/posts/example/img-${index + 1}.webp`,
          symlinkStatus: "not-symlink" as const,
          approvedPriorTarget: absent,
        })),
      ];
      const repository = repositoryState();
      return {
        ...buildInput({ repository, priorTargets: targets }),
        ...(outputBytes === undefined
          ? {}
          : { generatedMdxBytes: new Uint8Array(outputBytes).fill(255) }),
        sourceImages: images,
        sourceBytes: {
          note: NOTE_BYTES,
          images: new Map(
            images.map((image, index) => [
              image.sourceId,
              imageSourceBytes[index]!,
            ]),
          ),
        },
        transformedImages: images.map((image, index) => ({
          sourceId: image.sourceId,
          bytes:
            outputBytes === undefined
              ? utf8(`webp-${index}`)
              : new Uint8Array(outputBytes).fill(index),
        })),
        imageEmbeds: images.map((image, index) => ({
          sourceId: image.sourceId,
          assetFileName: `img-${index + 1}.webp`,
        })),
        finalCapture: {
          ...barrierFor({ repository, targets }),
          sourceImages: images.map(
            ({ sourceId, byteLength, contentSha256 }) => ({
              sourceId,
              byteLength,
              contentSha256,
            }),
          ),
        },
      };
    };

    // MDX + N images + commit message.
    expect(blockerCode(withImageCount(embedCount - 1))).toBeUndefined();
    expect(blockerCode(withImageCount(embedCount))).toBe(
      ISSUE_CODES.outputFileLimitExceeded,
    );

    expect(
      blockerCode(
        buildInput({
          generatedMdxBytes: new Uint8Array(
            MDX_RELAY_LIMITS.sealedOutputBytes + 1,
          ),
        }),
      ),
    ).toBe(ISSUE_CODES.outputTooLarge);

    // Four maximum-size outputs sit exactly on the total budget; the sealed
    // commit message is what pushes the plan past it.
    expect(
      blockerCode(withImageCount(3, MDX_RELAY_LIMITS.sealedOutputBytes)),
    ).toBe(ISSUE_CODES.totalOutputTooLarge);
    expect(
      blockerCode(withImageCount(2, MDX_RELAY_LIMITS.sealedOutputBytes)),
    ).toBeUndefined();
  });
});

describe("source-byte verification and locked source limits", () => {
  const noteOf = (bytes: Uint8Array): SourceNoteMetadata => ({
    ...sourceNote(),
    byteLength: bytes.byteLength,
    contentSha256: sha256OfBytes(bytes),
  });

  const withSourceNoteBytes = (bytes: Uint8Array): ExportPlanBuildInput => {
    const input = buildInput();
    return {
      ...input,
      sourceNote: noteOf(bytes),
      sourceBytes: { ...sourceBytes(), note: bytes },
      finalCapture: {
        ...input.finalCapture,
        sourceNote: {
          byteLength: bytes.byteLength,
          contentSha256: sha256OfBytes(bytes),
        },
      },
    };
  };

  const withSourceImageBytes = (bytes: Uint8Array): ExportPlanBuildInput => {
    const input = buildInput();
    const images = input.sourceImages.map((image) =>
      image.sourceId === "image-a"
        ? {
            ...image,
            byteLength: bytes.byteLength,
            contentSha256: sha256OfBytes(bytes),
          }
        : image,
    );
    return {
      ...input,
      sourceImages: images,
      sourceBytes: {
        note: NOTE_BYTES,
        images: new Map([
          ["image-a", bytes],
          ["image-b", SOURCE_B_BYTES],
        ]),
      },
      finalCapture: {
        ...input.finalCapture,
        sourceImages: images.map(({ sourceId, byteLength, contentSha256 }) => ({
          sourceId,
          byteLength,
          contentSha256,
        })),
      },
    };
  };

  it("enforces the locked note and source-image budgets exactly at the boundary", () => {
    expect(
      blockerCode(
        withSourceNoteBytes(new Uint8Array(MDX_RELAY_LIMITS.noteBytes)),
      ),
    ).toBeUndefined();
    expect(
      blockerCode(
        withSourceNoteBytes(new Uint8Array(MDX_RELAY_LIMITS.noteBytes + 1)),
      ),
    ).toBe(ISSUE_CODES.noteTooLarge);

    expect(
      blockerCode(
        withSourceImageBytes(
          new Uint8Array(MDX_RELAY_LIMITS.sourceImageBytes).fill(7),
        ),
      ),
    ).toBeUndefined();
    expect(
      blockerCode(
        withSourceImageBytes(
          new Uint8Array(MDX_RELAY_LIMITS.sourceImageBytes + 1).fill(7),
        ),
      ),
    ).toBe(ISSUE_CODES.sourceImageTooLarge);
  });

  it("refuses source metadata the captured bytes do not prove", () => {
    const input = buildInput();
    const forgedNote: ExportPlanBuildInput = {
      ...input,
      sourceNote: { ...input.sourceNote, contentSha256: digest("forged") },
      finalCapture: {
        ...input.finalCapture,
        sourceNote: {
          byteLength: input.sourceNote.byteLength,
          contentSha256: digest("forged"),
        },
      },
    };
    expect(blockerCode(forgedNote)).toBe(ISSUE_CODES.staleDuringPlanning);

    const forgedLength: ExportPlanBuildInput = {
      ...input,
      sourceNote: { ...input.sourceNote, byteLength: 1 },
      finalCapture: {
        ...input.finalCapture,
        sourceNote: { byteLength: 1, contentSha256: sha256OfBytes(NOTE_BYTES) },
      },
    };
    expect(blockerCode(forgedLength)).toBe(ISSUE_CODES.staleDuringPlanning);

    for (const [label, images] of [
      ["missing image bytes", new Map([["image-a", SOURCE_A_BYTES]])],
      [
        "extra image bytes",
        new Map([
          ["image-a", SOURCE_A_BYTES],
          ["image-b", SOURCE_B_BYTES],
          ["image-c", SOURCE_B_BYTES],
        ]),
      ],
      [
        "swapped image bytes",
        new Map([
          ["image-a", SOURCE_B_BYTES],
          ["image-b", SOURCE_A_BYTES],
        ]),
      ],
    ] as const)
      expect(
        blockerCode({
          ...input,
          sourceBytes: { note: NOTE_BYTES, images },
        }),
        label,
      ).toBe(ISSUE_CODES.staleDuringPlanning);
  });

  it("carries only the canonical source bytes into the draft", () => {
    const draft = buildOrThrow();
    expect(draft.sourceBytes.note).toBe(NOTE_BYTES);
    expect([...draft.sourceBytes.images.keys()].sort()).toEqual([
      "image-a",
      "image-b",
    ]);
    expect(draft.sourceBytes.images.get("image-a")).toBe(SOURCE_A_BYTES);
  });

  it("reports the exact reason a source fingerprint fails", () => {
    const note = {
      byteLength: NOTE_BYTES.byteLength,
      contentSha256: sha256OfBytes(NOTE_BYTES),
    };
    const images = [
      {
        sourceId: "image-a",
        byteLength: SOURCE_A_BYTES.byteLength,
        contentSha256: sha256OfBytes(SOURCE_A_BYTES),
      },
      {
        sourceId: "image-b",
        byteLength: SOURCE_B_BYTES.byteLength,
        contentSha256: sha256OfBytes(SOURCE_B_BYTES),
      },
    ];
    expect(verifySourceBytes(note, images, sourceBytes())).toBeUndefined();
    expect(
      verifySourceBytes(note, [], { note: NOTE_BYTES, images: new Map() }),
    ).toBeUndefined();
    expect(
      verifySourceBytes({ ...note, byteLength: note.byteLength + 1 }, [], {
        note: NOTE_BYTES,
        images: new Map(),
      }),
    ).toBe(ISSUE_CODES.staleDuringPlanning);
  });

  it("rejects lone UTF-16 surrogates and accepts astral Unicode", () => {
    for (const wellFormed of ["", "plain", "ünïcode", "😀", "a\u{10FFFF}b"])
      expect(isWellFormedUnicode(wellFormed), wellFormed).toBe(true);
    for (const illFormed of [
      "\uD800",
      "\uDC00",
      "a\uD800b",
      "a\uDC00b",
      "\uD800\uD800",
      "\uDC00\uD800",
      "trailing\uD83D",
    ])
      expect(isWellFormedUnicode(illFormed), JSON.stringify(illFormed)).toBe(
        false,
      );
  });
});

describe("planning path and equality helpers", () => {
  it("accepts portable repository paths and rejects escape shapes", () => {
    for (const value of ["content/posts/a.mdx", "a", "a/b/c.webp"])
      expect(isPortableRepositoryPath(value), value).toBe(true);
    for (const value of [
      "",
      "/absolute",
      "a\\b",
      "C:/temp",
      "../escape",
      "a/./b",
      "a//b",
      ".git/config",
      "content/.GIT/x",
      "content/con",
      "content/a.",
      "content/a ",
      "content/a\u0000b",
      "a".repeat(MAX_PORTABLE_REPOSITORY_PATH_LENGTH + 1),
      `content/${"a".repeat(MAX_PORTABLE_PATH_SEGMENT_LENGTH + 1)}`,
    ])
      expect(isPortableRepositoryPath(value), value).toBe(false);
    expect(
      isPortableRepositoryPath("a".repeat(MAX_PORTABLE_REPOSITORY_PATH_LENGTH)),
    ).toBe(true);
  });

  it("compares plain planning data structurally", () => {
    expect(deepEquals({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] })).toBe(
      true,
    );
    expect(deepEquals({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEquals([1, 2], [2, 1])).toBe(false);
    expect(deepEquals([1], { 0: 1 })).toBe(false);
    expect(deepEquals(null, {})).toBe(false);
    expect(deepEquals({ a: 1 }, null)).toBe(false);
    expect(deepEquals("a", "a")).toBe(true);
  });
});
