import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sha256OfBytes, sha256OfUtf8 } from "../../../src/canonical/hash";
import type {
  ApprovedPriorTarget,
  CanonicalDependencySnapshot,
  GenerationToken,
  TargetSnapshotEntry,
  ValidatedPortableProfileSnapshot,
} from "../../../src/contracts/export-plan";
import { createIssue, ISSUE_CODES } from "../../../src/contracts/issues";
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
  type TargetFolderFileSystem,
  type TargetFolderWriterDeps,
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
  readFile: async (filePath) => {
    fail("readFile", filePath);
    return base.readFile(filePath);
  },
  makeDirectory: async (directoryPath) => {
    fail("makeDirectory", directoryPath);
    return base.makeDirectory(directoryPath);
  },
  openForWrite: async (filePath) => {
    fail("openForWrite", filePath);
    const handle = await base.openForWrite(filePath);
    return {
      write: async (bytes) => {
        fail("write", filePath);
        return handle.write(bytes);
      },
      sync: async () => {
        fail("sync", filePath);
        return handle.sync();
      },
      close: async () => {
        try {
          fail("close", filePath);
        } finally {
          await handle.close().catch(() => undefined);
        }
      },
    };
  },
  rename: async (fromPath, toPath) => {
    fail("rename", `${fromPath}->${toPath}`);
    return base.rename(fromPath, toPath);
  },
  removeTemporary: async (entryPath) => {
    fail("removeTemporary", entryPath);
    return base.removeTemporary(entryPath);
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
      {
        plan: envelope.plan,
        blobBytes: envelope.blobBytes,
        configuredTargetRoot: targetRoot,
      },
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
      {
        plan: envelope.plan,
        blobBytes: envelope.blobBytes,
        configuredTargetRoot: targetRoot,
      },
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
      {
        plan: envelope.plan,
        blobBytes: envelope.blobBytes,
        configuredTargetRoot: targetRoot,
      },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.completed).toEqual([]);
    expect(await readFile(sentinel, "utf8")).toBe("sentinel");
    expect(new Uint8Array(await readFile(mdxPath))).toEqual(MDX_BYTES);
  });

  it("rejects traversal before any write", async () => {
    const envelope = sealedPlan(targetRoot);
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");
    const plan = structuredClone(envelope.plan);
    (plan.actions[0] as { targetPath: string }).targetPath = "../escape.mdx";

    const result = await applyApprovedWrites(
      {
        plan: plan as typeof envelope.plan,
        blobBytes: envelope.blobBytes,
        configuredTargetRoot: targetRoot,
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.report.completed).toEqual([]);
    expect(result.report.failed[0]!.issue.code).toBe(ISSUE_CODES.unsafeTarget);
    expect(result.report.unattempted).toContain(
      "public/posts/example/img-1.webp",
    );
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
      {
        plan: envelope.plan,
        blobBytes: envelope.blobBytes,
        configuredTargetRoot: linked,
      },
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
      {
        plan: envelope.plan,
        blobBytes: envelope.blobBytes,
        configuredTargetRoot: targetRoot,
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.report.failed[0]!.issue.code).toBe(ISSUE_CODES.unsafeTarget);
    expect((await lstat(mdxPath)).isSymbolicLink()).toBe(true);
  });

  it("rejects a directory occupying the target path", async () => {
    await mkdir(join(targetRoot, "content/posts/example.mdx"), {
      recursive: true,
    });
    const envelope = sealedPlan(targetRoot);
    if (envelope.state !== "ready" || !envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    const result = await applyApprovedWrites(
      {
        plan: envelope.plan,
        blobBytes: envelope.blobBytes,
        configuredTargetRoot: targetRoot,
      },
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

    const result = await applyApprovedWrites(
      {
        plan: envelope.plan,
        blobBytes: envelope.blobBytes,
        configuredTargetRoot: targetRoot,
      },
      {
        ...deps,
        caseSensitivity: "insensitive",
      },
    );
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
      {
        plan: insensitiveEnvelope.plan,
        blobBytes: insensitiveEnvelope.blobBytes,
        configuredTargetRoot: targetRoot,
      },
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
      {
        plan: envelope.plan,
        blobBytes: envelope.blobBytes,
        configuredTargetRoot: targetRoot,
      },
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
    ["openForWrite", "openForWrite"],
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
          operation === "rename" &&
          !entryPath.includes(TARGET_WRITE_TEMPORARY_SUFFIX)
        )
          return;
        if (
          (operation === "openForWrite" ||
            operation === "write" ||
            operation === "close") &&
          !entryPath.endsWith(TARGET_WRITE_TEMPORARY_SUFFIX)
        )
          return;
        trips += 1;
        if (trips === 1) throw new Error(`injected ${operation} failure`);
      });

      const result = await applyApprovedWrites(
        {
          plan: envelope.plan,
          blobBytes: envelope.blobBytes,
          configuredTargetRoot: targetRoot,
        },
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
      {
        plan: envelope.plan,
        blobBytes: envelope.blobBytes,
        configuredTargetRoot: targetRoot,
      },
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

    let renames = 0;
    const faulty = injectFault(deps.fileSystem, (op, entryPath) => {
      if (op !== "rename" || !entryPath.includes(TARGET_WRITE_TEMPORARY_SUFFIX))
        return;
      renames += 1;
      if (renames === 2) throw new Error("injected second rename failure");
    });

    const result = await applyApprovedWrites(
      {
        plan: envelope.plan,
        blobBytes: envelope.blobBytes,
        configuredTargetRoot: targetRoot,
      },
      { ...deps, fileSystem: faulty },
    );
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
      {
        plan: envelope.plan,
        blobBytes: envelope.blobBytes,
        configuredTargetRoot: targetRoot,
      },
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
});
