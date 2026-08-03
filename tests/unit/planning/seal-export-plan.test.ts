import { describe, expect, it } from "vitest";

import { canonicalizeJcs } from "../../../src/canonical";
import { sha256OfBytes, sha256OfUtf8 } from "../../../src/canonical/hash";
import {
  matchesApprovalContext,
  type ApprovedPriorTarget,
  type CanonicalDependencySnapshot,
  type GenerationToken,
  type TargetSnapshotEntry,
  type ValidatedPortableProfileSnapshot,
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

const sourceBytes = (): PlanSourceBytes => ({
  note: NOTE_BYTES,
  images: new Map([["image-a", SOURCE_A_BYTES]]),
});

const TARGET_ROOT = "/repo/target";
const CASE_SENSITIVITY = "sensitive" as const;

const targetsWith = (
  overrides: Readonly<Record<string, ApprovedPriorTarget>> = {},
): readonly TargetSnapshotEntry[] =>
  ["content/posts/example.mdx", "public/posts/example/img-1.webp"].map(
    (relativePath) => ({
      relativePath,
      priorState: overrides[relativePath] ?? { state: "absent" },
    }),
  );

const buildInput = (
  overrides: Partial<ExportPlanBuildInput> = {},
): ExportPlanBuildInput => {
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
    generatedMdxBytes: MDX_BYTES,
    transformedImages: [{ sourceId: "image-a", bytes: IMAGE_BYTES }],
    imageEmbeds: [{ sourceId: "image-a", assetFileName: "img-1.webp" }],
    targetRootRealPath: TARGET_ROOT,
    caseSensitivity: CASE_SENSITIVITY,
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
      targetRootRealPath: TARGET_ROOT,
      caseSensitivity: CASE_SENSITIVITY,
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

const unchangedTargets = (): readonly TargetSnapshotEntry[] =>
  targetsWith({
    "content/posts/example.mdx": {
      state: "regularFile",
      contentSha256: sha256OfBytes(MDX_BYTES),
    },
    "public/posts/example/img-1.webp": {
      state: "regularFile",
      contentSha256: sha256OfBytes(IMAGE_BYTES),
    },
  });

/** Round-trips through JSON exactly as private storage does. */
const restored = (envelope: {
  readonly plan: unknown;
}): Record<string, unknown> =>
  JSON.parse(JSON.stringify(envelope.plan)) as Record<string, unknown>;

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
      // frozen target-folder path ordering gate.
      targetPath: `public/posts/example/img-${String(index + 1).padStart(3, "0")}.webp`,
      sourceOccurrence: index + 1,
    });
  }
  plan.actions = expanded;
  plan.targetOutputs = expanded.map(
    ({ documentOrder, targetPath, sealedOutput, sourceOccurrence }) => ({
      documentOrder,
      targetPath,
      sealedOutput,
      sourceOccurrence,
    }),
  );
  const targets = expanded
    .map((action) => ({
      relativePath: action.targetPath as string,
      priorState: action.approvedPriorTarget,
    }))
    .sort((left, right) =>
      left.relativePath < right.relativePath
        ? -1
        : left.relativePath > right.relativePath
          ? 1
          : 0,
    );
  const snapshot = {
    ...(plan.targetFolderSnapshot as Record<string, unknown>),
    targets,
  };
  plan.targetFolderSnapshot = snapshot;
  (
    plan.approvalFingerprint as { targetFolderSnapshot: unknown }
  ).targetFolderSnapshot = snapshot;
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
      sealOrThrow({ generatedMdxBytes: utf8("---\ntitle: X\n---\n") }),
      sealOrThrow({ expiresAtUtc: "2026-07-28T00:00:00.000Z" }),
      sealOrThrow({
        warnings: [createIssue(ISSUE_CODES.summaryMissing)],
      }),
      sealOrThrow({
        transformedImages: [{ sourceId: "image-a", bytes: utf8("other-webp") }],
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
    expect(envelope.plan.targetFolderSnapshot.targets).toEqual(targets);
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

  it("refuses to seal a draft whose target actions exceed the locked file budget", () => {
    const draft = draftFor();
    const overLimit = restored({ plan: draft.plan });
    expandSharedImageActions(overLimit, MDX_RELAY_LIMITS.sealedOutputFiles + 1);
    const result = sealExportPlan({
      plan: overLimit as unknown as ExportPlanDraft["plan"],
      blobBytes: draft.blobBytes,
      sourceBytes: draft.sourceBytes,
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error[0].code).toBe(ISSUE_CODES.staleDuringPlanning);

    const atLimit = restored({ plan: draft.plan });
    expandSharedImageActions(atLimit, MDX_RELAY_LIMITS.sealedOutputFiles);
    expect(
      sealExportPlan({
        plan: atLimit as unknown as ExportPlanDraft["plan"],
        blobBytes: draft.blobBytes,
        sourceBytes: draft.sourceBytes,
      }).ok,
    ).toBe(true);
  });
});
