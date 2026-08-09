import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256OfBytes } from "../../../src/canonical/hash";
import {
  loadActivePlan,
  publishSealedPlan,
  readPlanApproval,
  recordPlanApproval,
  createPlanStoreDeps,
} from "../../../src/planning/plan-store";
import { buildVerifiedPreviewDocument } from "../../../src/obsidian/preview-command";
import {
  applyApprovedWrites,
  createNodeTargetFolderFileSystem,
  TARGET_WRITE_TEMPORARY_SUFFIX,
} from "../../../src/write";
import { imageFixture } from "../../helpers/codec-wasm";
import {
  buildWorkerBackedEnvelope,
  recaptureApprovalFingerprint,
} from "../../helpers/export-plan";

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const NOW = "2026-08-08T01:00:00.000Z";
const roots: string[] = [];

const makeRoot = async (name: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), `mdx-relay-${name}-`));
  roots.push(root);
  return realpath(root);
};

const filesBelow = async (root: string): Promise<string[]> => {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(relative(root, path).split("\\").join("/"));
    }
  };
  await visit(root);
  return files.sort();
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("complete local export pipeline", () => {
  it("crosses worker, store, preview, approval, and exact-write boundaries", async () => {
    const targetRoot = await makeRoot("target");
    const storeRoot = await makeRoot("store");
    await mkdir(join(targetRoot, "unrelated"), { recursive: true });
    await writeFile(join(targetRoot, "sentinel.txt"), "keep-root");
    await writeFile(join(targetRoot, "unrelated", "keep.txt"), "keep-nested");
    const sourceNote = await readFile(
      new URL("../../fixtures/public-baseline/source-note.md", import.meta.url),
      "utf8",
    );
    const noteBytes = utf8(
      sourceNote.replace("sample-image.PNG", "gradient.png"),
    );
    const imageBytes = new Uint8Array(await imageFixture("gradient.png"));
    const built = await buildWorkerBackedEnvelope({
      targetRoot,
      noteBytes,
      imageBytes,
    });
    expect(built.workerEvents.map((event) => event.type)).toEqual([
      "started",
      "progress",
      "completed",
    ]);
    expect(built.envelope.state).toBe("ready");
    if (built.envelope.state !== "ready" || !built.envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");

    const storeDeps = {
      ...createPlanStoreDeps(storeRoot),
      now: () => NOW,
    };
    const published = await publishSealedPlan(storeDeps, built.envelope);
    expect(published).toMatchObject({
      ok: true,
      value: built.envelope.planId,
    });
    const loaded = await loadActivePlan(storeDeps, built.sourceBytes);
    expect(loaded.ok && loaded.value.planId).toBe(built.envelope.planId);

    const preview = buildVerifiedPreviewDocument(
      {
        envelope: built.envelope,
        generatedMdxBytes: built.generatedMdxBytes,
      },
      {
        generationToken: built.envelope.plan.generationToken,
        note: built.envelope.plan.sourceNote,
        bytes: noteBytes,
      },
    );
    expect(preview?.plan.planId).toBe(built.envelope.planId);
    expect(preview?.assets).toHaveLength(1);

    const approved = await recordPlanApproval(
      storeDeps,
      built.envelope.planId,
      built.sourceBytes,
    );
    expect(approved.ok).toBe(true);
    const recorded = await readPlanApproval(storeDeps, built.envelope.planId);
    expect(recorded.ok && recorded.value).toBe(built.envelope.planId);

    const exactFingerprint = await recaptureApprovalFingerprint(
      built,
      targetRoot,
    );
    const changedNote = utf8(
      `${new TextDecoder().decode(noteBytes)}\nchanged after preview`,
    );
    const staleFingerprint = await recaptureApprovalFingerprint(
      built,
      targetRoot,
      {
        note: changedNote,
        images: new Map(built.sourceBytes.images),
      },
    );
    expect(staleFingerprint.sourceNote).not.toEqual(
      exactFingerprint.sourceNote,
    );
    const writerDeps = {
      fileSystem: createNodeTargetFolderFileSystem(),
      hash: sha256OfBytes,
      caseSensitivity: "sensitive" as const,
      readApproval: (planId: typeof built.envelope.planId) =>
        readPlanApproval(storeDeps, planId),
      now: () => NOW,
    };
    const transition = {
      generationToken: built.envelope.plan.generationToken,
      planId: built.envelope.planId,
    };
    const staleWrite = await applyApprovedWrites(
      {
        plan: built.envelope.plan,
        blobBytes: built.envelope.blobBytes,
        configuredTargetRoot: targetRoot,
        approval: { planId: built.envelope.planId },
        approvalTransition: transition,
        currentApprovalFingerprint: staleFingerprint,
      },
      writerDeps,
    );
    expect(staleWrite.ok).toBe(false);
    expect(await filesBelow(targetRoot)).toEqual([
      "sentinel.txt",
      "unrelated/keep.txt",
    ]);

    const result = await applyApprovedWrites(
      {
        plan: built.envelope.plan,
        blobBytes: built.envelope.blobBytes,
        configuredTargetRoot: targetRoot,
        approval: { planId: built.envelope.planId },
        approvalTransition: transition,
        currentApprovalFingerprint: exactFingerprint,
      },
      writerDeps,
    );
    expect(result.ok).toBe(true);
    const approvedPaths = built.envelope.plan.actions
      .map((action) => action.targetPath)
      .sort();
    expect(await filesBelow(targetRoot)).toEqual(
      ["sentinel.txt", "unrelated/keep.txt", ...approvedPaths].sort(),
    );
    expect(
      (await filesBelow(targetRoot)).some((path) =>
        path.includes(TARGET_WRITE_TEMPORARY_SUFFIX),
      ),
    ).toBe(false);
    expect(await readFile(join(targetRoot, "sentinel.txt"), "utf8")).toBe(
      "keep-root",
    );
    for (const action of built.envelope.plan.actions) {
      const bytes = new Uint8Array(
        await readFile(join(targetRoot, action.targetPath)),
      );
      expect(sha256OfBytes(bytes)).toBe(action.sealedOutput.contentSha256);
    }
  }, 15_000);
});
