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
import {
  buildExportPlan,
  sha256OfBytes,
  sha256OfUtf8,
  type ExportPlanBuildInput,
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

    expect((await recordPlanApproval(deps, envelope.planId)).ok).toBe(true);
    const approvalPath = join(root, "approvals", `${envelope.planId}.json`);
    expect(await modeOf(approvalPath)).toBe(OWNER_ONLY_FILE_MODE);
    expect(await readFile(approvalPath, "utf8")).toBe(
      canonicalizeJcs({ planId: envelope.planId }),
    );
    const approval = await readPlanApproval(deps, envelope.planId);
    expect(approval.ok && approval.value).toBe(envelope.planId);

    const later = sealedPlan({ documentTitle: "Later" });
    await publishSealedPlan(deps, later);
    expect(await failureCode(recordPlanApproval(deps, envelope.planId))).toBe(
      ISSUE_CODES.staleApproval,
    );

    const noChanges = unchangedPlan();
    await publishSealedPlan(deps, noChanges);
    expect(await failureCode(recordPlanApproval(deps, noChanges.planId))).toBe(
      ISSUE_CODES.approvalMismatch,
    );
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
    await recordPlanApproval(deps, envelope.planId);

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

  it("points the default macOS root outside any vault or repository", () => {
    expect(defaultPlanStoreRoot()).toMatch(
      /Library\/Application Support\/MDXRelay$/u,
    );
  });
});
