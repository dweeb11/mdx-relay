import type { PlanId, Sha256Digest } from "../contracts/export-plan";

/**
 * The private plan store's shape and its narrow filesystem boundary.
 *
 *   <root>/                       0700
 *     plans/                      0700
 *       <planId>/                 0700
 *         plan.json               0600   canonical JCS of the sealed plan
 *         blobs/                  0700
 *           <64 hex>              0600   one content-addressed sealed output
 *       .staging-<planId>/        0700   pre-publication only, never loaded
 *     approvals/                  0700
 *       <planId>.json             0600   the approved plan ID and nothing else
 *     active-plan.json            0600   the pinned plan ID
 *
 * Every operation goes through this interface so publication faults -- failed
 * writes, failed fsync, failed rename, a full disk, a lying hash, widened
 * permissions -- can be injected exactly where they would really occur.
 */

export const OWNER_ONLY_DIRECTORY_MODE = 0o700;
export const OWNER_ONLY_FILE_MODE = 0o600;

export const PLANS_DIRECTORY = "plans";
export const APPROVALS_DIRECTORY = "approvals";
export const PLAN_BLOB_DIRECTORY = "blobs";
export const PLAN_DOCUMENT_FILENAME = "plan.json";
export const ACTIVE_PLAN_FILENAME = "active-plan.json";
export const STAGING_PREFIX = ".staging-";
export const TEMPORARY_SUFFIX = ".tmp";

/** Sealed plan IDs are `plan-` plus the hex digest of their identity manifest. */
export const PLAN_ID_PATTERN = /^plan-[0-9a-f]{64}$/u;
/** Blob filenames are the lowercase hex digest of their own content. */
export const PLAN_BLOB_NAME_PATTERN = /^[0-9a-f]{64}$/u;

export interface PlanStoreFileHandle {
  write(bytes: Uint8Array): Promise<void>;
  /** Flushes this file's bytes and metadata to durable storage. */
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface PlanStoreFileSystem {
  /** Creates the directory and any missing parents with exactly `mode`. */
  makeDirectory(directoryPath: string, mode: number): Promise<void>;
  /** Exclusively creates a new file with exactly `mode`; fails if it exists. */
  openForWrite(filePath: string, mode: number): Promise<PlanStoreFileHandle>;
  /** Flushes a directory entry so a rename into it survives a crash. */
  syncDirectory(directoryPath: string): Promise<void>;
  rename(fromPath: string, toPath: string): Promise<void>;
  readFile(filePath: string): Promise<Uint8Array>;
  /**
   * Permission bits of the entry itself, never of a symlink target, so a
   * planted link reads back as widened permissions rather than as its target.
   */
  readPermissionBits(entryPath: string): Promise<number>;
  listDirectory(directoryPath: string): Promise<readonly string[]>;
  /** Removes a path and its contents; succeeds when the path is already gone. */
  removeRecursively(entryPath: string): Promise<void>;
}

export interface PlanStoreDeps {
  readonly rootDirectory: string;
  readonly fileSystem: PlanStoreFileSystem;
  readonly hash: (bytes: Uint8Array) => Sha256Digest;
  /** Current time as an ISO UTC instant with milliseconds. */
  readonly now: () => string;
  /** POSIX hosts enforce owner-only modes; Windows has no equivalent bits. */
  readonly enforceOwnerOnlyModes: boolean;
}

/** The only durable approval authority: an exact plan ID and nothing else. */
export interface StoredPlanPointer {
  readonly planId: PlanId;
}
