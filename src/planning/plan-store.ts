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
import { dirname, join, resolve } from "node:path";

import type { PlanId } from "../contracts/export-plan";
import { createIssue, ISSUE_CODES } from "../contracts/issues";
import {
  mdxRelayErr,
  mdxRelayOk,
  type MdxRelayResult,
} from "../contracts/result";
import { MDX_RELAY_LIMITS } from "../core/limits";
import { sha256OfBytes, type PlanSourceBytes } from "./build-export-plan";
import {
  ACTIVE_PLAN_FILENAME,
  APPROVALS_DIRECTORY,
  MAX_PLAN_DOCUMENT_BYTES,
  MAX_PLAN_POINTER_BYTES,
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
  type PlanStoreReadHandle,
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
 *   fsync parent -> reload and verify -> pin active -> fsync root
 *
 * Nothing is ever published in place. A plan becomes visible only through the
 * single rename of a fully written, individually re-read and re-hashed staging
 * directory, and that rename is only trusted after the published plan loads and
 * verifies again. Any fault before that point leaves the store with no plan at
 * that ID at all; any fault after it removes the newly published directory and
 * restores the pin that was there before. Loading rechecks owner-only modes on
 * every directory and file it touches and refuses anything that exceeds the
 * locked limits before reading it, so widened permissions and hostile disk
 * state are tampering rather than a warning or an allocation.
 *
 * Every operation that changes what the store asserts -- publication, approval
 * and cleanup -- is serialized per store root, so an approval can never be
 * written against an active pin that a concurrent publication has already
 * replaced.
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
    async openForBoundedRead(filePath) {
      // O_NOFOLLOW refuses a final symlink outright, so a planted link is a
      // failed open rather than a read of whatever it points at.
      const handle = await open(
        filePath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      let byteLength: number;
      try {
        const stats = await handle.stat();
        byteLength = stats.isFile() ? stats.size : Number.NaN;
      } catch (error) {
        await handle.close();
        throw error;
      }
      return {
        byteLength,
        read: async () => {
          const bytes = new Uint8Array(byteLength);
          let filled = 0;
          while (filled < byteLength) {
            const { bytesRead } = await handle.read(
              bytes,
              filled,
              byteLength - filled,
              filled,
            );
            // A short read means the entry shrank under the descriptor.
            if (bytesRead === 0) return undefined;
            filled += bytesRead;
          }
          // One further readable byte means it grew; neither length is its size.
          const beyond = await handle.read(new Uint8Array(1), 0, 1, byteLength);
          return beyond.bytesRead === 0 ? bytes : undefined;
        },
        close: () => handle.close(),
      };
    },
    readPermissionBits: async (entryPath) =>
      (await lstat(entryPath)).mode & 0o777,
    byteLength: async (entryPath) => (await lstat(entryPath)).size,
    listDirectory: (directoryPath) => readdir(directoryPath),
    removeRecursively: (entryPath) =>
      rm(entryPath, { recursive: true, force: true }),
  };
}

/**
 * The one spelling of a store root. `/tmp/store`, `/tmp/store/.`, `/tmp//store`
 * and a relative root all address the same files, so they have to resolve to
 * the same identity or the per-root queue below would hand out one lock each
 * for the same store. Resolution is purely lexical against the process working
 * directory: a store root is a path contract, and walking symlinks here would
 * make the store's own identity depend on entries an attacker can plant where
 * the root does not exist yet.
 */
export function canonicalPlanStoreRoot(rootDirectory: string): string {
  return resolve(rootDirectory);
}

export function createPlanStoreDeps(
  rootDirectory: string = defaultPlanStoreRoot(),
): PlanStoreDeps {
  return Object.freeze({
    rootDirectory: canonicalPlanStoreRoot(rootDirectory),
    fileSystem: createNodePlanStoreFileSystem(),
    hash: sha256OfBytes,
    now: () => new Date().toISOString(),
    enforceOwnerOnlyModes: process.platform !== "win32",
  });
}

/**
 * One queue per store root. Publication, approval and cleanup take a turn on it
 * so their read-then-write sequences cannot interleave; loading stays outside
 * it because publication is atomic and a reader only ever sees one whole plan.
 * The key is the canonical root, so deps built from equivalent spellings of one
 * store share the queue that serializes them rather than each holding its own.
 */
const storeQueues = new Map<string, Promise<void>>();

const withStoreLock = async <T>(
  deps: PlanStoreDeps,
  operation: () => Promise<T>,
): Promise<T> => {
  const key = storeRoot(deps);
  const previous = storeQueues.get(key) ?? Promise.resolve();
  const running = previous.then(operation, operation);
  const settled = running.then(
    () => undefined,
    () => undefined,
  );
  storeQueues.set(key, settled);
  try {
    return await running;
  } finally {
    if (storeQueues.get(key) === settled) storeQueues.delete(key);
  }
};

/** Every path the store touches hangs off the one canonical root. */
const storeRoot = (deps: PlanStoreDeps): string =>
  canonicalPlanStoreRoot(deps.rootDirectory);
const plansDirectory = (deps: PlanStoreDeps): string =>
  join(storeRoot(deps), PLANS_DIRECTORY);
const planDirectory = (deps: PlanStoreDeps, planId: PlanId): string =>
  join(plansDirectory(deps), planId);
const approvalsDirectory = (deps: PlanStoreDeps): string =>
  join(storeRoot(deps), APPROVALS_DIRECTORY);
const approvalFile = (deps: PlanStoreDeps, planId: PlanId): string =>
  join(approvalsDirectory(deps), `${planId}.json`);
const activePlanFile = (deps: PlanStoreDeps): string =>
  join(storeRoot(deps), ACTIVE_PLAN_FILENAME);

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

/** Every directory above a pointer or approval must still be owner-only. */
const hasOwnerOnlyAncestry = async (
  deps: PlanStoreDeps,
  directoryPaths: readonly string[],
): Promise<boolean> => {
  for (const directoryPath of directoryPaths)
    if (
      !(await hasOwnerOnlyMode(deps, directoryPath, OWNER_ONLY_DIRECTORY_MODE))
    )
      return false;
  return true;
};

const ensureOwnerOnlyDirectory = async (
  deps: PlanStoreDeps,
  directoryPath: string,
): Promise<void> => {
  await deps.fileSystem.makeDirectory(directoryPath, OWNER_ONLY_DIRECTORY_MODE);
  if (!(await hasOwnerOnlyMode(deps, directoryPath, OWNER_ONLY_DIRECTORY_MODE)))
    throw new Error("Plan storage directory is not owner-only");
};

/**
 * Reads a stored file only after its own size clears the given ceiling, with
 * the size taken from the descriptor the bytes then come from. An entry swapped
 * for an oversized one after the ceiling was cleared is still the measured
 * entry to this descriptor, and one that never clears it is never allocated.
 */
const readBoundedFile = async (
  deps: PlanStoreDeps,
  filePath: string,
  maximumBytes: number,
): Promise<Uint8Array | undefined> => {
  let handle: PlanStoreReadHandle;
  try {
    handle = await deps.fileSystem.openForBoundedRead(filePath);
  } catch {
    return undefined;
  }
  try {
    const size = handle.byteLength;
    if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes)
      return undefined;
    const bytes = await handle.read();
    return bytes !== undefined && bytes.byteLength === size ? bytes : undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
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

/**
 * Publishes a pointer through a temporary file and a single rename, then
 * flushes the containing directory so the rename itself -- the active pin and
 * the durable approval authority -- survives a crash.
 */
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
  await deps.fileSystem.syncDirectory(dirname(filePath));
};

const readPointer = async (
  deps: PlanStoreDeps,
  filePath: string,
): Promise<PlanId | undefined> => {
  if (
    !(await hasOwnerOnlyAncestry(deps, [dirname(filePath)])) ||
    !(await hasOwnerOnlyMode(deps, filePath, OWNER_ONLY_FILE_MODE))
  )
    return undefined;
  try {
    const bytes = await readBoundedFile(deps, filePath, MAX_PLAN_POINTER_BYTES);
    if (bytes === undefined) return undefined;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
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
 * and every locked size limit before its bytes are trusted, and re-verifying
 * the whole plan afterwards. Supplying the live source bytes is what re-earns
 * the verified brand across a process or crash boundary; without them the
 * result is structurally proven and explicitly unbranded.
 */
export async function loadSealedPlan(
  deps: PlanStoreDeps,
  planId: PlanId,
  sourceBytes?: PlanSourceBytes,
): Promise<MdxRelayResult<SealedExportPlanEnvelope>> {
  if (!PLAN_ID_PATTERN.test(planId)) return notFound();
  const directory = planDirectory(deps, planId);
  if ((await permissionBits(deps, directory)) === undefined) return notFound();

  try {
    const blobDirectory = join(directory, PLAN_BLOB_DIRECTORY);
    if (
      !(await hasOwnerOnlyAncestry(deps, [
        storeRoot(deps),
        plansDirectory(deps),
        directory,
        blobDirectory,
      ]))
    )
      return tampered();

    const documentPath = join(directory, PLAN_DOCUMENT_FILENAME);
    if (!(await hasOwnerOnlyMode(deps, documentPath, OWNER_ONLY_FILE_MODE)))
      return tampered();

    // Hostile disk state is refused against the locked budgets in full before a
    // single blob is read: too many blobs, one oversized blob, or too many
    // bytes across all of them.
    const names = await deps.fileSystem.listDirectory(blobDirectory);
    if (names.length > MDX_RELAY_LIMITS.sealedOutputFiles) return tampered();

    let totalBlobBytes = 0;
    const sizes = new Map<string, number>();
    for (const name of names) {
      const blobPath = join(blobDirectory, name);
      if (
        !PLAN_BLOB_NAME_PATTERN.test(name) ||
        !(await hasOwnerOnlyMode(deps, blobPath, OWNER_ONLY_FILE_MODE))
      )
        return tampered();
      const size = await deps.fileSystem.byteLength(blobPath);
      if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > MDX_RELAY_LIMITS.sealedOutputBytes
      )
        return tampered();
      totalBlobBytes += size;
      if (totalBlobBytes > MDX_RELAY_LIMITS.totalSealedOutputBytes)
        return tampered();
      sizes.set(name, size);
    }

    const blobBytes = new Map<string, Uint8Array>();
    for (const [name, size] of sizes) {
      const bytes = await readBoundedFile(
        deps,
        join(blobDirectory, name),
        size,
      );
      if (bytes === undefined) return tampered();
      blobBytes.set(name, bytes);
    }

    const documentBytes = await readBoundedFile(
      deps,
      documentPath,
      MAX_PLAN_DOCUMENT_BYTES,
    );
    if (documentBytes === undefined) return tampered();
    const document: unknown = JSON.parse(
      new TextDecoder().decode(documentBytes),
    );
    const verified = verifyStoredExportPlan(
      document,
      blobBytes,
      deps.now(),
      sourceBytes,
    );
    if (!verified.ok) return verified;
    return verified.value.planId === planId ? verified : tampered();
  } catch {
    return tampered();
  }
}

export async function loadActivePlan(
  deps: PlanStoreDeps,
  sourceBytes?: PlanSourceBytes,
): Promise<MdxRelayResult<SealedExportPlanEnvelope>> {
  if ((await permissionBits(deps, storeRoot(deps))) === undefined)
    return notFound();
  if (!(await hasOwnerOnlyAncestry(deps, [storeRoot(deps)]))) return tampered();
  const planId = await readPointer(deps, activePlanFile(deps));
  return planId === undefined
    ? notFound()
    : loadSealedPlan(deps, planId, sourceBytes);
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
 * Puts the pin back exactly as it was when a publication that moved it failed.
 * Reporting failure while the store still points at the plan that failed would
 * be the one outcome worse than either clean state.
 */
const restoreActivePin = async (
  deps: PlanStoreDeps,
  planId: PlanId,
  previousActive: PlanId | undefined,
): Promise<void> => {
  if ((await readPointer(deps, activePlanFile(deps))) !== planId) return;
  try {
    if (previousActive === undefined)
      await deps.fileSystem.removeRecursively(activePlanFile(deps));
    else await writePointer(deps, activePlanFile(deps), previousActive);
  } catch {
    // An unpinnable store fails closed on the next load rather than lying now.
  }
};

/**
 * Puts the exact prior plan document back after a generation refresh that was
 * committed and then failed. A refresh the caller was told failed must not stay
 * loadable, so the restoration is verified too: if the prior bytes cannot be
 * put back and proven, the plan directory goes instead. Destroying a derived,
 * expiring plan is recoverable by re-planning; leaving a generation the store
 * reported as failed available to approve is not.
 */
const rollbackRefreshedDocument = async (
  deps: PlanStoreDeps,
  planId: PlanId,
  priorDocumentBytes: Uint8Array,
  priorGenerationToken: string,
): Promise<MdxRelayResult<never>> => {
  const directory = planDirectory(deps, planId);
  const documentPath = join(directory, PLAN_DOCUMENT_FILENAME);
  try {
    await replaceVerifiedFile(deps, documentPath, priorDocumentBytes);
    const restored = await loadSealedPlan(deps, planId);
    if (
      restored.ok &&
      restored.value.plan.generationToken === priorGenerationToken
    )
      return writeFailed();
  } catch {
    // Falls through to removal: an unprovable restoration is not a restoration.
  }
  await discard(deps, [`${documentPath}${TEMPORARY_SUFFIX}`, directory]);
  return writeFailed();
};

/**
 * Re-pins a plan that is already published at this content-derived ID. The ID
 * excludes the generation token, so the same identity can arrive from a later
 * generation; the stored document is then replaced through one atomic rename.
 * The replacement is only real once the refreshed plan has been reloaded and
 * verified and the active pin has been published, so every failure after the
 * rename puts the prior document and the prior pin back before reporting it.
 */
const repinPublishedPlan = async (
  deps: PlanStoreDeps,
  envelope: SealedExportPlanEnvelope,
  storedGenerationToken: string,
  documentBytes: Uint8Array,
): Promise<MdxRelayResult<PlanId>> => {
  const { planId } = envelope;
  const directory = planDirectory(deps, planId);
  const documentPath = join(directory, PLAN_DOCUMENT_FILENAME);
  const temporaryDocument = `${documentPath}${TEMPORARY_SUFFIX}`;
  const refreshing = storedGenerationToken !== envelope.plan.generationToken;

  let priorDocumentBytes: Uint8Array | undefined;
  if (refreshing) {
    // Nothing is replaced until the bytes that would undo it are in hand.
    priorDocumentBytes = await readBoundedFile(
      deps,
      documentPath,
      MAX_PLAN_DOCUMENT_BYTES,
    );
    if (priorDocumentBytes === undefined) return writeFailed();
    try {
      await replaceVerifiedFile(deps, documentPath, documentBytes);
    } catch {
      await discard(deps, [temporaryDocument]);
      return writeFailed();
    }
    const replaced = await loadSealedPlan(deps, planId);
    if (
      !replaced.ok ||
      replaced.value.plan.generationToken !== envelope.plan.generationToken
    )
      return rollbackRefreshedDocument(
        deps,
        planId,
        priorDocumentBytes,
        storedGenerationToken,
      );
  }

  const previousActive = await readPointer(deps, activePlanFile(deps));
  try {
    await writePointer(deps, activePlanFile(deps), planId);
  } catch {
    await discard(deps, [`${activePlanFile(deps)}${TEMPORARY_SUFFIX}`]);
    await restoreActivePin(deps, planId, previousActive);
    // Without a refresh the plan here was already valid before this call, so it
    // is kept; with one, the generation this call wrote never became real.
    return priorDocumentBytes === undefined
      ? writeFailed()
      : rollbackRefreshedDocument(
          deps,
          planId,
          priorDocumentBytes,
          storedGenerationToken,
        );
  }
  return mdxRelayOk(planId);
};

const publishNewPlan = async (
  deps: PlanStoreDeps,
  envelope: SealedExportPlanEnvelope,
  documentBytes: Uint8Array,
): Promise<MdxRelayResult<PlanId>> => {
  const { planId } = envelope;
  const directory = planDirectory(deps, planId);
  const staging = join(plansDirectory(deps), `${STAGING_PREFIX}${planId}`);
  const previousActive = await readPointer(deps, activePlanFile(deps));
  try {
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
      documentBytes,
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
    // The pin is what makes a publication real. A plan that could not be pinned
    // must not stay loadable behind the failure the caller was handed, and the
    // pin that was there before this call must survive it unchanged.
    await discard(deps, [`${activePlanFile(deps)}${TEMPORARY_SUFFIX}`]);
    await restoreActivePin(deps, planId, previousActive);
    await discard(deps, [directory]);
    return writeFailed();
  }
  return mdxRelayOk(planId);
};

/**
 * Publishes a sealed plan atomically and pins it as the active plan. Returns a
 * write failure -- never a plan ID -- if any step of the sequence fails, and
 * leaves nothing newly loadable at that ID when it does. Only a plan whose
 * source bytes were recomputed and matched is publishable at all.
 */
export async function publishSealedPlan(
  deps: PlanStoreDeps,
  envelope: SealedExportPlanEnvelope,
): Promise<MdxRelayResult<PlanId>> {
  const { planId } = envelope;
  if (!PLAN_ID_PATTERN.test(planId) || !envelope.sourceBytesVerified)
    return writeFailed();
  if (Date.parse(deps.now()) >= Date.parse(envelope.plan.expiresAtUtc))
    return mdxRelayErr([createIssue(ISSUE_CODES.planExpired)]);

  return withStoreLock(deps, async () => {
    let documentBytes: Uint8Array;
    try {
      documentBytes = new TextEncoder().encode(canonicalizeJcs(envelope.plan));
      await ensureOwnerOnlyDirectory(deps, storeRoot(deps));
      await ensureOwnerOnlyDirectory(deps, plansDirectory(deps));
      await ensureOwnerOnlyDirectory(deps, approvalsDirectory(deps));
    } catch {
      return writeFailed();
    }
    const existing = await loadSealedPlan(deps, planId);
    return existing.ok
      ? repinPublishedPlan(
          deps,
          envelope,
          existing.value.plan.generationToken,
          documentBytes,
        )
      : publishNewPlan(deps, envelope, documentBytes);
  });
}

/**
 * Records approval of the pinned active plan. The durable record is the exact
 * plan ID and nothing else; approving anything but the verified, unexpired,
 * currently pinned ready plan whose source bytes were just recomputed fails
 * closed. Serialization with publication is what makes the pin it read still
 * the pin when the approval lands.
 */
export async function recordPlanApproval(
  deps: PlanStoreDeps,
  planId: PlanId,
  sourceBytes: PlanSourceBytes,
): Promise<MdxRelayResult<PlanId>> {
  return withStoreLock(deps, async () => {
    const loaded = await loadSealedPlan(deps, planId, sourceBytes);
    if (!loaded.ok) return loaded;
    if (loaded.value.state !== "ready" || !loaded.value.sourceBytesVerified)
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
  });
}

export async function readPlanApproval(
  deps: PlanStoreDeps,
  planId: PlanId,
): Promise<MdxRelayResult<PlanId>> {
  if (!PLAN_ID_PATTERN.test(planId)) return notFound();
  const filePath = approvalFile(deps, planId);
  if ((await permissionBits(deps, filePath)) === undefined) return notFound();
  if (
    !(await hasOwnerOnlyAncestry(deps, [
      storeRoot(deps),
      approvalsDirectory(deps),
    ]))
  )
    return tampered();
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
  return withStoreLock(deps, async () => {
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
  });
}
