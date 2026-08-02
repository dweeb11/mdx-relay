import { dirname, join, relative, resolve, sep } from "node:path";

import type {
  ExportAction,
  Sha256Digest,
  TargetPriorState,
} from "../contracts/export-plan";
import {
  createIssue,
  ISSUE_CODES,
  type BlockerIssue,
} from "../contracts/issues";
import type {
  ApplyApprovedWritesInput,
  ApplyApprovedWritesResult,
  CompletedTargetWrite,
  FailedTargetWrite,
  TargetEntryStat,
  TargetFolderWriterDeps,
  TargetFolderWriteReport,
} from "./target-folder-writer-types";
import { TARGET_WRITE_TEMPORARY_SUFFIX } from "./target-folder-writer-types";

const freezeReport = (
  completed: readonly CompletedTargetWrite[],
  failed: readonly FailedTargetWrite[],
  unattempted: readonly string[],
): TargetFolderWriteReport =>
  Object.freeze({
    completed: Object.freeze([...completed]),
    failed: Object.freeze([...failed]),
    unattempted: Object.freeze([...unattempted]),
  });

const success = (
  completed: readonly CompletedTargetWrite[],
): ApplyApprovedWritesResult =>
  Object.freeze({
    ok: true as const,
    report: freezeReport(completed, [], []),
  });

const failure = (
  completed: readonly CompletedTargetWrite[],
  failed: readonly FailedTargetWrite[],
  unattempted: readonly string[],
): ApplyApprovedWritesResult => {
  const issues = failed.map((entry) => entry.issue);
  if (issues.length === 0)
    throw new TypeError("Write failure requires at least one issue.");
  return Object.freeze({
    ok: false as const,
    report: freezeReport(completed, failed, unattempted),
    error: Object.freeze([...issues]) as readonly [
      BlockerIssue,
      ...BlockerIssue[],
    ],
  });
};

const issueAt = (
  code:
    | typeof ISSUE_CODES.unsafeTarget
    | typeof ISSUE_CODES.unsupportedTarget
    | typeof ISSUE_CODES.targetChanged
    | typeof ISSUE_CODES.targetWriteFailed
    | typeof ISSUE_CODES.staleApproval,
  targetPath: string,
): BlockerIssue =>
  createIssue(code, {}, { safePathLabel: targetPath }) as BlockerIssue;

const endsWithSeparator = (value: string): boolean =>
  value.endsWith("/") || value.endsWith("\\");

/**
 * Lexical containment under a resolved real root. Rejects absolute relatives,
 * empty segments, `.`/`..`, and any path that does not stay beneath the root
 * after `resolve`.
 */
export const resolveContainedTargetPath = (
  targetRootRealPath: string,
  relativePath: string,
): string | undefined => {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath
      .split("/")
      .some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      )
  )
    return undefined;
  const absolute = resolve(targetRootRealPath, ...relativePath.split("/"));
  const rootWithSep = endsWithSeparator(targetRootRealPath)
    ? targetRootRealPath
    : `${targetRootRealPath}${sep}`;
  if (absolute !== targetRootRealPath && !absolute.startsWith(rootWithSep))
    return undefined;
  const normalizedRelative = relative(targetRootRealPath, absolute);
  if (
    normalizedRelative.startsWith("..") ||
    normalizedRelative.split(sep).includes("..") ||
    normalizedRelative !== relativePath.split("/").join(sep)
  )
    return undefined;
  return absolute;
};

const priorStatesEqual = (
  left: TargetPriorState,
  right: TargetPriorState,
): boolean => {
  if (left.state !== right.state) return false;
  if (left.state === "absent") return true;
  return (
    right.state === "regularFile" && left.contentSha256 === right.contentSha256
  );
};

const readLivePriorState = async (
  deps: TargetFolderWriterDeps,
  absolutePath: string,
  relativePath: string,
): Promise<
  | { readonly ok: true; readonly prior: TargetPriorState }
  | { readonly ok: false; readonly issue: BlockerIssue }
> => {
  const stat = await deps.fileSystem.lstat(absolutePath);
  if (stat.kind === "absent") return { ok: true, prior: { state: "absent" } };
  if (stat.kind === "symlink")
    return {
      ok: false,
      issue: issueAt(ISSUE_CODES.unsafeTarget, relativePath),
    };
  if (stat.kind === "directory" || stat.kind === "other")
    return {
      ok: false,
      issue: issueAt(ISSUE_CODES.unsupportedTarget, relativePath),
    };
  const bytes = await deps.fileSystem.readFile(absolutePath);
  if (bytes.byteLength !== stat.byteLength)
    return {
      ok: false,
      issue: issueAt(ISSUE_CODES.targetChanged, relativePath),
    };
  return {
    ok: true,
    prior: {
      state: "regularFile",
      contentSha256: deps.hash(bytes),
    },
  };
};

const assertAncestorSafety = async (
  deps: TargetFolderWriterDeps,
  targetRootRealPath: string,
  relativePath: string,
): Promise<BlockerIssue | undefined> => {
  const segments = relativePath.split("/");
  let current = targetRootRealPath;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = join(current, segments[index]!);
    const stat = await deps.fileSystem.lstat(current);
    if (stat.kind === "absent") return undefined;
    if (stat.kind === "symlink")
      return issueAt(ISSUE_CODES.unsafeTarget, relativePath);
    if (stat.kind !== "directory")
      return issueAt(ISSUE_CODES.unsupportedTarget, relativePath);
  }
  return undefined;
};

const detectCaseCollision = async (
  deps: TargetFolderWriterDeps,
  parentDirectory: string,
  fileName: string,
  relativePath: string,
): Promise<BlockerIssue | undefined> => {
  if (deps.caseSensitivity === "sensitive") return undefined;
  let entries: readonly string[];
  try {
    entries = await deps.fileSystem.listDirectory(parentDirectory);
  } catch {
    const parentStat = await deps.fileSystem.lstat(parentDirectory);
    if (parentStat.kind === "absent") return undefined;
    return issueAt(ISSUE_CODES.targetWriteFailed, relativePath);
  }
  const wanted = fileName.toLowerCase();
  for (const entry of entries) {
    if (entry === fileName) continue;
    if (entry.toLowerCase() === wanted)
      return issueAt(ISSUE_CODES.unsafeTarget, relativePath);
  }
  return undefined;
};

const sealedBytesForAction = (
  action: ExportAction,
  blobBytes: ReadonlyMap<string, Uint8Array>,
  hash: (bytes: Uint8Array) => Sha256Digest,
): Uint8Array | undefined => {
  const bytes = blobBytes.get(action.sealedOutput.planRelativePath);
  if (
    bytes === undefined ||
    bytes.byteLength !== action.sealedOutput.byteLength ||
    hash(bytes) !== action.sealedOutput.contentSha256
  )
    return undefined;
  return bytes;
};

const writeOneTarget = async (
  deps: TargetFolderWriterDeps,
  absolutePath: string,
  relativePath: string,
  bytes: Uint8Array,
): Promise<BlockerIssue | undefined> => {
  const temporaryPath = `${absolutePath}${TARGET_WRITE_TEMPORARY_SUFFIX}`;
  await deps.fileSystem.removeTemporary(temporaryPath);
  const parent = dirname(absolutePath);
  try {
    await deps.fileSystem.makeDirectory(parent);
  } catch {
    return issueAt(ISSUE_CODES.targetWriteFailed, relativePath);
  }
  let handle;
  try {
    handle = await deps.fileSystem.openForWrite(temporaryPath);
  } catch {
    return issueAt(ISSUE_CODES.targetWriteFailed, relativePath);
  }
  try {
    try {
      await handle.write(bytes);
      await handle.sync();
    } catch {
      await handle.close().catch(() => undefined);
      await deps.fileSystem
        .removeTemporary(temporaryPath)
        .catch(() => undefined);
      return issueAt(ISSUE_CODES.targetWriteFailed, relativePath);
    }
    try {
      await handle.close();
    } catch {
      await deps.fileSystem
        .removeTemporary(temporaryPath)
        .catch(() => undefined);
      return issueAt(ISSUE_CODES.targetWriteFailed, relativePath);
    }
    try {
      await deps.fileSystem.rename(temporaryPath, absolutePath);
    } catch {
      await deps.fileSystem
        .removeTemporary(temporaryPath)
        .catch(() => undefined);
      return issueAt(ISSUE_CODES.targetWriteFailed, relativePath);
    }
    return undefined;
  } catch {
    await deps.fileSystem.removeTemporary(temporaryPath).catch(() => undefined);
    return issueAt(ISSUE_CODES.targetWriteFailed, relativePath);
  }
};

/**
 * Applies only the approved create/update actions from a sealed plan beneath
 * the configured local target root. Never deletes, never rediscovers bytes,
 * and never invokes Git. Multi-file partial failure is reported truthfully.
 */
export async function applyApprovedWrites(
  input: ApplyApprovedWritesInput,
  deps: TargetFolderWriterDeps,
): Promise<ApplyApprovedWritesResult> {
  const { plan, blobBytes, configuredTargetRoot } = input;
  const snapshot = plan.targetFolderSnapshot;

  if (deps.caseSensitivity !== snapshot.caseSensitivity) {
    const issue = createIssue(ISSUE_CODES.staleApproval) as BlockerIssue;
    return failure([], [{ targetPath: "", issue }], []);
  }

  let targetRootRealPath: string;
  try {
    targetRootRealPath =
      await deps.fileSystem.resolveTargetRoot(configuredTargetRoot);
  } catch {
    const issue = createIssue(ISSUE_CODES.unsafeTarget) as BlockerIssue;
    return failure([], [{ targetPath: "", issue }], []);
  }

  if (targetRootRealPath !== snapshot.targetRootRealPath) {
    const issue = createIssue(ISSUE_CODES.staleApproval) as BlockerIssue;
    return failure([], [{ targetPath: "", issue }], []);
  }

  const rootStat = await deps.fileSystem.lstat(targetRootRealPath);
  if (rootStat.kind === "symlink") {
    const issue = createIssue(ISSUE_CODES.unsafeTarget) as BlockerIssue;
    return failure([], [{ targetPath: "", issue }], []);
  }
  if (rootStat.kind !== "directory") {
    const issue = createIssue(ISSUE_CODES.unsupportedTarget) as BlockerIssue;
    return failure([], [{ targetPath: "", issue }], []);
  }

  if (plan.state === "no-changes") {
    if (plan.actions.length !== 0 || snapshot.targets.length !== 0) {
      const issue = createIssue(ISSUE_CODES.staleApproval) as BlockerIssue;
      return failure([], [{ targetPath: "", issue }], []);
    }
    return success([]);
  }

  const completed: CompletedTargetWrite[] = [];
  const actions = plan.actions;

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]!;
    const remaining = () =>
      actions.slice(index + 1).map((entry) => entry.targetPath);
    const relativePath = action.targetPath;
    const absolutePath = resolveContainedTargetPath(
      targetRootRealPath,
      relativePath,
    );
    if (absolutePath === undefined) {
      return failure(
        completed,
        [
          {
            targetPath: relativePath,
            issue: issueAt(ISSUE_CODES.unsafeTarget, relativePath),
          },
        ],
        remaining(),
      );
    }

    const ancestorIssue = await assertAncestorSafety(
      deps,
      targetRootRealPath,
      relativePath,
    );
    if (ancestorIssue !== undefined) {
      return failure(
        completed,
        [{ targetPath: relativePath, issue: ancestorIssue }],
        remaining(),
      );
    }

    const collisionIssue = await detectCaseCollision(
      deps,
      dirname(absolutePath),
      relativePath.split("/").at(-1)!,
      relativePath,
    );
    if (collisionIssue !== undefined) {
      return failure(
        completed,
        [{ targetPath: relativePath, issue: collisionIssue }],
        remaining(),
      );
    }

    const live = await readLivePriorState(deps, absolutePath, relativePath);
    if (!live.ok) {
      return failure(
        completed,
        [{ targetPath: relativePath, issue: live.issue }],
        remaining(),
      );
    }
    if (!priorStatesEqual(live.prior, action.approvedPriorTarget)) {
      return failure(
        completed,
        [
          {
            targetPath: relativePath,
            issue: issueAt(ISSUE_CODES.targetChanged, relativePath),
          },
        ],
        remaining(),
      );
    }

    const bytes = sealedBytesForAction(action, blobBytes, deps.hash);
    if (bytes === undefined) {
      return failure(
        completed,
        [
          {
            targetPath: relativePath,
            issue: issueAt(ISSUE_CODES.targetWriteFailed, relativePath),
          },
        ],
        remaining(),
      );
    }

    const writeIssue = await writeOneTarget(
      deps,
      absolutePath,
      relativePath,
      bytes,
    );
    if (writeIssue !== undefined) {
      return failure(
        completed,
        [{ targetPath: relativePath, issue: writeIssue }],
        remaining(),
      );
    }

    completed.push(
      Object.freeze({
        targetPath: relativePath,
        contentSha256: action.sealedOutput.contentSha256,
        byteLength: action.sealedOutput.byteLength,
        kind: action.kind,
      }),
    );
  }

  return success(completed);
}

/** Pure helper exported for unit tests: classify an lstat kind for prior checks. */
export const isWritableTargetStat = (
  stat: TargetEntryStat | { readonly kind: "absent" },
): boolean => stat.kind === "absent" || stat.kind === "regularFile";
