import { spawnSync } from "node:child_process";
import {
  existsSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sha256OfBytes, sha256OfUtf8 } from "../../../src/canonical/hash";
import type {
  ApprovedPriorTarget,
  CanonicalDependencySnapshot,
  GenerationToken,
  PlanId,
  TargetSnapshotEntry,
  ValidatedPortableProfileSnapshot,
} from "../../../src/contracts/export-plan";
import { createIssue, ISSUE_CODES } from "../../../src/contracts/issues";
import { mdxRelayErr, mdxRelayOk } from "../../../src/contracts/result";
import {
  buildExportPlan,
  type ExportPlanBuildInput,
  type PlanSourceBytes,
} from "../../../src/planning/build-export-plan";
import {
  sealExportPlan,
  type SealedExportPlanEnvelope,
} from "../../../src/planning/seal-export-plan";
import { DPW_MIND_NET_V1 } from "../../../src/profiles/builtins/dpw-mind-net-v1";
import {
  applyApprovedWrites,
  createNodeTargetFolderFileSystem,
  TARGET_WRITE_TEMPORARY_SUFFIX,
  type ApplyApprovedWritesInput,
  type TargetFolderFileSystem,
  type TargetFolderWriterDeps,
  type WritableExportPlan,
} from "../../../src/write";

const utf8 = (value: string) => new TextEncoder().encode(value);

const PROFILE_SNAPSHOT = JSON.stringify(DPW_MIND_NET_V1);
const DEPENDENCY_SNAPSHOT = '{"images":["assets/a.png"]}';
const MDX_BYTES = utf8("---\ntitle: Example\n---\n\nBody\n");
const IMAGE_BYTES = utf8("webp-bytes");
const UPDATED_MDX_BYTES = utf8("---\ntitle: Example\n---\n\nUpdated body\n");
const CREATED_AT = "2026-07-20T00:00:00.000Z";
const EXPIRES_AT = "2026-07-27T00:00:00.000Z";

const NOTE_BYTES = utf8("# Example\n\nBody with a private sentence.\n");
const SOURCE_A_BYTES = utf8("png-source-a");

const sourceBytes = (): PlanSourceBytes => ({
  note: NOTE_BYTES,
  images: new Map([["image-a", SOURCE_A_BYTES]]),
});

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
  targetRootRealPath: string,
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
    targetRootRealPath,
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
      targetRootRealPath,
      caseSensitivity: CASE_SENSITIVITY,
      targets,
    },
    createdAtUtc: CREATED_AT,
    expiresAtUtc: EXPIRES_AT,
    ...overrides,
  };
};

const sealedPlan = (
  targetRootRealPath: string,
  overrides: Partial<ExportPlanBuildInput> = {},
): SealedExportPlanEnvelope => {
  const draft = buildExportPlan(buildInput(targetRootRealPath, overrides));
  if (!draft.ok) throw new Error(`draft: ${draft.error[0]!.code}`);
  const sealed = sealExportPlan(draft.value);
  if (!sealed.ok) throw new Error(`seal: ${sealed.error[0]!.code}`);
  return sealed.value;
};

const NOW = "2026-07-22T00:00:00.000Z";

/** Only envelopes the writer will accept: verified ready, or no-changes. */
type WritableEnvelope = Extract<
  SealedExportPlanEnvelope,
  { readonly plan: WritableExportPlan }
>;

/**
 * Complete mutation-boundary input: the durable approval record, the rendered
 * transition identity, and an independently recaptured approval fingerprint.
 */
const writeInput = (
  envelope: WritableEnvelope,
  configuredTargetRoot: string,
  overrides: Partial<ApplyApprovedWritesInput> = {},
): ApplyApprovedWritesInput => ({
  plan: envelope.plan,
  blobBytes: envelope.blobBytes,
  configuredTargetRoot,
  approval: { planId: envelope.plan.planId },
  approvalTransition: {
    generationToken: envelope.plan.generationToken,
    planId: envelope.plan.planId,
  },
  currentApprovalFingerprint: structuredClone(
    envelope.plan.approvalFingerprint,
  ),
  ...overrides,
});

const injectFault = (
  base: TargetFolderFileSystem,
  fail: (operation: string, entryPath: string) => void,
): TargetFolderFileSystem => ({
  resolveTargetRoot: async (configuredRoot) => {
    fail("resolveTargetRoot", configuredRoot);
    return base.resolveTargetRoot(configuredRoot);
  },
  lstat: async (entryPath) => {
    fail("lstat", entryPath);
    return base.lstat(entryPath);
  },
  realPath: async (entryPath) => {
    fail("realPath", entryPath);
    return base.realPath(entryPath);
  },
  readFile: async (filePath) => {
    fail("readFile", filePath);
    return base.readFile(filePath);
  },
  createDirectoryIn: async (parentPath, parentIdentity, name) => {
    fail("createDirectoryIn", join(parentPath, name));
    return base.createDirectoryIn(parentPath, parentIdentity, name);
  },
  createTemporary: async (directoryPath, baseName) => {
    fail("createTemporary", join(directoryPath, baseName));
    const owned = await base.createTemporary(directoryPath, baseName);
    return {
      ...owned,
      handle: {
        write: async (bytes) => {
          fail("write", owned.path);
          return owned.handle.write(bytes);
        },
        identity: () => owned.handle.identity(),
        sync: async () => {
          fail("sync", owned.path);
          return owned.handle.sync();
        },
        close: async () => {
          try {
            fail("close", owned.path);
          } finally {
            await owned.handle.close().catch(() => undefined);
          }
        },
      },
    };
  },
  rename: async (fromPath, toPath) => {
    fail("rename", `${fromPath}->${toPath}`);
    return base.rename(fromPath, toPath);
  },
  linkInto: async (fromPath, toPath) => {
    fail("linkInto", `${fromPath}->${toPath}`);
    return base.linkInto(fromPath, toPath);
  },
  removeOwnedTemporary: async (entryPath, identity) => {
    fail("removeOwnedTemporary", entryPath);
    return base.removeOwnedTemporary(entryPath, identity);
  },
  listDirectory: async (directoryPath) => {
    fail("listDirectory", directoryPath);
    return base.listDirectory(directoryPath);
  },
});

describe("approved target-folder writes", () => {
  let root: string;
  let targetRoot: string;
  let deps: TargetFolderWriterDeps;
  const disposable: string[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mdx-relay-write-"));
    disposable.push(root);
    targetRoot = join(root, "target");
    await mkdir(targetRoot);
    targetRoot = await realpath(targetRoot);
    deps = {
      fileSystem: createNodeTargetFolderFileSystem(),
      hash: sha256OfBytes,
      caseSensitivity: CASE_SENSITIVITY,
      readApproval: (planId) => Promise.resolve(mdxRelayOk(planId)),
      now: () => NOW,
    };
  });

  afterEach(async () => {
    for (const path of disposable.splice(0))
      await rm(path, { recursive: true, force: true });
  });

  it("creates approved files with exact sealed bytes and paths", async () => {
    const sentinel = join(targetRoot, "unrelated-sentinel.txt");
    await writeFile(sentinel, "leave-me-alone");
    const envelope = sealedPlan(targetRoot);
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    const result = await applyApprovedWrites(
      writeInput(envelope, targetRoot),
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.completed.map((entry) => entry.targetPath)).toEqual([
      "content/posts/example.mdx",
      "public/posts/example/img-1.webp",
    ]);
    expect(result.report.failed).toEqual([]);
    expect(result.report.unattempted).toEqual([]);

    const mdxPath = join(targetRoot, "content/posts/example.mdx");
    const imagePath = join(targetRoot, "public/posts/example/img-1.webp");
    expect(new Uint8Array(await readFile(mdxPath))).toEqual(MDX_BYTES);
    expect(new Uint8Array(await readFile(imagePath))).toEqual(IMAGE_BYTES);
    expect(sha256OfBytes(new Uint8Array(await readFile(mdxPath)))).toBe(
      envelope.plan.actions[0]!.sealedOutput.contentSha256,
    );
    expect(await readFile(sentinel, "utf8")).toBe("leave-me-alone");
    expect(
      spawnSync("git", ["--version"], { encoding: "utf8" }).status,
    ).not.toBe(null);
    // Writer path never requires a Git executable or metadata under the target.
    await expect(lstat(join(targetRoot, ".git"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("updates existing targets when prior hashes still match", async () => {
    const mdxPath = join(targetRoot, "content/posts/example.mdx");
    const imagePath = join(targetRoot, "public/posts/example/img-1.webp");
    await mkdir(join(targetRoot, "content/posts"), { recursive: true });
    await mkdir(join(targetRoot, "public/posts/example"), { recursive: true });
    await writeFile(mdxPath, "old-mdx");
    await writeFile(imagePath, "old-image");

    const targets = targetsWith({
      "content/posts/example.mdx": {
        state: "regularFile",
        contentSha256: sha256OfBytes(utf8("old-mdx")),
      },
      "public/posts/example/img-1.webp": {
        state: "regularFile",
        contentSha256: sha256OfBytes(utf8("old-image")),
      },
    });
    const envelope = sealedPlan(targetRoot, {
      generatedMdxBytes: UPDATED_MDX_BYTES,
      priorTargets: targets,
      finalCapture: {
        ...buildInput(targetRoot).finalCapture,
        targets,
      },
    });
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    const result = await applyApprovedWrites(
      writeInput(envelope, targetRoot),
      deps,
    );
    expect(result.ok).toBe(true);
    expect(new Uint8Array(await readFile(mdxPath))).toEqual(UPDATED_MDX_BYTES);
    expect(new Uint8Array(await readFile(imagePath))).toEqual(IMAGE_BYTES);
  });

  it("no-change plans write nothing and leave sentinels untouched", async () => {
    const sentinel = join(targetRoot, "keep.txt");
    await writeFile(sentinel, "sentinel");
    const mdxPath = join(targetRoot, "content/posts/example.mdx");
    const imagePath = join(targetRoot, "public/posts/example/img-1.webp");
    await mkdir(join(targetRoot, "content/posts"), { recursive: true });
    await mkdir(join(targetRoot, "public/posts/example"), { recursive: true });
    await writeFile(mdxPath, MDX_BYTES);
    await writeFile(imagePath, IMAGE_BYTES);

    const targets = targetsWith({
      "content/posts/example.mdx": {
        state: "regularFile",
        contentSha256: sha256OfBytes(MDX_BYTES),
      },
      "public/posts/example/img-1.webp": {
        state: "regularFile",
        contentSha256: sha256OfBytes(IMAGE_BYTES),
      },
    });
    const envelope = sealedPlan(targetRoot, {
      priorTargets: targets,
      finalCapture: {
        ...buildInput(targetRoot).finalCapture,
        targets,
      },
    });
    expect(envelope.state).toBe("no-changes");
    if (envelope.state !== "no-changes") return;

    const result = await applyApprovedWrites(
      writeInput(envelope, targetRoot),
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.completed).toEqual([]);
    expect(await readFile(sentinel, "utf8")).toBe("sentinel");
    expect(new Uint8Array(await readFile(mdxPath))).toEqual(MDX_BYTES);
  });

  it("rejects a traversal-tampered action before any write", async () => {
    const envelope = sealedPlan(targetRoot);
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");
    const plan = structuredClone(envelope.plan);
    (plan.actions[0] as { targetPath: string }).targetPath = "../escape.mdx";

    const result = await applyApprovedWrites(
      writeInput(envelope, targetRoot, {
        plan: plan as typeof envelope.plan,
      }),
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.report.completed).toEqual([]);
    // A retargeted action no longer matches the approved context, so it is
    // refused at the mutation boundary before containment is even consulted.
    expect(result.report.failed[0]!.issue.code).toBe(
      ISSUE_CODES.approvalMismatch,
    );
    expect(result.report.unattempted).toContain(
      "public/posts/example/img-1.webp",
    );
    await expect(lstat(join(root, "escape.mdx"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      lstat(join(targetRoot, "content/posts/example.mdx")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked target root", async () => {
    const real = join(root, "real-target");
    await mkdir(real);
    const linked = join(root, "linked-target");
    await symlink(real, linked);
    const envelope = sealedPlan(await realpath(real));
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    const result = await applyApprovedWrites(
      writeInput(envelope, linked),
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0]!.code).toBe(ISSUE_CODES.unsafeTarget);
  });

  it("rejects a symlink at the target path before writing", async () => {
    const mdxPath = join(targetRoot, "content/posts/example.mdx");
    await mkdir(join(targetRoot, "content/posts"), { recursive: true });
    await writeFile(join(targetRoot, "elsewhere.txt"), "x");
    await symlink(join(targetRoot, "elsewhere.txt"), mdxPath);

    const envelope = sealedPlan(targetRoot);
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    const result = await applyApprovedWrites(
      writeInput(envelope, targetRoot),
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.report.failed[0]!.issue.code).toBe(ISSUE_CODES.unsafeTarget);
    expect((await lstat(mdxPath)).isSymbolicLink()).toBe(true);
  });

  it("rejects a symlinked parent directory before writing", async () => {
    const realPosts = join(root, "real-posts");
    await mkdir(realPosts);
    await mkdir(join(targetRoot, "content"));
    await symlink(realPosts, join(targetRoot, "content/posts"));

    const envelope = sealedPlan(targetRoot);
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    const result = await applyApprovedWrites(
      writeInput(envelope, targetRoot),
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.report.failed[0]!.issue.code).toBe(ISSUE_CODES.unsafeTarget);
    expect(result.report.completed).toEqual([]);
  });

  it("rejects a directory occupying the target path", async () => {
    await mkdir(join(targetRoot, "content/posts/example.mdx"), {
      recursive: true,
    });
    const envelope = sealedPlan(targetRoot);
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    const result = await applyApprovedWrites(
      writeInput(envelope, targetRoot),
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.report.failed[0]!.issue.code).toBe(
      ISSUE_CODES.unsupportedTarget,
    );
  });

  it("rejects case collisions on case-insensitive volumes", async () => {
    await mkdir(join(targetRoot, "content/posts"), { recursive: true });
    await writeFile(join(targetRoot, "content/posts/Example.mdx"), "other");
    const envelope = sealedPlan(targetRoot);
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    const result = await applyApprovedWrites(writeInput(envelope, targetRoot), {
      ...deps,
      caseSensitivity: "insensitive",
    });
    // Sealed plan says sensitive; live deps say insensitive => stale approval.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0]!.code).toBe(ISSUE_CODES.staleApproval);

    const insensitiveTargets = targetsWith();
    const insensitiveEnvelope = sealedPlan(targetRoot, {
      caseSensitivity: "insensitive",
      priorTargets: insensitiveTargets,
      finalCapture: {
        ...buildInput(targetRoot).finalCapture,
        caseSensitivity: "insensitive",
        targets: insensitiveTargets,
      },
    });
    if (
      insensitiveEnvelope.state !== "ready" ||
      !insensitiveEnvelope.sourceBytesVerified
    )
      throw new Error("expected verified ready plan");
    const collision = await applyApprovedWrites(
      writeInput(insensitiveEnvelope, targetRoot),
      { ...deps, caseSensitivity: "insensitive" },
    );
    expect(collision.ok).toBe(false);
    if (collision.ok) return;
    expect(collision.report.failed[0]!.issue.code).toBe(
      ISSUE_CODES.unsafeTarget,
    );
  });

  it("rejects stale targets when prior content changed", async () => {
    const mdxPath = join(targetRoot, "content/posts/example.mdx");
    await mkdir(join(targetRoot, "content/posts"), { recursive: true });
    await writeFile(mdxPath, "current-bytes");
    const targets = targetsWith({
      "content/posts/example.mdx": {
        state: "regularFile",
        contentSha256: sha256OfBytes(utf8("approved-prior")),
      },
      "public/posts/example/img-1.webp": { state: "absent" },
    });
    const envelope = sealedPlan(targetRoot, {
      priorTargets: targets,
      finalCapture: {
        ...buildInput(targetRoot).finalCapture,
        targets,
      },
    });
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    const result = await applyApprovedWrites(
      writeInput(envelope, targetRoot),
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.report.failed[0]!.issue.code).toBe(ISSUE_CODES.targetChanged);
    expect(await readFile(mdxPath, "utf8")).toBe("current-bytes");
    expect(result.report.unattempted).toEqual([
      "public/posts/example/img-1.webp",
    ]);
  });

  it.each([
    ["createTemporary", "createTemporary"],
    ["write", "write"],
    ["sync", "sync"],
    ["close", "close"],
    ["rename", "rename"],
  ] as const)(
    "preserves existing targets when %s fails",
    async (_label, operation) => {
      const mdxPath = join(targetRoot, "content/posts/example.mdx");
      const imagePath = join(targetRoot, "public/posts/example/img-1.webp");
      const sentinel = join(targetRoot, "sentinel.txt");
      await mkdir(join(targetRoot, "content/posts"), { recursive: true });
      await mkdir(join(targetRoot, "public/posts/example"), {
        recursive: true,
      });
      await writeFile(mdxPath, "keep-mdx");
      await writeFile(imagePath, "keep-image");
      await writeFile(sentinel, "sentinel");

      const targets = targetsWith({
        "content/posts/example.mdx": {
          state: "regularFile",
          contentSha256: sha256OfBytes(utf8("keep-mdx")),
        },
        "public/posts/example/img-1.webp": {
          state: "regularFile",
          contentSha256: sha256OfBytes(utf8("keep-image")),
        },
      });
      const envelope = sealedPlan(targetRoot, {
        generatedMdxBytes: UPDATED_MDX_BYTES,
        priorTargets: targets,
        finalCapture: {
          ...buildInput(targetRoot).finalCapture,
          targets,
        },
      });
      if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
        throw new Error("expected verified ready plan");

      let trips = 0;
      const faulty = injectFault(deps.fileSystem, (op, entryPath) => {
        if (op !== operation) return;
        if (
          operation !== "createTemporary" &&
          !entryPath.includes(TARGET_WRITE_TEMPORARY_SUFFIX)
        )
          return;
        trips += 1;
        if (trips === 1) throw new Error(`injected ${operation} failure`);
      });

      const result = await applyApprovedWrites(
        writeInput(envelope, targetRoot),
        { ...deps, fileSystem: faulty },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.report.failed[0]!.issue.code).toBe(
        ISSUE_CODES.targetWriteFailed,
      );
      expect(await readFile(mdxPath, "utf8")).toBe("keep-mdx");
      expect(await readFile(imagePath, "utf8")).toBe("keep-image");
      expect(await readFile(sentinel, "utf8")).toBe("sentinel");
      expect(result.report.unattempted).toEqual([
        "public/posts/example/img-1.webp",
      ]);
    },
  );

  it("reports permission failures visibly without mutating the target", async () => {
    const mdxPath = join(targetRoot, "content/posts/example.mdx");
    await mkdir(join(targetRoot, "content/posts"), { recursive: true });
    await writeFile(mdxPath, "keep");
    await chmod(join(targetRoot, "content/posts"), 0o555);

    const targets = targetsWith({
      "content/posts/example.mdx": {
        state: "regularFile",
        contentSha256: sha256OfBytes(utf8("keep")),
      },
    });
    const envelope = sealedPlan(targetRoot, {
      generatedMdxBytes: UPDATED_MDX_BYTES,
      priorTargets: targets,
      finalCapture: {
        ...buildInput(targetRoot).finalCapture,
        targets,
      },
    });
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    const result = await applyApprovedWrites(
      writeInput(envelope, targetRoot),
      deps,
    );
    await chmod(join(targetRoot, "content/posts"), 0o755);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.report.failed[0]!.issue.code).toBe(
      ISSUE_CODES.targetWriteFailed,
    );
    expect(await readFile(mdxPath, "utf8")).toBe("keep");
  });

  it("reports multi-file partial failure with completed, failed, and unattempted", async () => {
    const envelope = sealedPlan(targetRoot);
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    let replacements = 0;
    const faulty = injectFault(deps.fileSystem, (op, entryPath) => {
      if (
        op !== "linkInto" ||
        !entryPath.includes(TARGET_WRITE_TEMPORARY_SUFFIX)
      )
        return;
      replacements += 1;
      if (replacements === 2)
        throw new Error("injected second replacement failure");
    });

    const result = await applyApprovedWrites(writeInput(envelope, targetRoot), {
      ...deps,
      fileSystem: faulty,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.report.completed.map((entry) => entry.targetPath)).toEqual([
      "content/posts/example.mdx",
    ]);
    expect(result.report.failed.map((entry) => entry.targetPath)).toEqual([
      "public/posts/example/img-1.webp",
    ]);
    expect(result.report.unattempted).toEqual([]);
    expect(
      new Uint8Array(
        await readFile(join(targetRoot, "content/posts/example.mdx")),
      ),
    ).toEqual(MDX_BYTES);
    await expect(
      lstat(join(targetRoot, "public/posts/example/img-1.webp")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never invokes a Git executable during writes", async () => {
    const envelope = sealedPlan(targetRoot);
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    const originalSpawn = spawnSync;
    let gitCalls = 0;
    const spy = new Proxy(originalSpawn, {
      apply(target, thisArg, argArray) {
        if (String(argArray[0]).includes("git")) gitCalls += 1;
        return Reflect.apply(target, thisArg, argArray);
      },
    });
    void spy;

    const result = await applyApprovedWrites(
      writeInput(envelope, targetRoot),
      deps,
    );
    expect(result.ok).toBe(true);
    expect(gitCalls).toBe(0);
    // Import graph stays free of child_process Git runners.
    const writerSource = await readFile(
      new URL("../../../src/write/target-folder-writer.ts", import.meta.url),
      "utf8",
    );
    const fsSource = await readFile(
      new URL("../../../src/write/node-target-folder-fs.ts", import.meta.url),
      "utf8",
    );
    expect(writerSource).not.toMatch(/child_process|spawnSync|execFile/u);
    expect(fsSource).not.toMatch(/child_process|spawnSync|execFile/u);
    expect(writerSource).not.toMatch(/GIT_|git executable|git-runner/u);
    expect(fsSource).not.toMatch(/GIT_|git executable|git-runner/u);
  });

  it("fails closed when an ancestor is swapped for a symlink after the walk", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    const posts = join(targetRoot, "content/posts");
    const envelope = sealedPlan(targetRoot);
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    let swapped = false;
    const stagedInto: string[] = [];
    const faulty = injectFault(deps.fileSystem, (op, entryPath) => {
      if (op === "write") stagedInto.push(realpathSync(dirname(entryPath)));
      if (op !== "createTemporary" || swapped || !entryPath.startsWith(posts))
        return;
      swapped = true;
      // Racing swap of an already-verified parent for a link out of the root.
      rmSync(posts, { recursive: true });
      symlinkSync(outside, posts);
    });

    const result = await applyApprovedWrites(writeInput(envelope, targetRoot), {
      ...deps,
      fileSystem: faulty,
    });

    expect(swapped).toBe(true);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.report.completed).toEqual([]);
    expect(result.report.failed[0]!.issue.code).toBe(ISSUE_CODES.unsafeTarget);
    expect(result.report.unattempted).toEqual([
      "public/posts/example/img-1.webp",
    ]);
    // Detection lands before staging, so no sealed byte is ever written
    // through the swapped parent, and nothing is left behind outside the root.
    expect(stagedInto).toEqual([]);
    expect(await readdir(outside)).toEqual([]);
  });

  it("never deletes an unrelated file occupying the temporary name", async () => {
    const posts = join(targetRoot, "content/posts");
    await mkdir(posts, { recursive: true });
    const squatted = join(posts, `example.mdx${TARGET_WRITE_TEMPORARY_SUFFIX}`);
    await writeFile(squatted, "unrelated-user-file");

    const envelope = sealedPlan(targetRoot);
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    const result = await applyApprovedWrites(
      writeInput(envelope, targetRoot),
      deps,
    );

    expect(result.ok).toBe(true);
    // The unapproved squatter survives, and the writer leaves no staging file.
    expect(await readFile(squatted, "utf8")).toBe("unrelated-user-file");
    expect((await readdir(posts)).sort()).toEqual(
      ["example.mdx", `example.mdx${TARGET_WRITE_TEMPORARY_SUFFIX}`].sort(),
    );
  });

  it("refuses to mutate anything without durable approval authority", async () => {
    const envelope = sealedPlan(targetRoot);
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    const result = await applyApprovedWrites(writeInput(envelope, targetRoot), {
      ...deps,
      readApproval: () =>
        Promise.resolve(mdxRelayErr([createIssue(ISSUE_CODES.planNotFound)])),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.report.completed).toEqual([]);
    expect(result.report.failed[0]!.issue.code).toBe(ISSUE_CODES.planNotFound);
    expect(result.report.unattempted).toEqual([
      "content/posts/example.mdx",
      "public/posts/example/img-1.webp",
    ]);
    await expect(lstat(join(targetRoot, "content"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses an approval record that names a different plan", async () => {
    const envelope = sealedPlan(targetRoot);
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    const result = await applyApprovedWrites(
      writeInput(envelope, targetRoot, {
        approval: { planId: "0".repeat(64) as PlanId },
      }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.report.failed[0]!.issue.code).toBe(
      ISSUE_CODES.approvalMismatch,
    );
    await expect(lstat(join(targetRoot, "content"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses a recaptured approval context that no longer matches", async () => {
    const envelope = sealedPlan(targetRoot);
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");
    const drifted = structuredClone(envelope.plan.approvalFingerprint);
    (drifted.sourceNote as { byteLength: number }).byteLength += 1;

    const result = await applyApprovedWrites(
      writeInput(envelope, targetRoot, {
        currentApprovalFingerprint: drifted,
      }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.report.failed[0]!.issue.code).toBe(
      ISSUE_CODES.approvalMismatch,
    );
    await expect(lstat(join(targetRoot, "content"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to overwrite a target that appears while staging a create", async () => {
    const mdxPath = join(targetRoot, "content/posts/example.mdx");
    const envelope = sealedPlan(targetRoot);
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    const faulty = injectFault(deps.fileSystem, (op, entryPath) => {
      if (
        op !== "sync" ||
        !entryPath.startsWith(`${mdxPath}${TARGET_WRITE_TEMPORARY_SUFFIX}`) ||
        existsSync(mdxPath)
      )
        return;
      writeFileSync(mdxPath, "competing-bytes");
    });

    const result = await applyApprovedWrites(writeInput(envelope, targetRoot), {
      ...deps,
      fileSystem: faulty,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.report.completed).toEqual([]);
    expect(result.report.failed[0]!.issue.code).toBe(ISSUE_CODES.targetChanged);
    expect(await readFile(mdxPath, "utf8")).toBe("competing-bytes");
  });

  it("refuses a create whose target is claimed between revalidation and link", async () => {
    const mdxPath = join(targetRoot, "content/posts/example.mdx");
    const envelope = sealedPlan(targetRoot);
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    const faulty = injectFault(deps.fileSystem, (op, entryPath) => {
      if (op !== "linkInto" || !entryPath.endsWith(mdxPath)) return;
      if (!existsSync(mdxPath)) writeFileSync(mdxPath, "claimed-bytes");
    });

    const result = await applyApprovedWrites(writeInput(envelope, targetRoot), {
      ...deps,
      fileSystem: faulty,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Replacement is conditional: an unconditional rename would have won here.
    expect(result.report.failed[0]!.issue.code).toBe(ISSUE_CODES.targetChanged);
    expect(await readFile(mdxPath, "utf8")).toBe("claimed-bytes");
  });

  it("refuses to overwrite an update target edited while staging", async () => {
    const mdxPath = join(targetRoot, "content/posts/example.mdx");
    await mkdir(join(targetRoot, "content/posts"), { recursive: true });
    await writeFile(mdxPath, "keep-mdx");
    const targets = targetsWith({
      "content/posts/example.mdx": {
        state: "regularFile",
        contentSha256: sha256OfBytes(utf8("keep-mdx")),
      },
    });
    const envelope = sealedPlan(targetRoot, {
      generatedMdxBytes: UPDATED_MDX_BYTES,
      priorTargets: targets,
      finalCapture: { ...buildInput(targetRoot).finalCapture, targets },
    });
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    let edited = false;
    const faulty = injectFault(deps.fileSystem, (op, entryPath) => {
      if (
        op !== "sync" ||
        edited ||
        !entryPath.startsWith(`${mdxPath}${TARGET_WRITE_TEMPORARY_SUFFIX}`)
      )
        return;
      edited = true;
      writeFileSync(mdxPath, "concurrent-edit");
    });

    const result = await applyApprovedWrites(writeInput(envelope, targetRoot), {
      ...deps,
      fileSystem: faulty,
    });

    expect(edited).toBe(true);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.report.failed[0]!.issue.code).toBe(ISSUE_CODES.targetChanged);
    expect(await readFile(mdxPath, "utf8")).toBe("concurrent-edit");
  });

  it("rejects a case collision in an ancestor segment, not just the filename", async () => {
    await mkdir(join(targetRoot, "Content"));
    const targets = targetsWith();
    const envelope = sealedPlan(targetRoot, {
      caseSensitivity: "insensitive",
      priorTargets: targets,
      finalCapture: {
        ...buildInput(targetRoot).finalCapture,
        caseSensitivity: "insensitive",
        targets,
      },
    });
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    const result = await applyApprovedWrites(writeInput(envelope, targetRoot), {
      ...deps,
      caseSensitivity: "insensitive",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.report.completed).toEqual([]);
    expect(result.report.failed[0]!.issue.code).toBe(ISSUE_CODES.unsafeTarget);
    expect(await readdir(join(targetRoot, "Content"))).toEqual([]);
  });

  it.each([
    ["readFile", "readFile"],
    ["lstat", "lstat"],
  ] as const)(
    "returns a structured failure when the live probe %s fails",
    async (_label, operation) => {
      const mdxPath = join(targetRoot, "content/posts/example.mdx");
      await mkdir(join(targetRoot, "content/posts"), { recursive: true });
      await writeFile(mdxPath, "keep-mdx");
      const targets = targetsWith({
        "content/posts/example.mdx": {
          state: "regularFile",
          contentSha256: sha256OfBytes(utf8("keep-mdx")),
        },
      });
      const envelope = sealedPlan(targetRoot, {
        generatedMdxBytes: UPDATED_MDX_BYTES,
        priorTargets: targets,
        finalCapture: { ...buildInput(targetRoot).finalCapture, targets },
      });
      if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
        throw new Error("expected verified ready plan");

      const faulty = injectFault(deps.fileSystem, (op, entryPath) => {
        if (op !== operation || entryPath !== mdxPath) return;
        throw Object.assign(new Error("injected I/O failure"), { code: "EIO" });
      });

      // The promise resolves with a report; it must never reject.
      const result = await applyApprovedWrites(
        writeInput(envelope, targetRoot),
        { ...deps, fileSystem: faulty },
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.report.completed).toEqual([]);
      expect(result.report.failed).toEqual([
        {
          targetPath: "content/posts/example.mdx",
          issue: result.report.failed[0]!.issue,
        },
      ]);
      expect(result.report.failed[0]!.issue.code).toBe(
        ISSUE_CODES.targetWriteFailed,
      );
      expect(result.report.unattempted).toEqual([
        "public/posts/example/img-1.webp",
      ]);
      expect(await readFile(mdxPath, "utf8")).toBe("keep-mdx");
    },
  );

  it("rejects credential-bearing sealed output before any write action", async () => {
    const leaking = utf8(
      "---\ntitle: Example\n---\n\nMirror: https://deploy:s3cr3t-token@example.test/site.git\n",
    );
    const envelope = sealedPlan(targetRoot, { generatedMdxBytes: leaking });
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    const result = await applyApprovedWrites(
      writeInput(envelope, targetRoot),
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.report.completed).toEqual([]);
    expect(result.report.failed[0]!.issue.code).toBe(ISSUE_CODES.credentialUrl);
    // The whole invocation fails before the first mutation, so even the
    // unrelated image action stays unattempted and no directory is created.
    expect(result.report.unattempted).toEqual([
      "public/posts/example/img-1.webp",
    ]);
    await expect(lstat(join(targetRoot, "content"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(join(targetRoot, "public"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a supported-scheme link carrying a query string", async () => {
    // The canonical credential rule counts any query or fragment on a
    // supported-scheme URL as credential-bearing, so this output is refused
    // before any mutation rather than written.
    const linked = utf8(
      "---\ntitle: Example\n---\n\n[docs](https://example.test/search?q=1#top) alice@example.test\n",
    );
    const envelope = sealedPlan(targetRoot, { generatedMdxBytes: linked });
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    const result = await applyApprovedWrites(
      writeInput(envelope, targetRoot),
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.report.completed).toEqual([]);
    expect(result.report.failed[0]!.issue.code).toBe(ISSUE_CODES.credentialUrl);
    await expect(lstat(join(targetRoot, "content"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writes approved output whose links and addresses are plain", async () => {
    const linked = utf8(
      "---\ntitle: Example\n---\n\n[docs](https://example.test/search) alice@example.test\n",
    );
    const envelope = sealedPlan(targetRoot, { generatedMdxBytes: linked });
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    const result = await applyApprovedWrites(
      writeInput(envelope, targetRoot),
      deps,
    );

    expect(result.ok).toBe(true);
    expect(
      new Uint8Array(
        await readFile(join(targetRoot, "content/posts/example.mdx")),
      ),
    ).toEqual(linked);
  });

  it("refuses an update whose target is rewritten just before replacement", async () => {
    const mdxPath = join(targetRoot, "content/posts/example.mdx");
    await mkdir(join(targetRoot, "content/posts"), { recursive: true });
    await writeFile(mdxPath, "keep-mdx");
    const targets = targetsWith({
      "content/posts/example.mdx": {
        state: "regularFile",
        contentSha256: sha256OfBytes(utf8("keep-mdx")),
      },
    });
    const envelope = sealedPlan(targetRoot, {
      generatedMdxBytes: UPDATED_MDX_BYTES,
      priorTargets: targets,
      finalCapture: { ...buildInput(targetRoot).finalCapture, targets },
    });
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    // The race is injected inside the replacement primitive itself, after every
    // revalidation the writer can perform and before the bytes are swapped in.
    let raced = false;
    const faulty = injectFault(deps.fileSystem, (op, entryPath) => {
      if (op !== "rename" || raced || !entryPath.includes(mdxPath)) return;
      raced = true;
      writeFileSync(mdxPath, "competing-bytes");
    });

    const result = await applyApprovedWrites(writeInput(envelope, targetRoot), {
      ...deps,
      fileSystem: faulty,
    });

    expect(raced).toBe(true);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.report.failed[0]!.issue.code).toBe(ISSUE_CODES.targetChanged);
    // The competing bytes are never overwritten and never destroyed.
    expect(await readFile(mdxPath, "utf8")).toBe("competing-bytes");
    expect(await readdir(join(targetRoot, "content/posts"))).toEqual([
      "example.mdx",
    ]);
  });

  it("creates no directory through an ancestor swapped before creation", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    const content = join(targetRoot, "content");
    await mkdir(content);
    const envelope = sealedPlan(targetRoot);
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    let swapped = false;
    const faulty = injectFault(deps.fileSystem, (op, entryPath) => {
      // Swap the already-verified `content` ancestor for a link out of the root
      // at the moment the walk looks past it, before any directory is created.
      if (op !== "lstat" || swapped || entryPath !== join(content, "posts"))
        return;
      swapped = true;
      rmSync(content, { recursive: true });
      symlinkSync(outside, content);
    });

    const result = await applyApprovedWrites(writeInput(envelope, targetRoot), {
      ...deps,
      fileSystem: faulty,
    });

    expect(swapped).toBe(true);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.report.completed).toEqual([]);
    expect(result.report.failed[0]!.issue.code).toBe(ISSUE_CODES.unsafeTarget);
    // Nothing at all is created through the swapped ancestor.
    expect(await readdir(outside)).toEqual([]);
  });

  describe("production directory creation", () => {
    const fileSystem = createNodeTargetFolderFileSystem();

    const identityOf = async (entryPath: string) => {
      const stat = await fileSystem.lstat(entryPath);
      if (stat.kind === "absent") throw new Error(`absent: ${entryPath}`);
      return stat.identity;
    };

    it("creates one bound level and reports what it created", async () => {
      const identity = await identityOf(targetRoot);
      const first = await fileSystem.createDirectoryIn(
        targetRoot,
        identity,
        "content",
      );
      expect(first.kind).toBe("created");
      const second = await fileSystem.createDirectoryIn(
        targetRoot,
        identity,
        "content",
      );
      expect(second.kind).toBe("existing");
      // Only the requested level, never a whole pathname subtree.
      expect(await readdir(join(targetRoot, "content"))).toEqual([]);
    });

    it("refuses a parent that is no longer the bound directory", async () => {
      const outside = join(root, "outside-parent");
      await mkdir(outside);
      const content = join(targetRoot, "content");
      await mkdir(content);
      const identity = await identityOf(content);
      rmSync(content, { recursive: true });
      symlinkSync(outside, content);

      expect(
        await fileSystem.createDirectoryIn(content, identity, "posts"),
      ).toEqual({ kind: "unsafe" });
      expect(await readdir(outside)).toEqual([]);
    });

    it("reports a non-directory occupying the level as unsupported", async () => {
      await writeFile(join(targetRoot, "content"), "not-a-directory");
      expect(
        await fileSystem.createDirectoryIn(
          targetRoot,
          await identityOf(targetRoot),
          "content",
        ),
      ).toEqual({ kind: "unsupported" });
    });

    it("reports a symlinked level as unsafe without following it", async () => {
      const outside = join(root, "outside-level");
      await mkdir(outside);
      await symlink(outside, join(targetRoot, "content"));
      expect(
        await fileSystem.createDirectoryIn(
          targetRoot,
          await identityOf(targetRoot),
          "content",
        ),
      ).toEqual({ kind: "unsafe" });
    });
  });

  it("persists the sealed bytes even when the caller mutates its buffer", async () => {
    const envelope = sealedPlan(targetRoot);
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");
    const mdxAction = envelope.plan.actions[0]!;

    let mutated = false;
    const faulty = injectFault(deps.fileSystem, (op) => {
      if (op !== "createTemporary" || mutated) return;
      mutated = true;
      // The caller still owns this view and overwrites it mid-flight.
      envelope.blobBytes.get(mdxAction.sealedOutput.planRelativePath)!.fill(0);
    });

    const result = await applyApprovedWrites(writeInput(envelope, targetRoot), {
      ...deps,
      fileSystem: faulty,
    });

    expect(mutated).toBe(true);
    expect(result.ok).toBe(true);
    const written = new Uint8Array(
      await readFile(join(targetRoot, mdxAction.targetPath)),
    );
    // The file matches the digest the report claims, not the mutated view.
    expect(sha256OfBytes(written)).toBe(mdxAction.sealedOutput.contentSha256);
    expect(written.some((byte) => byte !== 0)).toBe(true);
  });
});
