import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256OfBytes } from "../../../src/canonical/hash";
import { buildVerifiedPreviewDocument } from "../../../src/obsidian/preview-command";
import {
  createPlanStoreDeps,
  publishSealedPlan,
  readPlanApproval,
  recordPlanApproval,
} from "../../../src/planning/plan-store";
import { DPW_MIND_NET_V1 } from "../../../src/profiles/builtins/dpw-mind-net-v1";
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

const NOW = "2026-08-08T01:00:00.000Z";
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const roots: string[] = [];

const temporaryRoot = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return realpath(root);
};

const artifactFiles = async (
  root: string,
  prefix: string,
): Promise<Map<string, Uint8Array>> => {
  const artifacts = new Map<string, Uint8Array>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else
        artifacts.set(
          `${prefix}/${relative(root, path).split("\\").join("/")}`,
          new Uint8Array(await readFile(path)),
        );
    }
  };
  await visit(root);
  return artifacts;
};

const encodedForms = (value: string): readonly string[] =>
  [
    value,
    encodeURIComponent(value),
    Buffer.from(value).toString("base64"),
    Buffer.from(value).toString("hex"),
  ].filter((entry, index, all) => all.indexOf(entry) === index);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("full-pipeline secret canaries", () => {
  it("keeps canaries out of every artifact except required identity and approved output", async () => {
    const canaries = {
      profile: "T7-PROFILE-A91",
      note: "T7-NOTE-B82",
      imageMetadata: "T7-IMAGE-C73",
      targetIdentity: "T7-TARGET-D64",
    } as const;
    const targetRoot = await temporaryRoot(
      `mdx-relay-${canaries.targetIdentity}-`,
    );
    const storeRoot = await temporaryRoot("mdx-relay-canary-store-");
    await writeFile(join(targetRoot, "sentinel.txt"), "unrelated");
    const source = await readFile(
      new URL("../../fixtures/public-baseline/source-note.md", import.meta.url),
      "utf8",
    );
    const embedSource = `${canaries.imageMetadata}.png`;
    const noteBytes = utf8(
      source
        .replace("Opening bytes stay exactly here.", canaries.note)
        .replace("sample-image.PNG", embedSource),
    );
    const imageBytes = new Uint8Array(await imageFixture("gradient.png"));
    const profile = {
      ...DPW_MIND_NET_V1,
      name: canaries.profile,
    };
    const built = await buildWorkerBackedEnvelope({
      targetRoot,
      noteBytes,
      imageBytes,
      profile,
      imageVaultPath: `assets/${embedSource}`,
      imageEmbedSource: embedSource,
    });
    if (built.envelope.state !== "ready" || !built.envelope.sourceBytesVerified)
      throw new Error("expected verified ready plan");
    const storeDeps = {
      ...createPlanStoreDeps(storeRoot),
      now: () => NOW,
    };
    expect((await publishSealedPlan(storeDeps, built.envelope)).ok).toBe(true);
    expect(
      (
        await recordPlanApproval(
          storeDeps,
          built.envelope.planId,
          built.sourceBytes,
        )
      ).ok,
    ).toBe(true);
    const fingerprint = await recaptureApprovalFingerprint(built, targetRoot);
    const staleFingerprint = await recaptureApprovalFingerprint(
      built,
      targetRoot,
      {
        note: utf8(`${new TextDecoder().decode(noteBytes)}\nstale`),
        images: new Map(built.sourceBytes.images),
      },
    );
    const writerDeps = {
      fileSystem: createNodeTargetFolderFileSystem(),
      hash: sha256OfBytes,
      caseSensitivity: "sensitive" as const,
      readApproval: (planId: typeof built.envelope.planId) =>
        readPlanApproval(storeDeps, planId),
      now: () => NOW,
    };
    const writeInput = {
      plan: built.envelope.plan,
      blobBytes: built.envelope.blobBytes,
      configuredTargetRoot: targetRoot,
      approval: { planId: built.envelope.planId },
      approvalTransition: {
        generationToken: built.envelope.plan.generationToken,
        planId: built.envelope.planId,
      },
    } as const;
    const staleResult = await applyApprovedWrites(
      {
        ...writeInput,
        currentApprovalFingerprint: staleFingerprint,
      },
      writerDeps,
    );
    expect(staleResult.ok).toBe(false);
    const result = await applyApprovedWrites(
      {
        ...writeInput,
        currentApprovalFingerprint: fingerprint,
      },
      writerDeps,
    );
    expect(result.ok).toBe(true);
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
    expect(preview).toBeDefined();

    const artifacts = new Map([
      ...(await artifactFiles(storeRoot, "store")),
      ...(await artifactFiles(targetRoot, "target")),
      [
        "memory/worker-events.json",
        utf8(JSON.stringify(built.workerEvents)),
      ] as const,
      ["memory/preview-document.json", utf8(JSON.stringify(preview))] as const,
      ["memory/write-report.json", utf8(JSON.stringify(result))] as const,
      ["memory/stale-error.json", utf8(JSON.stringify(staleResult))] as const,
    ]);
    const stagingEntries = (await readdir(join(storeRoot, "plans"))).filter(
      (name) => name.startsWith(".staging-"),
    );
    expect(stagingEntries).toEqual([]);
    expect(
      [...artifacts.keys()].filter((name) =>
        name.includes(TARGET_WRITE_TEMPORARY_SUFFIX),
      ),
    ).toEqual([]);

    const hits = new Map<string, string[]>();
    for (const [kind, canary] of Object.entries(canaries)) {
      const locations: string[] = [];
      for (const [name, bytes] of artifacts) {
        const text = new TextDecoder("latin1").decode(bytes);
        if (encodedForms(canary).some((form) => text.includes(form)))
          locations.push(name);
      }
      hits.set(kind, locations.sort());
    }

    const planDocument = `store/plans/${built.envelope.planId}/plan.json`;
    const previewDocument = "memory/preview-document.json";
    // Profile, source-path, and target-root values are deliberate plan identity,
    // not private source content. Their only permitted copies are plan.json and
    // the exact preview object that embeds that authenticated plan.
    expect(hits.get("profile")).toEqual([previewDocument, planDocument].sort());
    expect(hits.get("imageMetadata")).toEqual(
      [previewDocument, planDocument].sort(),
    );
    expect(hits.get("targetIdentity")).toEqual(
      [previewDocument, planDocument].sort(),
    );

    const mdxAction = built.envelope.plan.actions.find(
      (action) => action.documentOrder === 0,
    )!;
    const mdxBlob = `store/plans/${built.envelope.planId}/blobs/${mdxAction.sealedOutput.planRelativePath}`;
    // The note canary is intentionally ordinary approved prose. It may exist
    // only in the sealed MDX blob, its exact written target, and the MDX diff
    // shown for approval; those are the approved-output exception in ADR 0003.
    expect(hits.get("note")).toEqual(
      [mdxBlob, `target/${mdxAction.targetPath}`, previewDocument].sort(),
    );

    for (const [name, bytes] of artifacts) {
      if (
        name === planDocument ||
        name === previewDocument ||
        name === mdxBlob ||
        name === `target/${mdxAction.targetPath}`
      )
        continue;
      const text = new TextDecoder("latin1").decode(bytes);
      for (const canary of Object.values(canaries))
        for (const form of encodedForms(canary))
          expect(text, `${basename(name)} leaked ${form}`).not.toContain(form);
    }
  }, 15_000);
});
