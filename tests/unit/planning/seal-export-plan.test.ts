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
  type PlanSourceBytes,
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

  it("terminates on invalid Unicode and emits astral characters literally", () => {
    for (const loneSurrogate of ["\uD800", "\uDC00", "\uDBFF", "\uDFFF"]) {
      expect(() => canonicalizeJcs(loneSurrogate), loneSurrogate).toThrow(
        TypeError,
      );
      expect(() => canonicalizeJcs({ key: loneSurrogate })).toThrow(TypeError);
      expect(() => canonicalizeJcs([loneSurrogate])).toThrow(TypeError);
      expect(() => canonicalizeJcs({ [loneSurrogate]: 1 })).toThrow(TypeError);
      expect(() =>
        canonicalizeJcs({ nested: { deep: [{ value: loneSurrogate }] } }),
      ).toThrow(TypeError);
    }
    expect(() => canonicalizeJcs("a\uD83Db")).toThrow(TypeError);

    // Valid astral Unicode is data, not an error, and is emitted literally.
    for (const astral of ["😀", "\u{1F600}\u{10FFFF}", "🧑‍💻"]) {
      expect(canonicalizeJcs(astral)).toBe(JSON.stringify(astral));
      expect(canonicalizeJcs({ [astral]: astral })).toBe(
        `{${JSON.stringify(astral)}:${JSON.stringify(astral)}}`,
      );
    }
    expect(computePlanId(canonicalizeJcs({ a: "😀" }))).toBe(
      computePlanId(canonicalizeJcs({ a: "\u{1F600}" })),
    );
    expect(computePlanId(canonicalizeJcs({ a: "😀" }))).not.toBe(
      computePlanId(canonicalizeJcs({ a: "😁" })),
    );
  });

  it("fails closed on array holes, accessors, and non-plain JSON containers", () => {
    const withHole = [1, 2, 3];
    delete withHole[1];
    expect(() => canonicalizeJcs(withHole)).toThrow(TypeError);
    expect(() => canonicalizeJcs(Array.from({ length: 2 }))).toThrow(TypeError);

    const namedArray: unknown[] & { extra?: number } = [1];
    namedArray.extra = 2;
    expect(() => canonicalizeJcs(namedArray)).toThrow(TypeError);

    const accessor = {};
    Object.defineProperty(accessor, "steered", {
      enumerable: true,
      get: () => "chosen at read time",
    });
    expect(() => canonicalizeJcs(accessor)).toThrow(TypeError);

    const hidden = { visible: 1 };
    Object.defineProperty(hidden, "hidden", {
      enumerable: false,
      value: "ignored by JSON.stringify",
    });
    expect(() => canonicalizeJcs(hidden)).toThrow(TypeError);

    expect(() => canonicalizeJcs({ [Symbol("key")]: 1, a: 1 })).toThrow(
      TypeError,
    );
    expect(() =>
      canonicalizeJcs({
        toJSON: () => ({ replaced: true }),
      }),
    ).toThrow(TypeError);
    for (const exotic of [
      new Date(0),
      new Map([["a", 1]]),
      new Set([1]),
      new (class Plan {
        value = 1;
      })(),
      Object.create({ inherited: 1 }) as object,
      Object("boxed"),
    ])
      expect(() => canonicalizeJcs(exotic), String(exotic)).toThrow(TypeError);

    // A null-prototype record is still plain JSON data.
    const bare = Object.create(null) as Record<string, unknown>;
    bare.b = 1;
    bare.a = 2;
    expect(canonicalizeJcs(bare)).toBe('{"a":2,"b":1}');
  });

  it("refuses hostile array containers without running a single accessor", () => {
    let sideEffects = 0;
    const trap = {
      enumerable: true,
      configurable: true,
      get: () => {
        sideEffects += 1;
        return "chosen at read time";
      },
      set: () => {
        sideEffects += 1;
      },
    };

    const indexedAccessor: unknown[] = [];
    Object.defineProperty(indexedAccessor, "0", trap);
    indexedAccessor.length = 1;
    expect(() => canonicalizeJcs(indexedAccessor)).toThrow(TypeError);

    const trailingAccessor = ["first"];
    Object.defineProperty(trailingAccessor, "1", trap);
    expect(() => canonicalizeJcs(trailingAccessor)).toThrow(TypeError);

    // An accessor buried inside an otherwise ordinary plan is refused too.
    const nestedAccessor: unknown[] = [];
    Object.defineProperty(nestedAccessor, "0", trap);
    nestedAccessor.length = 1;
    expect(() =>
      canonicalizeJcs({ actions: { targets: nestedAccessor } }),
    ).toThrow(TypeError);

    const nonEnumerableIndex = ["first"];
    Object.defineProperty(nonEnumerableIndex, "0", {
      enumerable: false,
      value: "hidden from JSON",
    });
    expect(() => canonicalizeJcs(nonEnumerableIndex)).toThrow(TypeError);

    const hiddenNamed = ["first"];
    Object.defineProperty(hiddenNamed, "smuggled", {
      enumerable: false,
      value: "ignored by JSON.stringify",
    });
    expect(() => canonicalizeJcs(hiddenNamed)).toThrow(TypeError);

    const symbolKeyed = ["first"];
    (symbolKeyed as unknown as Record<symbol, unknown>)[Symbol("smuggled")] =
      "ignored by JSON.stringify";
    expect(() => canonicalizeJcs(symbolKeyed)).toThrow(TypeError);

    const exoticPrototype = ["first"];
    Object.setPrototypeOf(exoticPrototype, {
      ...Array.prototype,
      toJSON: () => ["replaced"],
    });
    expect(() => canonicalizeJcs(exoticPrototype)).toThrow(TypeError);

    const subclassed = new (class Targets extends Array {})();
    subclassed.push("first");
    expect(() => canonicalizeJcs(subclassed as unknown[])).toThrow(TypeError);

    // Non-index named keys, fractional and padded index spellings are not data.
    for (const key of ["extra", "01", "1.0", "-1", "1e0", " 0"]) {
      const named: unknown[] = ["first"];
      Object.defineProperty(named, key, {
        enumerable: true,
        configurable: true,
        value: "smuggled",
      });
      expect(() => canonicalizeJcs(named), key).toThrow(TypeError);
    }

    // Nothing above got as far as reading an element.
    expect(sideEffects).toBe(0);

    // Ordinary dense arrays, frozen and astral ones included, still canonicalize.
    expect(canonicalizeJcs([])).toBe("[]");
    expect(canonicalizeJcs([1, "two", null, true, [3], { a: 4 }])).toBe(
      '[1,"two",null,true,[3],{"a":4}]',
    );
    expect(canonicalizeJcs(Object.freeze(["frozen", 1]))).toBe('["frozen",1]');
    expect(canonicalizeJcs(["😀", "\u{1F600}"])).toBe('["😀","😀"]');
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
    // The frozen brand is reachable only through a source-byte verified seal.
    expect(envelope.sourceBytesVerified).toBe(true);
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected a source-verified ready plan");
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

    const unchanged = unchangedTargets();
    const noChanges = sealOrThrow({
      priorTargets: unchanged,
      finalCapture: { ...buildInput().finalCapture, targets: unchanged },
    });
    expect(noChanges.state).toBe("no-changes");
    for (const [label, digestValue] of [
      ["no-changes forged digest", digest("forged-transform")],
      [
        "no-changes commit-message blob",
        (noChanges.plan as { commitMessage: { contentSha256: string } })
          .commitMessage.contentSha256,
      ],
    ] as const) {
      const forged = forgeTransform(noChanges, digestValue);
      expect(structuralCode(forged, noChanges.blobBytes), label).toBe(
        ISSUE_CODES.storageTampered,
      );
      expect(tamperCode(forged, noChanges.blobBytes), label).toBe(
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
