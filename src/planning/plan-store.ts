import { constants as fsConstants } from "node:fs";
import {
  open,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { PlanId } from "../contracts/export-plan";
import { createIssue, ISSUE_CODES } from "../contracts/issues";
import {
  mdxRelayErr,
  mdxRelayOk,
  type MdxRelayResult,
} from "../contracts/result";
import { sha256OfBytes } from "./build-export-plan";
import {
  ACTIVE_PLAN_FILENAME,
  APPROVALS_DIRECTORY,
  OWNER_ONLY_DIRECTORY_MODE,
  OWNER_ONLY_FILE_MODE,
  PLAN_BLOB_DIRECTORY,
  PLAN_BLOB_NAME_PATTERN,
  PLAN_DOCUMENT_FILENAME,
  PLAN_ID_PATTERN,
  PLANS_DIRECTORY,
  STAGING_PREFIX,
  TEMPORARY_SUFFIX,
  type PlanStoreDeps,
  type PlanStoreFileSystem,
} from "./plan-store-types";
import {
  canonicalizeJcs,
  verifyStoredExportPlan,
  type SealedExportPlanEnvelope,
} from "./seal-export-plan";

/**
 * Owner-only private storage for sealed plans.
 *
 *   stage -> write+fsync+verify each file -> fsync staging -> rename ->
 *   fsync parent -> reload and verify -> pin active
 *
 * Nothing is ever published in place. A plan becomes visible only through the
 * single rename of a fully written, individually re-read and re-hashed staging
 * directory, and that rename is only trusted after the published plan loads and
 * verifies again. Any fault before that point leaves the store with no plan at
 * that ID at all, and any fault after it removes the published directory again.
 * Loading rechecks owner-only modes on every directory and file it touches, so
 * widened permissions are tampering rather than a warning.
 */

const notFound = (): MdxRelayResult<never> =>
  mdxRelayErr([createIssue(ISSUE_CODES.planNotFound)]);
const tampered = (): MdxRelayResult<never> =>
  mdxRelayErr([createIssue(ISSUE_CODES.storageTampered)]);
const writeFailed = (): MdxRelayResult<never> =>
  mdxRelayErr([createIssue(ISSUE_CODES.storageWriteFailed)]);

/** macOS alpha root, outside the vault, the repository and its Git directory. */
export function defaultPlanStoreRoot(): string {
  return join(homedir(), "Library", "Application Support", "MDXRelay");
}

export function createNodePlanStoreFileSystem(): PlanStoreFileSystem {
  return {
    async makeDirectory(directoryPath, mode) {
      await mkdir(directoryPath, { recursive: true, mode });
      // mkdir's mode is subject to the process umask; the store's guarantee is not.
      const handle = await open(directoryPath, fsConstants.O_RDONLY);
      try {
        await handle.chmod(mode);
      } finally {
        await handle.close();
      }
    },
    async openForWrite(filePath, mode) {
      const handle = await open(filePath, "wx", mode);
      await handle.chmod(mode);
      return {
        write: async (bytes) => void (await handle.write(bytes)),
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
    async syncDirectory(directoryPath) {
      const handle = await open(directoryPath, fsConstants.O_RDONLY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    rename: (fromPath, toPath) => rename(fromPath, toPath),
    readFile: async (filePath) => new Uint8Array(await readFile(filePath)),
    readPermissionBits: async (entryPath) =>
      (await lstat(entryPath)).mode & 0o777,
    listDirectory: (directoryPath) => readdir(directoryPath),
    removeRecursively: (entryPath) =>
      rm(entryPath, { recursive: true, force: true }),
  };
}

export function createPlanStoreDeps(
  rootDirectory: string = defaultPlanStoreRoot(),
): PlanStoreDeps {
  return Object.freeze({
    rootDirectory,
    fileSystem: createNodePlanStoreFileSystem(),
    hash: sha256OfBytes,
    now: () => new Date().toISOString(),
    enforceOwnerOnlyModes: process.platform !== "win32",
  });
}

const plansDirectory = (deps: PlanStoreDeps): string =>
  join(deps.rootDirectory, PLANS_DIRECTORY);
const planDirectory = (deps: PlanStoreDeps, planId: PlanId): string =>
  join(plansDirectory(deps), planId);
const approvalsDirectory = (deps: PlanStoreDeps): string =>
  join(deps.rootDirectory, APPROVALS_DIRECTORY);
const approvalFile = (deps: PlanStoreDeps, planId: PlanId): string =>
  join(approvalsDirectory(deps), `${planId}.json`);
const activePlanFile = (deps: PlanStoreDeps): string =>
  join(deps.rootDirectory, ACTIVE_PLAN_FILENAME);

const permissionBits = async (
  deps: PlanStoreDeps,
  entryPath: string,
): Promise<number | undefined> => {
  try {
    return await deps.fileSystem.readPermissionBits(entryPath);
  } catch {
    return undefined;
  }
};

const hasOwnerOnlyMode = async (
  deps: PlanStoreDeps,
  entryPath: string,
  expectedMode: number,
): Promise<boolean> => {
  const bits = await permissionBits(deps, entryPath);
  if (bits === undefined) return false;
  return !deps.enforceOwnerOnlyModes || bits === expectedMode;
};

const ensureOwnerOnlyDirectory = async (
  deps: PlanStoreDeps,
  directoryPath: string,
): Promise<void> => {
  await deps.fileSystem.makeDirectory(directoryPath, OWNER_ONLY_DIRECTORY_MODE);
  if (!(await hasOwnerOnlyMode(deps, directoryPath, OWNER_ONLY_DIRECTORY_MODE)))
    throw new Error("Plan storage directory is not owner-only");
};

/** Writes one file exclusively, flushes it, then reopens and re-hashes it. */
const writeVerifiedFile = async (
  deps: PlanStoreDeps,
  filePath: string,
  bytes: Uint8Array,
): Promise<void> => {
  const handle = await deps.fileSystem.openForWrite(
    filePath,
    OWNER_ONLY_FILE_MODE,
  );
  try {
    await handle.write(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (!(await hasOwnerOnlyMode(deps, filePath, OWNER_ONLY_FILE_MODE)))
    throw new Error("Sealed file is not owner-only");
  const readBack = await deps.fileSystem.readFile(filePath);
  if (
    readBack.byteLength !== bytes.byteLength ||
    deps.hash(readBack) !== deps.hash(bytes)
  )
    throw new Error("Sealed file did not read back intact");
};

/** Atomically replaces one verified file and durably commits its directory entry. */
const replaceVerifiedFile = async (
  deps: PlanStoreDeps,
  filePath: string,
  bytes: Uint8Array,
): Promise<void> => {
  const temporaryPath = `${filePath}${TEMPORARY_SUFFIX}`;
  await deps.fileSystem.removeRecursively(temporaryPath);
  await writeVerifiedFile(deps, temporaryPath, bytes);
  await deps.fileSystem.rename(temporaryPath, filePath);
  await deps.fileSystem.syncDirectory(dirname(filePath));
};

const writePointer = async (
  deps: PlanStoreDeps,
  filePath: string,
  planId: PlanId,
): Promise<void> => {
  const temporaryPath = `${filePath}${TEMPORARY_SUFFIX}`;
  await deps.fileSystem.removeRecursively(temporaryPath);
  await writeVerifiedFile(
    deps,
    temporaryPath,
    new TextEncoder().encode(canonicalizeJcs({ planId })),
  );
  await deps.fileSystem.rename(temporaryPath, filePath);
};

const readPointer = async (
  deps: PlanStoreDeps,
  filePath: string,
): Promise<PlanId | undefined> => {
  if (!(await hasOwnerOnlyMode(deps, filePath, OWNER_ONLY_FILE_MODE)))
    return undefined;
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(await deps.fileSystem.readFile(filePath)),
    );
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Object.keys(parsed).length !== 1
    )
      return undefined;
    const { planId } = parsed as { planId?: unknown };
    return typeof planId === "string" && PLAN_ID_PATTERN.test(planId)
      ? (planId as PlanId)
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Loads a stored plan, rechecking owner-only modes on every directory and file
 * before its bytes are trusted and re-verifying the whole plan afterwards.
 */
export async function loadSealedPlan(
  deps: PlanStoreDeps,
  planId: PlanId,
): Promise<MdxRelayResult<SealedExportPlanEnvelope>> {
  if (!PLAN_ID_PATTERN.test(planId)) return notFound();
  const directory = planDirectory(deps, planId);
  if ((await permissionBits(deps, directory)) === undefined) return notFound();

  try {
    for (const owned of [
      deps.rootDirectory,
      plansDirectory(deps),
      directory,
      join(directory, PLAN_BLOB_DIRECTORY),
    ])
      if (!(await hasOwnerOnlyMode(deps, owned, OWNER_ONLY_DIRECTORY_MODE)))
        return tampered();

    const documentPath = join(directory, PLAN_DOCUMENT_FILENAME);
    if (!(await hasOwnerOnlyMode(deps, documentPath, OWNER_ONLY_FILE_MODE)))
      return tampered();

    const blobBytes = new Map<string, Uint8Array>();
    const blobDirectory = join(directory, PLAN_BLOB_DIRECTORY);
    for (const name of await deps.fileSystem.listDirectory(blobDirectory)) {
      const blobPath = join(blobDirectory, name);
      if (
        !PLAN_BLOB_NAME_PATTERN.test(name) ||
        !(await hasOwnerOnlyMode(deps, blobPath, OWNER_ONLY_FILE_MODE))
      )
        return tampered();
      blobBytes.set(name, await deps.fileSystem.readFile(blobPath));
    }

    const document: unknown = JSON.parse(
      new TextDecoder().decode(await deps.fileSystem.readFile(documentPath)),
    );
    const verified = verifyStoredExportPlan(document, blobBytes, deps.now());
    if (!verified.ok) return verified;
    return verified.value.planId === planId ? verified : tampered();
  } catch {
    return tampered();
  }
}

export async function loadActivePlan(
  deps: PlanStoreDeps,
): Promise<MdxRelayResult<SealedExportPlanEnvelope>> {
  const planId = await readPointer(deps, activePlanFile(deps));
  return planId === undefined ? notFound() : loadSealedPlan(deps, planId);
}

/**
 * Publishes a sealed plan atomically and pins it as the active plan. Returns a
 * write failure -- never a plan ID -- if any step of the sequence fails, and
 * leaves nothing loadable at that ID when it does.
 */
export async function publishSealedPlan(
  deps: PlanStoreDeps,
  envelope: SealedExportPlanEnvelope,
): Promise<MdxRelayResult<PlanId>> {
  const { planId } = envelope;
  if (!PLAN_ID_PATTERN.test(planId)) return writeFailed();
  if (Date.parse(deps.now()) >= Date.parse(envelope.plan.expiresAtUtc))
    return mdxRelayErr([createIssue(ISSUE_CODES.planExpired)]);

  const directory = planDirectory(deps, planId);
  const staging = join(plansDirectory(deps), `${STAGING_PREFIX}${planId}`);
  try {
    await ensureOwnerOnlyDirectory(deps, deps.rootDirectory);
    await ensureOwnerOnlyDirectory(deps, plansDirectory(deps));
    await ensureOwnerOnlyDirectory(deps, approvalsDirectory(deps));

    // The plan ID excludes the per-run generation token. Preserve the immutable
    // identity and blobs, but atomically refresh plan.json before re-pinning.
    const existing = await loadSealedPlan(deps, planId);
    if (existing.ok) {
      if (
        existing.value.plan.generationToken !== envelope.plan.generationToken
      ) {
        const verified = verifyStoredExportPlan(
          envelope.plan,
          envelope.blobBytes,
          deps.now(),
        );
        if (!verified.ok || verified.value.planId !== planId)
          return writeFailed();
        await replaceVerifiedFile(
          deps,
          join(directory, PLAN_DOCUMENT_FILENAME),
          new TextEncoder().encode(canonicalizeJcs(envelope.plan)),
        );
      }
      await writePointer(deps, activePlanFile(deps), planId);
      return mdxRelayOk(planId);
    }
    await deps.fileSystem.removeRecursively(directory);
    await deps.fileSystem.removeRecursively(staging);

    await deps.fileSystem.makeDirectory(staging, OWNER_ONLY_DIRECTORY_MODE);
    const stagingBlobs = join(staging, PLAN_BLOB_DIRECTORY);
    await deps.fileSystem.makeDirectory(
      stagingBlobs,
      OWNER_ONLY_DIRECTORY_MODE,
    );
    for (const name of [...envelope.blobBytes.keys()].sort()) {
      if (!PLAN_BLOB_NAME_PATTERN.test(name))
        throw new Error("Unsafe blob name");
      await writeVerifiedFile(
        deps,
        join(stagingBlobs, name),
        envelope.blobBytes.get(name)!,
      );
    }
    await writeVerifiedFile(
      deps,
      join(staging, PLAN_DOCUMENT_FILENAME),
      new TextEncoder().encode(canonicalizeJcs(envelope.plan)),
    );
    await deps.fileSystem.syncDirectory(stagingBlobs);
    await deps.fileSystem.syncDirectory(staging);

    await deps.fileSystem.rename(staging, directory);
    await deps.fileSystem.syncDirectory(plansDirectory(deps));
  } catch {
    await discard(deps, [staging, directory]);
    return writeFailed();
  }

  const published = await loadSealedPlan(deps, planId);
  if (!published.ok) {
    await discard(deps, [staging, directory]);
    return writeFailed();
  }
  try {
    await writePointer(deps, activePlanFile(deps), planId);
  } catch {
    await discard(deps, [`${activePlanFile(deps)}${TEMPORARY_SUFFIX}`]);
    return writeFailed();
  }
  return mdxRelayOk(planId);
}

const discard = async (
  deps: PlanStoreDeps,
  paths: readonly string[],
): Promise<void> => {
  for (const path of paths) {
    try {
      await deps.fileSystem.removeRecursively(path);
    } catch {
      // A store that cannot clean up still must not report success.
    }
  }
};

/**
 * Records approval of the pinned active plan. The durable record is the exact
 * plan ID and nothing else; approving anything but the verified, unexpired,
 * currently pinned ready plan fails closed.
 */
export async function recordPlanApproval(
  deps: PlanStoreDeps,
  planId: PlanId,
): Promise<MdxRelayResult<PlanId>> {
  const loaded = await loadSealedPlan(deps, planId);
  if (!loaded.ok) return loaded;
  if (loaded.value.state !== "ready")
    return mdxRelayErr([createIssue(ISSUE_CODES.approvalMismatch)]);
  if ((await readPointer(deps, activePlanFile(deps))) !== planId)
    return mdxRelayErr([createIssue(ISSUE_CODES.staleApproval)]);
  try {
    await ensureOwnerOnlyDirectory(deps, approvalsDirectory(deps));
    await writePointer(deps, approvalFile(deps, planId), planId);
  } catch {
    await discard(deps, [
      `${approvalFile(deps, planId)}${TEMPORARY_SUFFIX}`,
      approvalFile(deps, planId),
    ]);
    return writeFailed();
  }
  return mdxRelayOk(planId);
}

export async function readPlanApproval(
  deps: PlanStoreDeps,
  planId: PlanId,
): Promise<MdxRelayResult<PlanId>> {
  if (!PLAN_ID_PATTERN.test(planId)) return notFound();
  const filePath = approvalFile(deps, planId);
  if ((await permissionBits(deps, filePath)) === undefined) return notFound();
  const recorded = await readPointer(deps, filePath);
  if (recorded === undefined) return tampered();
  return recorded === planId ? mdxRelayOk(planId) : tampered();
}

/**
 * Removes elapsed plans and abandoned staging directories, and unpins the
 * active plan when it is one of them. Plans that fail verification are left in
 * place: destroying them would destroy the evidence of the tampering.
 */
export async function cleanupExpiredPlans(
  deps: PlanStoreDeps,
): Promise<MdxRelayResult<readonly PlanId[]>> {
  const removed: PlanId[] = [];
  try {
    if ((await permissionBits(deps, plansDirectory(deps))) === undefined)
      return mdxRelayOk(Object.freeze([]));
    for (const name of await deps.fileSystem.listDirectory(
      plansDirectory(deps),
    )) {
      if (name.startsWith(STAGING_PREFIX)) {
        await deps.fileSystem.removeRecursively(
          join(plansDirectory(deps), name),
        );
        continue;
      }
      if (!PLAN_ID_PATTERN.test(name)) continue;
      const planId = name as PlanId;
      const loaded = await loadSealedPlan(deps, planId);
      if (loaded.ok || loaded.error[0].code !== ISSUE_CODES.planExpired)
        continue;
      await deps.fileSystem.removeRecursively(planDirectory(deps, planId));
      await deps.fileSystem.removeRecursively(approvalFile(deps, planId));
      removed.push(planId);
    }
    const active = await readPointer(deps, activePlanFile(deps));
    if (active !== undefined && removed.includes(active))
      await deps.fileSystem.removeRecursively(activePlanFile(deps));
  } catch {
    return writeFailed();
  }
  return mdxRelayOk(Object.freeze(removed));
}
