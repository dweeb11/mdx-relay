import type {
  ExportAction,
  NoChangesExportPlan,
  Sha256Digest,
  TargetFolderSnapshot,
  VerifiedReadyExportPlan,
} from "../contracts/export-plan";
import type { BlockerIssue } from "../contracts/issues";

/**
 * Narrow filesystem boundary for approved target-folder writes.
 *
 * Every mutating and probing call goes through this interface so tests can
 * inject permission, disk-full, temporary-write, close, and rename failures
 * exactly where they would occur on a real host. The adapter never invokes
 * Git and never deletes approved targets.
 */

/** Marker embedded in every temporary name; the name itself is never reused. */
export const TARGET_WRITE_TEMPORARY_SUFFIX = ".mdx-relay-write-tmp";

export type TargetEntryKind =
  | "absent"
  | "regularFile"
  | "directory"
  | "symlink"
  | "other";

/**
 * Filesystem identity of the entry itself. Node exposes no `openat`/`renameat`,
 * so device and inode are how a mutation is bound to the exact directory and
 * file that were verified rather than to a pathname another process can swap
 * for a symlink between the check and the write.
 */
export interface TargetEntryIdentity {
  readonly deviceId: string;
  readonly inode: string;
}

export interface TargetEntryStat {
  readonly kind: Exclude<TargetEntryKind, "absent">;
  readonly byteLength: number;
  readonly identity: TargetEntryIdentity;
}

export interface TargetFolderWriteHandle {
  /**
   * Writes every byte of the buffer. Short writes are retried until the whole
   * buffer is persisted, so a completed write never means a truncated file.
   */
  write(bytes: Uint8Array): Promise<void>;
  /** Identity of the open file itself, used to bind the handle to its path. */
  identity(): Promise<TargetEntryIdentity>;
  /** Flushes this temporary file's bytes and metadata to durable storage. */
  sync(): Promise<void>;
  close(): Promise<void>;
}

/**
 * A temporary file this invocation exclusively created and therefore owns. Only
 * this exact path and identity may be cleaned up; a pre-existing unapproved
 * file at a guessable temporary name is never touched.
 */
export interface OwnedTemporaryFile {
  readonly path: string;
  readonly identity: TargetEntryIdentity;
  readonly handle: TargetFolderWriteHandle;
}

export interface TargetFolderFileSystem {
  /**
   * Resolves the configured target root without trusting a final symlink.
   * Returns the real path spelling used for containment checks.
   */
  resolveTargetRoot(configuredRoot: string): Promise<string>;
  /**
   * Stats the entry itself, never a final symlink target. Missing paths return
   * `absent` rather than throwing.
   */
  lstat(
    entryPath: string,
  ): Promise<TargetEntryStat | { readonly kind: "absent" }>;
  /**
   * Fully resolved real path of an existing entry. A verified directory whose
   * real path stops matching its own pathname had an ancestor swapped.
   */
  realPath(entryPath: string): Promise<string>;
  readFile(filePath: string): Promise<Uint8Array>;
  /** Creates the directory and any missing parents. */
  makeDirectory(directoryPath: string): Promise<void>;
  /**
   * Exclusively creates an empty temporary file under a unique unguessable name
   * inside `directoryPath`. Never opens an existing entry and never follows a
   * final symlink, so the returned file belongs to this invocation alone.
   */
  createTemporary(
    directoryPath: string,
    baseName: string,
  ): Promise<OwnedTemporaryFile>;
  rename(fromPath: string, toPath: string): Promise<void>;
  /**
   * Hard-links `fromPath` at `toPath` without ever replacing an existing entry.
   * Resolves `false` when `toPath` already exists, which is how a create action
   * detects a target that appeared after approval.
   */
  linkInto(fromPath: string, toPath: string): Promise<boolean>;
  /**
   * Removes an owned temporary path, and only while it is still that exact
   * entry. Succeeds when the path is already gone.
   */
  removeOwnedTemporary(
    entryPath: string,
    identity: TargetEntryIdentity,
  ): Promise<void>;
  listDirectory(directoryPath: string): Promise<readonly string[]>;
}

export interface TargetFolderWriterDeps {
  readonly fileSystem: TargetFolderFileSystem;
  readonly hash: (bytes: Uint8Array) => Sha256Digest;
  /**
   * Live case-sensitivity of the target volume. Must equal the sealed plan's
   * `targetFolderSnapshot.caseSensitivity` or approval is stale.
   */
  readonly caseSensitivity: TargetFolderSnapshot["caseSensitivity"];
}

export type WritableExportPlan = VerifiedReadyExportPlan | NoChangesExportPlan;

export interface ApplyApprovedWritesInput {
  readonly plan: WritableExportPlan;
  /** Content-addressed sealed bytes keyed by `planRelativePath` (hex digest). */
  readonly blobBytes: ReadonlyMap<string, Uint8Array>;
  /** Machine-binding target root that must resolve to the sealed real path. */
  readonly configuredTargetRoot: string;
}

export interface CompletedTargetWrite {
  readonly targetPath: string;
  readonly contentSha256: Sha256Digest;
  readonly byteLength: number;
  readonly kind: ExportAction["kind"];
}

export interface FailedTargetWrite {
  readonly targetPath: string;
  readonly issue: BlockerIssue;
}

/**
 * Truthful multi-file write partition. Partial failure never claims rollback:
 * completed paths stay written, failed paths keep their prior bytes when the
 * failure happened before rename, and later actions remain unattempted.
 */
export interface TargetFolderWriteReport {
  readonly completed: readonly CompletedTargetWrite[];
  readonly failed: readonly FailedTargetWrite[];
  readonly unattempted: readonly string[];
}

export type ApplyApprovedWritesResult =
  | Readonly<{
      ok: true;
      report: TargetFolderWriteReport;
    }>
  | Readonly<{
      ok: false;
      report: TargetFolderWriteReport;
      error: readonly [BlockerIssue, ...BlockerIssue[]];
    }>;
