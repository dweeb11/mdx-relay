import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ApprovedPriorTarget,
  CanonicalDependencySnapshot,
  GenerationToken,
  PlanId,
  RepositoryFingerprint,
  RepositoryTargetFingerprint,
  Sha256Digest,
  ValidatedPortableProfileSnapshot,
} from "../../../src/contracts/export-plan";
import { createIssue, ISSUE_CODES } from "../../../src/contracts/issues";
import { MDX_RELAY_LIMITS } from "../../../src/core/limits";
import {
  buildExportPlan,
  sha256OfBytes,
  sha256OfUtf8,
  type ExportPlanBuildInput,
  type PlanSourceBytes,
} from "../../../src/planning/build-export-plan";
import {
  cleanupExpiredPlans,
  createNodePlanStoreFileSystem,
  defaultPlanStoreRoot,
  loadActivePlan,
  loadSealedPlan,
  publishSealedPlan,
  readPlanApproval,
  recordPlanApproval,
} from "../../../src/planning/plan-store";
import {
  MAX_PLAN_DOCUMENT_BYTES,
  MAX_PLAN_POINTER_BYTES,
  OWNER_ONLY_DIRECTORY_MODE,
  OWNER_ONLY_FILE_MODE,
  type PlanStoreDeps,
  type PlanStoreFileSystem,
} from "../../../src/planning/plan-store-types";
import {
  canonicalizeJcs,
  sealExportPlan,
  type SealedExportPlanEnvelope,
} from "../../../src/planning/seal-export-plan";
import { DPW_MIND_NET_V1 } from "../../../src/profiles/builtins/dpw-mind-net-v1";

const utf8 = (value: string) => new TextEncoder().encode(value);
const digest = (value: string) => sha256OfBytes(utf8(value));

const PROFILE_SNAPSHOT = JSON.stringify(DPW_MIND_NET_V1);
const DEPENDENCY_SNAPSHOT = '{"images":["assets/a.png"]}';
const MDX_BYTES = utf8("---\ntitle: Example\n---\n\nBody\n");
const IMAGE_BYTES = utf8("webp-bytes");
const CREATED_AT = "2026-07-20T00:00:00.000Z";
const EXPIRES_AT = "2026-07-27T00:00:00.000Z";
const NOW = "2026-07-20T01:00:00.000Z";

/** Every source fingerprint below is derived from the bytes, never asserted. */
const NOTE_BYTES = utf8("# Example\n\nBody with a private sentence.\n");
const SOURCE_A_BYTES = utf8("png-source-a");

const sourceBytes = (): PlanSourceBytes => ({
  note: NOTE_BYTES,
  images: new Map([["image-a", SOURCE_A_BYTES]]),
});

/** Comfortably longer than one whole publication against a temporary root. */
const CONCURRENT_PUBLISH_BUDGET_MS = 1_000;

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
  const repository = repositoryState();
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
    createdAtUtc: CREATED_AT,
    expiresAtUtc: EXPIRES_AT,
    ...overrides,
  };
};

const sealedPlan = (
  overrides: Partial<ExportPlanBuildInput> = {},
): SealedExportPlanEnvelope => {
  const draft = buildExportPlan(buildInput(overrides));
  if (!draft.ok) throw new Error(`draft: ${draft.error[0].code}`);
  const sealed = sealExportPlan(draft.value);
  if (!sealed.ok) throw new Error(`seal: ${sealed.error[0].code}`);
  return sealed.value;
};

const unchangedPlan = (): SealedExportPlanEnvelope => {
  const targets = targetsWith({
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
  return sealedPlan({
    priorTargets: targets,
    finalCapture: { ...buildInput().finalCapture, targets },
  });
};

/** Wraps the real filesystem so one operation fails exactly where it would. */
const injectFault = (
  base: PlanStoreFileSystem,
  fail: (operation: string, entryPath: string) => void,
): PlanStoreFileSystem => ({
  makeDirectory: async (directoryPath, mode) => {
    fail("makeDirectory", directoryPath);
    return base.makeDirectory(directoryPath, mode);
  },
  openForWrite: async (filePath, mode) => {
    fail("openForWrite", filePath);
    const handle = await base.openForWrite(filePath, mode);
    return {
      write: async (bytes) => {
        fail("write", filePath);
        return handle.write(bytes);
      },
      sync: async () => {
        fail("sync", filePath);
        return handle.sync();
      },
      close: () => handle.close(),
    };
  },
  syncDirectory: async (directoryPath) => {
    fail("syncDirectory", directoryPath);
    return base.syncDirectory(directoryPath);
  },
  rename: async (fromPath, toPath) => {
    fail("rename", fromPath);
    return base.rename(fromPath, toPath);
  },
  readFile: async (filePath) => {
    fail("readFile", filePath);
    return base.readFile(filePath);
  },
  readPermissionBits: (entryPath) => base.readPermissionBits(entryPath),
  byteLength: (entryPath) => base.byteLength(entryPath),
  listDirectory: (directoryPath) => base.listDirectory(directoryPath),
  removeRecursively: (entryPath) => base.removeRecursively(entryPath),
});

let root: string;
let deps: PlanStoreDeps;

const withDeps = (overrides: Partial<PlanStoreDeps>): PlanStoreDeps => ({
  ...deps,
  ...overrides,
});

const blobDirectoryOf = (planId: PlanId) =>
  join(root, "plans", planId, "blobs");
const planDocumentOf = (planId: PlanId) =>
  join(root, "plans", planId, "plan.json");

const modeOf = async (entryPath: string) =>
  (await lstat(entryPath)).mode & 0o777;

const failureCode = async (
  result: Promise<{ readonly ok: boolean; readonly error?: unknown }>,
): Promise<string | undefined> => {
  const settled = (await result) as
    | { ok: true }
    | { ok: false; error: readonly { code: string }[] };
  return settled.ok ? undefined : settled.error[0]!.code;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mdx-relay-plan-store-"));
  deps = {
    rootDirectory: root,
    fileSystem: createNodePlanStoreFileSystem(),
    hash: sha256OfBytes,
    now: () => NOW,
    enforceOwnerOnlyModes: true,
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("private plan storage", () => {
  it("publishes atomically with owner-only modes and content-addressed blobs", async () => {
    const envelope = sealedPlan();
    const published = await publishSealedPlan(deps, envelope);
    expect(published.ok).toBe(true);

    expect(await modeOf(root)).toBe(OWNER_ONLY_DIRECTORY_MODE);
    expect(await modeOf(join(root, "plans"))).toBe(OWNER_ONLY_DIRECTORY_MODE);
    expect(await modeOf(join(root, "approvals"))).toBe(
      OWNER_ONLY_DIRECTORY_MODE,
    );
    expect(await modeOf(join(root, "plans", envelope.planId))).toBe(
      OWNER_ONLY_DIRECTORY_MODE,
    );
    expect(await modeOf(blobDirectoryOf(envelope.planId))).toBe(
      OWNER_ONLY_DIRECTORY_MODE,
    );
    expect(await modeOf(planDocumentOf(envelope.planId))).toBe(
      OWNER_ONLY_FILE_MODE,
    );
    expect(await modeOf(join(root, "active-plan.json"))).toBe(
      OWNER_ONLY_FILE_MODE,
    );

    const blobs = await readdir(blobDirectoryOf(envelope.planId));
    expect(blobs.sort()).toEqual([...envelope.blobBytes.keys()].sort());
    for (const name of blobs) {
      const path = join(blobDirectoryOf(envelope.planId), name);
      expect(await modeOf(path)).toBe(OWNER_ONLY_FILE_MODE);
      expect(sha256OfBytes(new Uint8Array(await readFile(path)))).toBe(
        `sha256:${name}`,
      );
    }
    // No staging directory survives a successful publication.
    expect(
      (await readdir(join(root, "plans"))).filter((name) =>
        name.startsWith(".staging-"),
      ),
    ).toEqual([]);

    const loaded = await loadSealedPlan(deps, envelope.planId);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.planId).toBe(envelope.planId);
      expect(loaded.value.state).toBe("ready");
      expect(loaded.value.identityManifest).toBe(envelope.identityManifest);
      expect(loaded.value.plan.actions).toHaveLength(2);
    }
  });

  it("pins the active plan and republishes the same identity idempotently", async () => {
    const first = sealedPlan();
    await publishSealedPlan(deps, first);
    const active = await loadActivePlan(deps);
    expect(active.ok && active.value.planId).toBe(first.planId);

    expect((await publishSealedPlan(deps, first)).ok).toBe(true);
    const reloaded = await loadActivePlan(deps);
    expect(reloaded.ok && reloaded.value.planId).toBe(first.planId);

    const second = sealedPlan({ documentTitle: "Second" });
    expect(second.planId).not.toBe(first.planId);
    await publishSealedPlan(deps, second);
    const repinned = await loadActivePlan(deps);
    expect(repinned.ok && repinned.value.planId).toBe(second.planId);
    // The earlier plan is retained until it expires.
    expect((await loadSealedPlan(deps, first.planId)).ok).toBe(true);
  });

  it("stores the current generation token when republishing an identity", async () => {
    const first = sealedPlan({
      generationToken: "generation-1" as GenerationToken,
    });
    expect((await publishSealedPlan(deps, first)).ok).toBe(true);

    const second = sealedPlan({
      generationToken: "generation-2" as GenerationToken,
    });
    expect(second.planId).toBe(first.planId);
    expect(second.plan.generationToken).not.toBe(first.plan.generationToken);
    expect((await publishSealedPlan(deps, second)).ok).toBe(true);

    const stored = await loadSealedPlan(deps, second.planId);
    expect(stored.ok && stored.value.plan.generationToken).toBe("generation-2");
    const active = await loadActivePlan(deps);
    expect(active.ok && active.value.plan.generationToken).toBe("generation-2");
  });

  it("preserves the stored generation when refresh I/O fails", async () => {
    const first = sealedPlan({
      generationToken: "generation-1" as GenerationToken,
    });
    expect((await publishSealedPlan(deps, first)).ok).toBe(true);
    const second = sealedPlan({
      generationToken: "generation-2" as GenerationToken,
    });

    for (const failedOperation of ["openForWrite", "rename"]) {
      const faulted = withDeps({
        fileSystem: injectFault(deps.fileSystem, (operation, entryPath) => {
          if (
            operation === failedOperation &&
            entryPath.endsWith("plan.json.tmp")
          )
            throw new Error(`refresh ${failedOperation} failed`);
        }),
      });

      expect(await failureCode(publishSealedPlan(faulted, second))).toBe(
        ISSUE_CODES.storageWriteFailed,
      );
      const stored = await loadSealedPlan(deps, first.planId);
      expect(stored.ok && stored.value.plan.generationToken).toBe(
        "generation-1",
      );
      const active = await loadActivePlan(deps);
      expect(active.ok && active.value.plan.generationToken).toBe(
        "generation-1",
      );
    }
  });

  it("stores approval as the exact plan ID and only for the pinned ready plan", async () => {
    const envelope = sealedPlan();
    await publishSealedPlan(deps, envelope);

    expect(
      (await recordPlanApproval(deps, envelope.planId, sourceBytes())).ok,
    ).toBe(true);
    const approvalPath = join(root, "approvals", `${envelope.planId}.json`);
    expect(await modeOf(approvalPath)).toBe(OWNER_ONLY_FILE_MODE);
    expect(await readFile(approvalPath, "utf8")).toBe(
      canonicalizeJcs({ planId: envelope.planId }),
    );
    const approval = await readPlanApproval(deps, envelope.planId);
    expect(approval.ok && approval.value).toBe(envelope.planId);

    const later = sealedPlan({ documentTitle: "Later" });
    await publishSealedPlan(deps, later);
    expect(
      await failureCode(
        recordPlanApproval(deps, envelope.planId, sourceBytes()),
      ),
    ).toBe(ISSUE_CODES.staleApproval);

    const noChanges = unchangedPlan();
    await publishSealedPlan(deps, noChanges);
    expect(
      await failureCode(
        recordPlanApproval(deps, noChanges.planId, sourceBytes()),
      ),
    ).toBe(ISSUE_CODES.approvalMismatch);
  });

  it("reports missing plans and approvals rather than guessing", async () => {
    const absent = `plan-${"0".repeat(64)}` as PlanId;
    expect(await failureCode(loadSealedPlan(deps, absent))).toBe(
      ISSUE_CODES.planNotFound,
    );
    expect(await failureCode(loadSealedPlan(deps, "../escape" as PlanId))).toBe(
      ISSUE_CODES.planNotFound,
    );
    expect(await failureCode(loadActivePlan(deps))).toBe(
      ISSUE_CODES.planNotFound,
    );
    expect(await failureCode(readPlanApproval(deps, absent))).toBe(
      ISSUE_CODES.planNotFound,
    );
  });

  it("expires plans, cleans them up, and unpins the active plan", async () => {
    const envelope = sealedPlan();
    await publishSealedPlan(deps, envelope);
    await recordPlanApproval(deps, envelope.planId, sourceBytes());

    const afterExpiry = withDeps({ now: () => "2026-07-27T00:00:00.000Z" });
    expect(
      await failureCode(loadSealedPlan(afterExpiry, envelope.planId)),
    ).toBe(ISSUE_CODES.planExpired);
    expect(
      await failureCode(publishSealedPlan(afterExpiry, sealedPlan())),
    ).toBe(ISSUE_CODES.planExpired);

    const removed = await cleanupExpiredPlans(afterExpiry);
    expect(removed.ok && removed.value).toEqual([envelope.planId]);
    expect(await readdir(join(root, "plans"))).toEqual([]);
    expect(await readdir(join(root, "approvals"))).toEqual([]);
    expect(await failureCode(loadActivePlan(deps))).toBe(
      ISSUE_CODES.planNotFound,
    );

    // A live plan and its approval survive cleanup untouched.
    const live = sealedPlan();
    await publishSealedPlan(deps, live);
    const kept = await cleanupExpiredPlans(deps);
    expect(kept.ok && kept.value).toEqual([]);
    expect((await loadSealedPlan(deps, live.planId)).ok).toBe(true);
  });

  it("removes abandoned staging directories during cleanup", async () => {
    await publishSealedPlan(deps, sealedPlan());
    const staging = join(root, "plans", `.staging-plan-${"a".repeat(64)}`);
    await deps.fileSystem.makeDirectory(staging, OWNER_ONLY_DIRECTORY_MODE);
    await writeFile(join(staging, "leftover"), "partial", { mode: 0o600 });

    expect((await cleanupExpiredPlans(deps)).ok).toBe(true);
    expect(
      (await readdir(join(root, "plans"))).filter((name) =>
        name.startsWith(".staging-"),
      ),
    ).toEqual([]);
  });

  it("rejects widened permissions on every directory and file it reads", async () => {
    const envelope = sealedPlan();
    await publishSealedPlan(deps, envelope);
    const blobName = [...envelope.blobBytes.keys()][0]!;
    const widened: readonly [string, string, number][] = [
      ["root", root, 0o755],
      ["plans", join(root, "plans"), 0o755],
      ["plan", join(root, "plans", envelope.planId), 0o750],
      ["blobs", blobDirectoryOf(envelope.planId), 0o707],
      ["plan.json", planDocumentOf(envelope.planId), 0o644],
      ["blob", join(blobDirectoryOf(envelope.planId), blobName), 0o604],
    ];

    for (const [label, path, mode] of widened) {
      const original = await modeOf(path);
      await chmod(path, mode);
      expect(
        await failureCode(loadSealedPlan(deps, envelope.planId)),
        label,
      ).toBe(ISSUE_CODES.storageTampered);
      await chmod(path, original);
    }
    expect((await loadSealedPlan(deps, envelope.planId)).ok).toBe(true);
  });

  it("rejects tampered documents, blobs, and planted links as tampering", async () => {
    const envelope = sealedPlan();
    await publishSealedPlan(deps, envelope);
    const planId = envelope.planId;
    const blobName = [...envelope.blobBytes.keys()].sort()[0]!;
    const blobPath = join(blobDirectoryOf(planId), blobName);
    const original = new Uint8Array(await readFile(blobPath));

    await writeFile(
      blobPath,
      Uint8Array.from(original, (byte) => byte ^ 0xff),
      {
        mode: 0o600,
      },
    );
    expect(await failureCode(loadSealedPlan(deps, planId)), "blob bytes").toBe(
      ISSUE_CODES.storageTampered,
    );
    await writeFile(blobPath, original, { mode: 0o600 });
    expect((await loadSealedPlan(deps, planId)).ok).toBe(true);

    const extraPath = join(blobDirectoryOf(planId), "b".repeat(64));
    await writeFile(extraPath, "extra", { mode: 0o600 });
    expect(await failureCode(loadSealedPlan(deps, planId)), "extra blob").toBe(
      ISSUE_CODES.storageTampered,
    );
    await rm(extraPath);

    const strayPath = join(blobDirectoryOf(planId), "notes.txt");
    await writeFile(strayPath, "stray", { mode: 0o600 });
    expect(await failureCode(loadSealedPlan(deps, planId)), "stray name").toBe(
      ISSUE_CODES.storageTampered,
    );
    await rm(strayPath);

    await rm(blobPath);
    expect(
      await failureCode(loadSealedPlan(deps, planId)),
      "missing blob",
    ).toBe(ISSUE_CODES.storageTampered);
    await symlink(join(root, "plans"), blobPath);
    expect(
      await failureCode(loadSealedPlan(deps, planId)),
      "symlinked blob",
    ).toBe(ISSUE_CODES.storageTampered);
    await rm(blobPath);
    await writeFile(blobPath, original, { mode: 0o600 });

    const documentPath = planDocumentOf(planId);
    const document = JSON.parse(await readFile(documentPath, "utf8")) as Record<
      string,
      unknown
    >;
    for (const forged of [
      "not json at all",
      canonicalizeJcs({
        ...document,
        expiresAtUtc: "2027-01-01T00:00:00.000Z",
      }),
      canonicalizeJcs({ ...document, planId: `plan-${"c".repeat(64)}` }),
    ]) {
      await writeFile(documentPath, forged, { mode: 0o600 });
      expect(await failureCode(loadSealedPlan(deps, planId)), forged).toBe(
        ISSUE_CODES.storageTampered,
      );
    }
  });

  it("rejects a tampered or forged active-plan pointer without loading a plan", async () => {
    const envelope = sealedPlan();
    await publishSealedPlan(deps, envelope);
    const pointerPath = join(root, "active-plan.json");

    for (const forged of [
      "{}",
      '{"planId":"../escape"}',
      `{"planId":"${envelope.planId}","extra":true}`,
      "broken",
    ]) {
      await writeFile(pointerPath, forged, { mode: 0o600 });
      expect(await failureCode(loadActivePlan(deps)), forged).toBe(
        ISSUE_CODES.planNotFound,
      );
    }
    await writeFile(pointerPath, canonicalizeJcs({ planId: envelope.planId }), {
      mode: 0o600,
    });
    expect((await loadActivePlan(deps)).ok).toBe(true);
    await chmod(pointerPath, 0o644);
    expect(await failureCode(loadActivePlan(deps))).toBe(
      ISSUE_CODES.planNotFound,
    );
  });

  it("exposes no plan when any write, fsync, rename, disk, hash, or mode step fails", async () => {
    const envelope = sealedPlan();
    const enospc = () => {
      const error = new Error("no space left on device") as Error & {
        code: string;
      };
      error.code = "ENOSPC";
      throw error;
    };
    const failOn =
      (operation: string, match: (entryPath: string) => boolean) =>
      (candidate: string, entryPath: string) => {
        if (candidate === operation && match(entryPath)) enospc();
      };
    const isStagedBlob = (entryPath: string) =>
      entryPath.includes(".staging-") && entryPath.includes("/blobs/");
    const isStagedDocument = (entryPath: string) =>
      entryPath.includes(".staging-") && entryPath.endsWith("plan.json");

    const faults: readonly [string, PlanStoreDeps][] = [
      [
        "openForWrite blob",
        withDeps({
          fileSystem: injectFault(
            deps.fileSystem,
            failOn("openForWrite", isStagedBlob),
          ),
        }),
      ],
      [
        "write blob (disk full)",
        withDeps({
          fileSystem: injectFault(
            deps.fileSystem,
            failOn("write", isStagedBlob),
          ),
        }),
      ],
      [
        "fsync blob",
        withDeps({
          fileSystem: injectFault(
            deps.fileSystem,
            failOn("sync", isStagedBlob),
          ),
        }),
      ],
      [
        "write plan document",
        withDeps({
          fileSystem: injectFault(
            deps.fileSystem,
            failOn("write", isStagedDocument),
          ),
        }),
      ],
      [
        "fsync staging directory",
        withDeps({
          fileSystem: injectFault(
            deps.fileSystem,
            failOn("syncDirectory", (path) => path.includes(".staging-")),
          ),
        }),
      ],
      [
        "rename into place",
        withDeps({
          fileSystem: injectFault(
            deps.fileSystem,
            failOn("rename", (path) => path.includes(".staging-")),
          ),
        }),
      ],
      [
        "fsync plans directory",
        withDeps({
          fileSystem: injectFault(
            deps.fileSystem,
            failOn("syncDirectory", (path) => path.endsWith("/plans")),
          ),
        }),
      ],
      [
        "verification read-back",
        withDeps({
          fileSystem: injectFault(
            deps.fileSystem,
            failOn("readFile", isStagedBlob),
          ),
        }),
      ],
      [
        "hash disagrees between the write and the read-back",
        withDeps({
          hash: (
            (counter: { value: number }) => () =>
              `sha256:${String(counter.value++).padStart(64, "0")}` as Sha256Digest
          )({ value: 0 }),
        }),
      ],
      [
        "silently corrupted write with a colluding hash",
        withDeps({
          hash: () => `sha256:${"e".repeat(64)}` as Sha256Digest,
          fileSystem: {
            ...deps.fileSystem,
            openForWrite: async (filePath, mode) => {
              const handle = await deps.fileSystem.openForWrite(filePath, mode);
              return {
                ...handle,
                write: (bytes) =>
                  handle.write(
                    isStagedBlob(filePath)
                      ? Uint8Array.from(bytes, (byte) => byte ^ 1)
                      : bytes,
                  ),
              };
            },
          },
        }),
      ],
      [
        "permissions widened under the writer",
        withDeps({
          fileSystem: {
            ...deps.fileSystem,
            readPermissionBits: async (entryPath) =>
              isStagedDocument(entryPath)
                ? 0o644
                : deps.fileSystem.readPermissionBits(entryPath),
          },
        }),
      ],
    ];

    for (const [label, faulted] of faults) {
      expect(
        await failureCode(publishSealedPlan(faulted, envelope)),
        label,
      ).toBe(ISSUE_CODES.storageWriteFailed);
      expect(
        await failureCode(loadSealedPlan(deps, envelope.planId)),
        label,
      ).toBe(ISSUE_CODES.planNotFound);
      expect(await failureCode(loadActivePlan(deps)), label).toBe(
        ISSUE_CODES.planNotFound,
      );
      expect(
        (await readdir(join(root, "plans"))).filter((name) =>
          name.startsWith(".staging-"),
        ),
        label,
      ).toEqual([]);
    }

    // The same plan publishes cleanly once the injected fault is gone.
    expect((await publishSealedPlan(deps, envelope)).ok).toBe(true);
    expect((await loadSealedPlan(deps, envelope.planId)).ok).toBe(true);
  });

  it("keeps the previously published plan when a later publication fails", async () => {
    const first = sealedPlan();
    await publishSealedPlan(deps, first);
    const second = sealedPlan({ documentTitle: "Second" });
    const faulted = withDeps({
      fileSystem: injectFault(deps.fileSystem, (operation, entryPath) => {
        if (operation === "rename" && entryPath.includes(".staging-"))
          throw new Error("rename failed");
      }),
    });

    expect(await failureCode(publishSealedPlan(faulted, second))).toBe(
      ISSUE_CODES.storageWriteFailed,
    );
    expect(await failureCode(loadSealedPlan(deps, second.planId))).toBe(
      ISSUE_CODES.planNotFound,
    );
    const active = await loadActivePlan(deps);
    expect(active.ok && active.value.planId).toBe(first.planId);
  });

  it("removes an unpinnable publication and restores the pin that was there", async () => {
    const first = sealedPlan();
    await publishSealedPlan(deps, first);
    const second = sealedPlan({ documentTitle: "Second" });
    const activePath = join(root, "active-plan.json");
    const activeTemporary = `${activePath}.tmp`;

    const pointerFaults: readonly [
      string,
      (operation: string, entryPath: string) => void,
    ][] = [
      [
        "pointer open",
        (operation, entryPath) => {
          if (operation === "openForWrite" && entryPath === activeTemporary)
            throw new Error("pointer open failed");
        },
      ],
      [
        "pointer write",
        (operation, entryPath) => {
          if (operation === "write" && entryPath === activeTemporary)
            throw new Error("pointer write failed");
        },
      ],
      [
        "pointer fsync",
        (operation, entryPath) => {
          if (operation === "sync" && entryPath === activeTemporary)
            throw new Error("pointer fsync failed");
        },
      ],
      [
        "pointer rename",
        (operation, entryPath) => {
          if (operation === "rename" && entryPath === activeTemporary)
            throw new Error("pointer rename failed");
        },
      ],
      [
        "pointer parent fsync",
        (operation, entryPath) => {
          if (operation === "syncDirectory" && entryPath === root)
            throw new Error("pointer parent fsync failed");
        },
      ],
    ];

    for (const [label, fail] of pointerFaults) {
      const faulted = withDeps({
        fileSystem: injectFault(deps.fileSystem, fail),
      });
      expect(await failureCode(publishSealedPlan(faulted, second)), label).toBe(
        ISSUE_CODES.storageWriteFailed,
      );
      // Nothing the caller was told failed may stay loadable, and the pin the
      // store had before the attempt must survive it exactly.
      expect(
        await failureCode(loadSealedPlan(deps, second.planId)),
        label,
      ).toBe(ISSUE_CODES.planNotFound);
      const active = await loadActivePlan(deps);
      expect(active.ok && active.value.planId, label).toBe(first.planId);
    }

    expect((await publishSealedPlan(deps, second)).ok).toBe(true);
    const pinned = await loadActivePlan(deps);
    expect(pinned.ok && pinned.value.planId).toBe(second.planId);
  });

  it("keeps an already valid plan when an idempotent re-pin fails", async () => {
    const envelope = sealedPlan();
    await publishSealedPlan(deps, envelope);
    const other = sealedPlan({ documentTitle: "Other" });
    await publishSealedPlan(deps, other);

    const activeTemporary = `${join(root, "active-plan.json")}.tmp`;
    const faulted = withDeps({
      fileSystem: injectFault(deps.fileSystem, (operation, entryPath) => {
        if (operation === "rename" && entryPath === activeTemporary)
          throw new Error("pointer rename failed");
      }),
    });

    expect(await failureCode(publishSealedPlan(faulted, envelope))).toBe(
      ISSUE_CODES.storageWriteFailed,
    );
    // The plan at this ID was already valid before the call, so it stays.
    expect((await loadSealedPlan(deps, envelope.planId)).ok).toBe(true);
    const active = await loadActivePlan(deps);
    expect(active.ok && active.value.planId).toBe(other.planId);
  });

  it("flushes the containing directory after every pointer rename", async () => {
    const envelope = sealedPlan();
    const activePath = join(root, "active-plan.json");
    const approvalPath = join(root, "approvals", `${envelope.planId}.json`);
    const events: string[] = [];
    const traced = withDeps({
      fileSystem: {
        ...deps.fileSystem,
        rename: async (fromPath, toPath) => {
          events.push(`rename:${toPath}`);
          return deps.fileSystem.rename(fromPath, toPath);
        },
        syncDirectory: async (directoryPath) => {
          events.push(`sync:${directoryPath}`);
          return deps.fileSystem.syncDirectory(directoryPath);
        },
      },
    });

    expect((await publishSealedPlan(traced, envelope)).ok).toBe(true);
    expect(events.indexOf(`sync:${root}`)).toBeGreaterThan(
      events.indexOf(`rename:${activePath}`),
    );

    events.length = 0;
    expect(
      (await recordPlanApproval(traced, envelope.planId, sourceBytes())).ok,
    ).toBe(true);
    expect(events.indexOf(`sync:${join(root, "approvals")}`)).toBeGreaterThan(
      events.indexOf(`rename:${approvalPath}`),
    );
  });

  it("replaces the stored generation when the same identity is republished", async () => {
    const first = sealedPlan();
    const regenerated = sealedPlan({
      generationToken: "generation-9" as GenerationToken,
    });
    // The plan ID excludes the generation token by construction.
    expect(regenerated.planId).toBe(first.planId);
    expect(regenerated.plan.generationToken).not.toBe(
      first.plan.generationToken,
    );

    await publishSealedPlan(deps, first);
    expect((await publishSealedPlan(deps, regenerated)).ok).toBe(true);

    const stored = JSON.parse(
      await readFile(planDocumentOf(first.planId), "utf8"),
    ) as { generationToken: string };
    expect(stored.generationToken).toBe("generation-9");
    const active = await loadActivePlan(deps);
    expect(active.ok && active.value.plan.generationToken).toBe("generation-9");

    // A failed replacement leaves the valid stored plan and its token alone.
    const documentTemporary = `${planDocumentOf(first.planId)}.tmp`;
    const faulted = withDeps({
      fileSystem: injectFault(deps.fileSystem, (operation, entryPath) => {
        if (operation === "rename" && entryPath === documentTemporary)
          throw new Error("document rename failed");
      }),
    });
    expect(await failureCode(publishSealedPlan(faulted, first))).toBe(
      ISSUE_CODES.storageWriteFailed,
    );
    const kept = await loadSealedPlan(deps, first.planId);
    expect(kept.ok && kept.value.plan.generationToken).toBe("generation-9");
    expect((await readdir(join(root, "plans", first.planId))).sort()).toEqual([
      "blobs",
      "plan.json",
    ]);
  });

  it("rechecks owner-only ancestry and live source bytes before approving", async () => {
    const envelope = sealedPlan();
    await publishSealedPlan(deps, envelope);
    expect(
      (await recordPlanApproval(deps, envelope.planId, sourceBytes())).ok,
    ).toBe(true);

    const widened: readonly [string, string][] = [
      ["root", root],
      ["approvals", join(root, "approvals")],
    ];
    for (const [label, path] of widened) {
      const original = await modeOf(path);
      await chmod(path, 0o755);
      expect(
        await failureCode(readPlanApproval(deps, envelope.planId)),
        label,
      ).toBe(ISSUE_CODES.storageTampered);
      await chmod(path, original);
    }
    expect((await readPlanApproval(deps, envelope.planId)).ok).toBe(true);

    // An approval is authority over reviewed bytes, so the bytes are reread.
    const later = sealedPlan({ documentTitle: "Later" });
    await publishSealedPlan(deps, later);
    expect(
      await failureCode(
        recordPlanApproval(deps, later.planId, {
          note: utf8("# Something else\n"),
          images: new Map([["image-a", SOURCE_A_BYTES]]),
        }),
      ),
    ).toBe(ISSUE_CODES.storageTampered);
    expect(await failureCode(readPlanApproval(deps, later.planId))).toBe(
      ISSUE_CODES.planNotFound,
    );
  });

  it("serializes approval against a concurrent publication", async () => {
    const first = sealedPlan();
    await publishSealedPlan(deps, first);
    const second = sealedPlan({ documentTitle: "Second" });

    const activePath = join(root, "active-plan.json");
    const approvalTemporary = `${join(root, "approvals", `${first.planId}.json`)}.tmp`;
    const events: string[] = [];
    let openApproval = (): void => undefined;
    const heldApproval = new Promise<void>((resolve) => {
      openApproval = resolve;
    });

    const traced = (label: string, gate?: Promise<void>): PlanStoreDeps =>
      withDeps({
        fileSystem: {
          ...deps.fileSystem,
          readFile: async (filePath) => {
            if (filePath === activePath) events.push(`${label}:read-active`);
            return deps.fileSystem.readFile(filePath);
          },
          rename: async (fromPath, toPath) => {
            if (toPath === activePath) events.push(`${label}:pin`);
            return deps.fileSystem.rename(fromPath, toPath);
          },
          openForWrite: async (filePath, mode) => {
            if (filePath === approvalTemporary) {
              events.push(`${label}:approve-reached`);
              if (gate) await gate;
              events.push(`${label}:approve`);
            }
            return deps.fileSystem.openForWrite(filePath, mode);
          },
        },
      });

    const record = recordPlanApproval(
      traced("record", heldApproval),
      first.planId,
      sourceBytes(),
    );
    while (!events.includes("record:approve-reached"))
      await new Promise((resolve) => setImmediate(resolve));

    let publishSettled = false;
    const publish = publishSealedPlan(traced("publish"), second);
    const markSettled = () => void (publishSettled = true);
    void publish.then(markSettled, markSettled);
    // Give an unserialized publication every chance to land its pin between the
    // approval's pointer read and its approval write -- far longer than a whole
    // publication takes here. A serialized one cannot even start.
    const deadline = Date.now() + CONCURRENT_PUBLISH_BUDGET_MS;
    while (
      !publishSettled &&
      !events.includes("publish:pin") &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 1));
    openApproval();

    expect((await record).ok).toBe(true);
    expect((await publish).ok).toBe(true);

    // The approval read the pin it was still holding when it wrote: no
    // competing publication landed inside that read-then-write.
    const pointerRead = events.indexOf("record:read-active");
    const approvalWrite = events.indexOf("record:approve");
    const competingPin = events.indexOf("publish:pin");
    expect(pointerRead).toBeGreaterThanOrEqual(0);
    expect(approvalWrite).toBeGreaterThan(pointerRead);
    expect(competingPin).toBeGreaterThan(approvalWrite);
    const active = await loadActivePlan(deps);
    expect(active.ok && active.value.planId).toBe(second.planId);
  });

  it("refuses hostile stored plans against the locked limits before reading them", async () => {
    const envelope = sealedPlan();
    await publishSealedPlan(deps, envelope);
    const blobDirectory = blobDirectoryOf(envelope.planId);
    const documentPath = planDocumentOf(envelope.planId);
    const readPaths: string[] = [];
    const watched = (
      overrides: Partial<PlanStoreFileSystem> = {},
    ): PlanStoreDeps => {
      readPaths.length = 0;
      return withDeps({
        fileSystem: {
          ...deps.fileSystem,
          readFile: async (filePath) => {
            readPaths.push(filePath);
            return deps.fileSystem.readFile(filePath);
          },
          ...overrides,
        },
      });
    };
    const readBlobs = () =>
      readPaths.filter((filePath) => filePath.startsWith(blobDirectory));

    const planted: string[] = [];
    for (
      let index = 0;
      index <= MDX_RELAY_LIMITS.sealedOutputFiles;
      index += 1
    ) {
      const path = join(blobDirectory, index.toString(16).padStart(64, "0"));
      await writeFile(path, "planted", { mode: 0o600 });
      planted.push(path);
    }
    expect(
      await failureCode(loadSealedPlan(watched(), envelope.planId)),
      "blob count",
    ).toBe(ISSUE_CODES.storageTampered);
    expect(readBlobs(), "blob count").toEqual([]);
    for (const path of planted) await rm(path, { force: true });
    expect((await loadSealedPlan(deps, envelope.planId)).ok).toBe(true);

    const reportedSize =
      (size: (entryPath: string) => number | undefined) =>
      async (entryPath: string) =>
        size(entryPath) ?? deps.fileSystem.byteLength(entryPath);

    const oversizedBlob = watched({
      byteLength: reportedSize((entryPath) =>
        entryPath.startsWith(blobDirectory)
          ? MDX_RELAY_LIMITS.sealedOutputBytes + 1
          : undefined,
      ),
    });
    expect(
      await failureCode(loadSealedPlan(oversizedBlob, envelope.planId)),
      "blob size",
    ).toBe(ISSUE_CODES.storageTampered);
    expect(readBlobs(), "blob size").toEqual([]);

    const oversizedAggregate = watched({
      byteLength: reportedSize((entryPath) =>
        entryPath.startsWith(blobDirectory)
          ? MDX_RELAY_LIMITS.sealedOutputBytes
          : undefined,
      ),
    });
    // Three maximum-size blobs still fit; the planted extras push the plan past
    // the total budget without a single byte of any of them being read.
    for (let index = 0; index < 3; index += 1) {
      const path = join(blobDirectory, `f${index}`.padStart(64, "0"));
      await writeFile(path, "planted", { mode: 0o600 });
      planted.push(path);
    }
    expect(
      await failureCode(loadSealedPlan(oversizedAggregate, envelope.planId)),
      "aggregate size",
    ).toBe(ISSUE_CODES.storageTampered);
    expect(readBlobs(), "aggregate size").toEqual([]);
    for (const path of planted) await rm(path, { force: true });

    const oversizedDocument = watched({
      byteLength: reportedSize((entryPath) =>
        entryPath === documentPath ? MAX_PLAN_DOCUMENT_BYTES + 1 : undefined,
      ),
    });
    expect(
      await failureCode(loadSealedPlan(oversizedDocument, envelope.planId)),
      "document size",
    ).toBe(ISSUE_CODES.storageTampered);
    expect(readPaths, "document size").not.toContain(documentPath);

    const oversizedPointer = watched({
      byteLength: reportedSize((entryPath) =>
        entryPath.endsWith("active-plan.json")
          ? MAX_PLAN_POINTER_BYTES + 1
          : undefined,
      ),
    });
    expect(await failureCode(loadActivePlan(oversizedPointer))).toBe(
      ISSUE_CODES.planNotFound,
    );

    // The real primitive measures the entry itself, never a symlink target.
    const fileSystem = createNodePlanStoreFileSystem();
    const sizedPath = join(root, "sized");
    await writeFile(sizedPath, new Uint8Array(1234), { mode: 0o600 });
    expect(await fileSystem.byteLength(sizedPath)).toBe(1234);
    const linkPath = join(root, "sized-link");
    await symlink(sizedPath, linkPath);
    expect(await fileSystem.byteLength(linkPath)).toBe(sizedPath.length);
  });

  it("never stores source bytes and never brands a restored plan without them", async () => {
    const envelope = sealedPlan();
    await publishSealedPlan(deps, envelope);

    const noteBytes = Buffer.from(NOTE_BYTES);
    const noteDigest = sha256OfBytes(NOTE_BYTES);
    let sawDigest = false;
    for (const entry of await readdir(root, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      const stored = await readFile(join(entry.parentPath, entry.name));
      expect(stored.includes(noteBytes), entry.name).toBe(false);
      sawDigest ||= stored.includes(noteDigest);
    }
    // The fingerprint is stored; the private bytes behind it never are.
    expect(sawDigest).toBe(true);

    const restored = await loadSealedPlan(deps, envelope.planId);
    expect(restored.ok && restored.value.sourceBytesVerified).toBe(false);
    const rebranded = await loadSealedPlan(
      deps,
      envelope.planId,
      sourceBytes(),
    );
    expect(rebranded.ok && rebranded.value.sourceBytesVerified).toBe(true);

    // An unbranded envelope is not publishable and cannot be approved.
    if (!restored.ok) throw new Error("expected a restored plan");
    expect(await failureCode(publishSealedPlan(deps, restored.value))).toBe(
      ISSUE_CODES.storageWriteFailed,
    );
    expect((await loadSealedPlan(deps, envelope.planId)).ok).toBe(true);
  });

  it("points the default macOS root outside any vault or repository", () => {
    expect(defaultPlanStoreRoot()).toMatch(
      /Library\/Application Support\/MDXRelay$/u,
    );
  });
});
