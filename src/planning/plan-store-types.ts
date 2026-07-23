import type { PlanId, Sha256Digest } from "../contracts/export-plan";
import { MDX_RELAY_LIMITS } from "../core/limits";

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

/**
 * A pointer holds one plan ID and nothing else, so its canonical JSON is
 * `{"planId":"plan-<64 hex>"}` -- 82 bytes. The ceiling triples that so a
 * malformed pointer is still readable as evidence and an inflated one is not.
 */
export const MAX_PLAN_POINTER_BYTES = 256;

/**
 * Generous per-record allowance for one sealed output, source image or
 * repository target as canonical JSON. Every such record is a fixed field set
 * of digests, byte lengths and bounded portable paths, so a few kilobytes is
 * far more than any honest record needs.
 */
const PLAN_DOCUMENT_RECORD_BYTES = 4096;
/**
 * Each bounded record can appear in the plan, its approval fingerprint, the
 * actions, the repository targets and the blob map; eight covers every one of
 * those positions with room to spare.
 */
const PLAN_DOCUMENT_RECORD_POSITIONS = 8;
/**
 * The largest plan document the store will read.
 *
 * A plan document is canonical JSON over one fixed field set, so its size is
 * the sum of parts that locked limits already bound: at most
 * `sealedOutputFiles` sealed outputs, source images and repository targets,
 * each a bounded record in a fixed number of positions, plus the profile and
 * dependency snapshots, neither of which can exceed the locked note budget.
 * Pricing that structure generously refuses no honest plan and never reads a
 * hostile document into memory.
 */
export const MAX_PLAN_DOCUMENT_BYTES =
  2 * MDX_RELAY_LIMITS.noteBytes +
  PLAN_DOCUMENT_RECORD_POSITIONS *
    MDX_RELAY_LIMITS.sealedOutputFiles *
    PLAN_DOCUMENT_RECORD_BYTES;

export interface PlanStoreFileHandle {
  write(bytes: Uint8Array): Promise<void>;
  /** Flushes this file's bytes and metadata to durable storage. */
  sync(): Promise<void>;
  close(): Promise<void>;
}

/**
 * One open entry a bounded read decides against. The size and the bytes come
 * from the same descriptor, so replacing the path after the size was taken
 * cannot enlarge what is allocated or read: the descriptor still refers to the
 * entry that was measured.
 */
export interface PlanStoreReadHandle {
  /** Byte length of the opened entry, taken from this descriptor. */
  readonly byteLength: number;
  /**
   * Reads exactly `byteLength` bytes from this descriptor. Returns `undefined`
   * when the entry no longer has exactly that length -- a short read or one
   * further readable byte is ambiguity, not data.
   */
  read(): Promise<Uint8Array | undefined>;
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
  /** Reads a file this store has just written, to re-hash what landed. */
  readFile(filePath: string): Promise<Uint8Array>;
  /**
   * Opens the entry itself, never a final symlink, and reports its size from
   * that same open descriptor. Every stored file the store did not just write
   * is read through this so its ceiling is decided against the bytes that will
   * actually be read rather than against a path that can be replaced in
   * between.
   */
  openForBoundedRead(filePath: string): Promise<PlanStoreReadHandle>;
  /**
   * Permission bits of the entry itself, never of a symlink target, so a
   * planted link reads back as widened permissions rather than as its target.
   */
  readPermissionBits(entryPath: string): Promise<number>;
  /**
   * Byte length of the entry itself, never of a symlink target, so an oversized
   * stored file is refused against the locked limits before any of it is read.
   */
  byteLength(entryPath: string): Promise<number>;
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
