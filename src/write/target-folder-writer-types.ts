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

export const TARGET_WRITE_TEMPORARY_SUFFIX = ".mdx-relay-write-tmp";

export type TargetEntryKind =
  | "absent"
  | "regularFile"
  | "directory"
  | "symlink"
  | "other";

export interface TargetEntryStat {
  readonly kind: Exclude<TargetEntryKind, "absent">;
  readonly byteLength: number;
}

export interface TargetFolderWriteHandle {
  write(bytes: Uint8Array): Promise<void>;
  /** Flushes this temporary file's bytes and metadata to durable storage. */
  sync(): Promise<void>;
  close(): Promise<void>;
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
  readFile(filePath: string): Promise<Uint8Array>;
  /** Creates the directory and any missing parents. */
  makeDirectory(directoryPath: string): Promise<void>;
  /** Exclusively creates a new temporary file; fails if it already exists. */
  openForWrite(filePath: string): Promise<TargetFolderWriteHandle>;
  rename(fromPath: string, toPath: string): Promise<void>;
  /** Removes a temporary path; succeeds when the path is already gone. */
  removeTemporary(entryPath: string): Promise<void>;
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
