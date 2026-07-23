import { describe, expect, it } from "vitest";

import {
  matchesApprovalContext,
  type ApprovedPriorTarget,
  type CanonicalDependencySnapshot,
  type GenerationToken,
  type RepositoryFingerprint,
  type RepositoryTargetFingerprint,
  type ValidatedPortableProfileSnapshot,
} from "../../../src/contracts/export-plan";
import { createIssue, ISSUE_CODES } from "../../../src/contracts/issues";
import {
  buildExportPlan,
  sha256OfBytes,
  sha256OfUtf8,
  type ExportPlanBuildInput,
  type ExportPlanDraft,
} from "../../../src/planning/build-export-plan";
import {
  buildPlanIdentityManifest,
  canonicalizeJcs,
  computePlanId,
  sealExportPlan,
  verifyStoredExportPlan,
} from "../../../src/planning/seal-export-plan";
import { DPW_MIND_NET_V1 } from "../../../src/profiles/builtins/dpw-mind-net-v1";

const utf8 = (value: string) => new TextEncoder().encode(value);
const digest = (value: string) => sha256OfBytes(utf8(value));

const PROFILE_SNAPSHOT = JSON.stringify(DPW_MIND_NET_V1);
const DEPENDENCY_SNAPSHOT = '{"images":["assets/a.png"]}';
const MDX_BYTES = utf8("---\ntitle: Example\n---\n\nBody\n");
const IMAGE_BYTES = utf8("webp-bytes");
const NOW = "2026-07-20T01:00:00.000Z";

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
      byteLength: 42,
      contentSha256: digest("note"),
    },
    sourceImages: [
      {
        sourceId: "image-a",
        vaultRelativePath: "assets/a.png",
        realPath: "/vault/assets/a.png",
        decodedMime: "image/png",
        byteLength: 10,
        contentSha256: digest("source-a"),
      },
    ],
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
      sourceNote: { byteLength: 42, contentSha256: digest("note") },
      sourceImages: [
        {
          sourceId: "image-a",
          byteLength: 10,
          contentSha256: digest("source-a"),
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

const tamperCode = (
  plan: unknown,
  blobBytes: ReadonlyMap<string, Uint8Array>,
  currentUtc = NOW,
): string | undefined => {
  const result = verifyStoredExportPlan(plan, blobBytes, currentUtc);
  return result.ok ? undefined : result.error[0].code;
};

describe("canonicalizeJcs", () => {
  it("orders keys by UTF-16 code unit and serializes JSON scalars canonically", () => {
    expect(canonicalizeJcs({ b: 1, a: 2, ä: 3, A: 4 })).toBe(
      '{"A":4,"a":2,"b":1,"ä":3}',
    );
    expect(canonicalizeJcs({ a: { z: [1, { y: null }], "": true } })).toBe(
      '{"a":{"":true,"z":[1,{"y":null}]}}',
    );
    expect(canonicalizeJcs([1, 1.5, -0.25, 1e21, 0])).toBe(
      "[1,1.5,-0.25,1e+21,0]",
    );
    expect(canonicalizeJcs('quote " tab \t  ünïcode')).toBe(
      JSON.stringify('quote " tab \t  ünïcode'),
    );
  });

  it("refuses values that are not finite JSON data", () => {
    for (const value of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      () => 1,
      Symbol("x"),
      { ok: undefined },
      [undefined],
    ])
      expect(() => canonicalizeJcs(value)).toThrow(TypeError);
  });

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

describe("sealExportPlan", () => {
  it("seals a ready plan the frozen approval gate accepts", () => {
    const envelope = sealOrThrow();

    expect(envelope.state).toBe("ready");
    expect(envelope.planId).toMatch(/^plan-[0-9a-f]{64}$/u);
    expect(envelope.plan.planId).toBe(envelope.planId);
    expect(computePlanId(envelope.identityManifest)).toBe(envelope.planId);
    if (envelope.state !== "ready") throw new Error("expected a ready plan");
    expect(
      matchesApprovalContext(
        envelope.plan,
        {
          generationToken: envelope.plan.generationToken,
          planId: envelope.planId,
        },
        envelope.plan.approvalFingerprint,
        NOW,
      ),
    ).toBe(true);
    expect(Object.isFrozen(envelope.plan)).toBe(true);
    expect(Object.isFrozen(envelope.plan.actions)).toBe(true);
  });

  it("derives one plan ID per identity, independent of the generation token", () => {
    const base = sealOrThrow().planId;
    expect(sealOrThrow().planId).toBe(base);
    expect(
      sealOrThrow({ generationToken: "generation-9" as GenerationToken })
        .planId,
    ).toBe(base);

    for (const changed of [
      sealOrThrow({ documentTitle: "Other" }),
      sealOrThrow({ generatedMdxBytes: utf8("---\ntitle: X\n---\n") }),
      sealOrThrow({ expiresAtUtc: "2026-07-28T00:00:00.000Z" }),
      sealOrThrow({
        warnings: [createIssue(ISSUE_CODES.summaryMissing)],
      }),
    ])
      expect(changed.planId).not.toBe(base);
  });

  it("seals a no-changes plan with no actions", () => {
    const targets = unchangedTargets();
    const envelope = sealOrThrow({
      priorTargets: targets,
      finalCapture: { ...buildInput().finalCapture, targets },
    });
    expect(envelope.state).toBe("no-changes");
    expect(envelope.plan.actions).toEqual([]);
    expect(envelope.plan.repositoryFingerprint.targets).toEqual([]);
    expect(
      verifyStoredExportPlan(restored(envelope), envelope.blobBytes, NOW).ok,
    ).toBe(true);
  });

  it("refuses to seal a draft whose recorded snapshot digests do not verify", () => {
    const draft = draftFor();
    const incoherent = {
      plan: {
        ...draft.plan,
        profileSnapshotSha256: digest("not-the-profile"),
      },
      blobBytes: draft.blobBytes,
    } as ExportPlanDraft;
    const result = sealExportPlan(incoherent);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error[0].code).toBe(ISSUE_CODES.staleDuringPlanning);
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
