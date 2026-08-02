import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  matchesApprovalContext,
  matchesPlanIdentity,
  type ExportAction,
  type Sha256Digest,
  type TargetPriorState,
} from "../contracts/export-plan";
import {
  createIssue,
  ISSUE_CODES,
  type BlockerIssue,
} from "../contracts/issues";
import { containsCredentialBearingOutput } from "./sealed-output-preflight";
import type {
  ApplyApprovedWritesInput,
  ApplyApprovedWritesResult,
  CompletedTargetWrite,
  FailedTargetWrite,
  OwnedTemporaryFile,
  TargetEntryIdentity,
  TargetEntryKind,
  TargetFolderWriterDeps,
  TargetFolderWriteReport,
  WritableExportPlan,
} from "./target-folder-writer-types";

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
    | typeof ISSUE_CODES.staleApproval
    | typeof ISSUE_CODES.credentialUrl,
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

const identitiesEqual = (
  left: TargetEntryIdentity,
  right: TargetEntryIdentity,
): boolean => left.deviceId === right.deviceId && left.inode === right.inode;

type LivePriorStateResult =
  | { readonly ok: true; readonly prior: TargetPriorState }
  | { readonly ok: false; readonly issue: BlockerIssue };

const isAbsent = async (
  deps: TargetFolderWriterDeps,
  entryPath: string,
): Promise<boolean> => {
  try {
    return (await deps.fileSystem.lstat(entryPath)).kind === "absent";
  } catch {
    return false;
  }
};

/**
 * Probes the live target. Every probe failure -- a racing unlink between the
 * stat and the read, a permission change, a hardware error -- becomes a
 * classified blocker instead of an escaping rejection, so the caller always
 * receives the completed/failed/unattempted partition.
 */
const readLivePriorState = async (
  deps: TargetFolderWriterDeps,
  absolutePath: string,
  relativePath: string,
): Promise<LivePriorStateResult> => {
  let stat;
  try {
    stat = await deps.fileSystem.lstat(absolutePath);
  } catch {
    return {
      ok: false,
      issue: issueAt(ISSUE_CODES.targetWriteFailed, relativePath),
    };
  }
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
  let bytes;
  try {
    bytes = await deps.fileSystem.readFile(absolutePath);
  } catch {
    // A target that vanished between the stat and the read changed under an
    // approval that assumed it; anything else is an unreadable target.
    return {
      ok: false,
      issue: issueAt(
        (await isAbsent(deps, absolutePath))
          ? ISSUE_CODES.targetChanged
          : ISSUE_CODES.targetWriteFailed,
        relativePath,
      ),
    };
  }
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

const collidesByCase = (
  entries: readonly string[],
  segment: string,
): boolean => {
  const wanted = segment.toLowerCase();
  return entries.some(
    (entry) => entry !== segment && entry.toLowerCase() === wanted,
  );
};

/**
 * Walks every segment of an approved relative path from the verified root.
 * Each existing ancestor must be a real directory, never a symlink, and on a
 * case-insensitive volume no segment -- not just the filename -- may differ
 * only by case from an entry that already exists in its parent.
 */
const assertPathSegmentsSafe = async (
  deps: TargetFolderWriterDeps,
  targetRootRealPath: string,
  relativePath: string,
): Promise<BlockerIssue | undefined> => {
  const segments = relativePath.split("/");
  let parent = targetRootRealPath;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (deps.caseSensitivity === "insensitive") {
      let entries: readonly string[];
      try {
        entries = await deps.fileSystem.listDirectory(parent);
      } catch {
        return issueAt(ISSUE_CODES.targetWriteFailed, relativePath);
      }
      if (collidesByCase(entries, segment))
        return issueAt(ISSUE_CODES.unsafeTarget, relativePath);
    }
    const current = join(parent, segment);
    let stat;
    try {
      stat = await deps.fileSystem.lstat(current);
    } catch {
      return issueAt(ISSUE_CODES.targetWriteFailed, relativePath);
    }
    // Nothing below an absent ancestor exists, so nothing below it can collide.
    if (stat.kind === "absent") return undefined;
    if (stat.kind === "symlink")
      return issueAt(ISSUE_CODES.unsafeTarget, relativePath);
    // The final segment's kind belongs to the prior-state probe.
    if (index === segments.length - 1) return undefined;
    if (stat.kind !== "directory")
      return issueAt(ISSUE_CODES.unsupportedTarget, relativePath);
    parent = current;
  }
  return undefined;
};

type ParentBinding =
  | { readonly ok: true; readonly identity: TargetEntryIdentity }
  | { readonly ok: false; readonly issue: BlockerIssue };

/**
 * Checks that the pathname we are about to mutate through still names the
 * directory that was verified. Node exposes no `openat`, so this is an identity
 * and real-path comparison rather than a descriptor-relative operation: it
 * detects an ancestor that was swapped for a symlink and fails closed before
 * any sealed byte is written, and it does not close the window between the
 * comparison and the syscall that follows it.
 */
const bindVerifiedParent = async (
  deps: TargetFolderWriterDeps,
  parentPath: string,
  relativePath: string,
  expected?: TargetEntryIdentity,
): Promise<ParentBinding> => {
  let stat;
  let realPath;
  try {
    stat = await deps.fileSystem.lstat(parentPath);
    if (stat.kind === "absent" || stat.kind === "symlink")
      return {
        ok: false,
        issue: issueAt(ISSUE_CODES.unsafeTarget, relativePath),
      };
    if (stat.kind !== "directory")
      return {
        ok: false,
        issue: issueAt(ISSUE_CODES.unsupportedTarget, relativePath),
      };
    realPath = await deps.fileSystem.realPath(parentPath);
  } catch {
    return {
      ok: false,
      issue: issueAt(ISSUE_CODES.targetWriteFailed, relativePath),
    };
  }
  if (
    realPath !== parentPath ||
    (expected !== undefined && !identitiesEqual(stat.identity, expected))
  )
    return {
      ok: false,
      issue: issueAt(ISSUE_CODES.unsafeTarget, relativePath),
    };
  return { ok: true, identity: stat.identity };
};

/**
 * Creates every missing ancestor of an approved target one level at a time,
 * each level verified against the identity of the parent checked immediately
 * before it. A recursive pathname `mkdir` would follow an ancestor swapped for
 * a symlink and build the whole subtree outside the configured root before any
 * later check could see it; here a swapped parent stops the invocation at that
 * level, with the level this writer created removed again.
 *
 * That is proportionate containment, not atomicity: one level of blast radius
 * and an empty-only cleanup, verified before and after each `mkdir`. Node has
 * no `mkdirat`, so a hostile process racing an individual syscall stays outside
 * V1's threat model per ADR 0003.
 *
 * Returns the verified identity of the directory the target will be written into.
 */
const ensureVerifiedDirectoryChain = async (
  deps: TargetFolderWriterDeps,
  targetRootRealPath: string,
  relativePath: string,
): Promise<ParentBinding> => {
  const segments = relativePath.split("/");
  let parentPath = targetRootRealPath;
  let binding = await bindVerifiedParent(deps, parentPath, relativePath);
  if (!binding.ok) return binding;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const name = segments[index]!;
    let outcome;
    try {
      outcome = await deps.fileSystem.createDirectoryIn(
        parentPath,
        binding.identity,
        name,
      );
    } catch {
      return {
        ok: false,
        issue: issueAt(ISSUE_CODES.targetWriteFailed, relativePath),
      };
    }
    if (outcome.kind === "unsafe")
      return {
        ok: false,
        issue: issueAt(ISSUE_CODES.unsafeTarget, relativePath),
      };
    if (outcome.kind === "unsupported")
      return {
        ok: false,
        issue: issueAt(ISSUE_CODES.unsupportedTarget, relativePath),
      };
    parentPath = join(parentPath, name);
    binding = { ok: true, identity: outcome.identity };
  }

  return bindVerifiedParent(deps, parentPath, relativePath, binding.identity);
};

/** The open temporary file must still be the entry at the path we will rename. */
const bindOwnedTemporary = async (
  deps: TargetFolderWriterDeps,
  temporary: OwnedTemporaryFile,
  relativePath: string,
): Promise<BlockerIssue | undefined> => {
  let stat;
  let openIdentity;
  try {
    stat = await deps.fileSystem.lstat(temporary.path);
    openIdentity = await temporary.handle.identity();
  } catch {
    return issueAt(ISSUE_CODES.targetWriteFailed, relativePath);
  }
  if (
    stat.kind !== "regularFile" ||
    !identitiesEqual(stat.identity, temporary.identity) ||
    !identitiesEqual(openIdentity, temporary.identity)
  )
    return issueAt(ISSUE_CODES.unsafeTarget, relativePath);
  return undefined;
};

/**
 * Copies the sealed bytes into writer-owned storage and validates the digest
 * over that copy. The caller keeps its own view: hashing what we will actually
 * persist is what makes a later mutation of the caller's buffer unable to
 * change the written file behind the reported digest.
 */
const materializeSealedBytes = (
  action: ExportAction,
  blobBytes: ReadonlyMap<string, Uint8Array>,
  hash: (bytes: Uint8Array) => Sha256Digest,
): Uint8Array | undefined => {
  const shared = blobBytes.get(action.sealedOutput.planRelativePath);
  if (shared === undefined) return undefined;
  const owned = new Uint8Array(shared);
  if (
    owned.byteLength !== action.sealedOutput.byteLength ||
    hash(owned) !== action.sealedOutput.contentSha256
  )
    return undefined;
  return owned;
};

const discardTemporary = async (
  deps: TargetFolderWriterDeps,
  temporary: OwnedTemporaryFile,
): Promise<void> => {
  await temporary.handle.close().catch(() => undefined);
  await deps.fileSystem
    .removeOwnedTemporary(temporary.path, temporary.identity)
    .catch(() => undefined);
};

/**
 * Final replacement.
 *
 * The verified parent binding and the live prior state are rechecked here,
 * immediately before the bytes land, so an approval that went stale while the
 * temporary file was staged fails instead of overwriting. A create then lands
 * its bytes with a create-only link, which refuses a target that appeared
 * during staging, and removes its own temporary afterwards -- a create is
 * complete only once that owned temporary is gone; an update lands its bytes
 * with a same-directory `rename`,
 * which replaces the target atomically -- a concurrent reader observes either
 * the whole prior file or the whole approved file, never a partial write, and
 * a crash never leaves the target truncated.
 *
 * This recheck is proportionate fail-closed revalidation, not a
 * compare-and-swap. Node offers no conditional rename, so a local process that
 * changes the pathname inside the window between the recheck and the rename is
 * not detected. Per ADR 0003 the target folder is not an adversarial
 * multi-writer boundary; accidental concurrent edits are what this catches.
 */
const replaceApprovedTarget = async (
  deps: TargetFolderWriterDeps,
  temporary: OwnedTemporaryFile,
  absolutePath: string,
  relativePath: string,
  approvedPrior: TargetPriorState,
): Promise<BlockerIssue | undefined> => {
  const parent = dirname(absolutePath);
  const stillBound = await bindVerifiedParent(deps, parent, relativePath);
  if (!stillBound.ok) {
    await discardTemporary(deps, temporary);
    return stillBound.issue;
  }
  const live = await readLivePriorState(deps, absolutePath, relativePath);
  if (!live.ok) {
    await discardTemporary(deps, temporary);
    return live.issue;
  }
  if (!priorStatesEqual(live.prior, approvedPrior)) {
    await discardTemporary(deps, temporary);
    return issueAt(ISSUE_CODES.targetChanged, relativePath);
  }

  if (approvedPrior.state === "absent") {
    let linked;
    try {
      linked = await deps.fileSystem.linkInto(temporary.path, absolutePath);
    } catch {
      await discardTemporary(deps, temporary);
      return issueAt(ISSUE_CODES.targetWriteFailed, relativePath);
    }
    if (!linked) {
      await discardTemporary(deps, temporary);
      return issueAt(ISSUE_CODES.targetChanged, relativePath);
    }
    // The approved bytes have landed under both names. Removing the
    // invocation-owned temporary is part of the write, not best-effort tidying:
    // if it fails, an unapproved pathname still holds the sealed bytes, so this
    // action is reported as failed. No rollback is claimed -- the approved
    // target keeps its correct bytes, and later actions stay unattempted. The
    // removal stays identity-bound, so a path that stopped being this
    // invocation's temporary is never unlinked.
    try {
      await deps.fileSystem.removeOwnedTemporary(
        temporary.path,
        temporary.identity,
      );
    } catch {
      return issueAt(ISSUE_CODES.targetWriteFailed, relativePath);
    }
    return undefined;
  }

  try {
    await deps.fileSystem.rename(temporary.path, absolutePath);
  } catch {
    await discardTemporary(deps, temporary);
    return issueAt(ISSUE_CODES.targetWriteFailed, relativePath);
  }
  return undefined;
};

const writeOneTarget = async (
  deps: TargetFolderWriterDeps,
  targetRootRealPath: string,
  absolutePath: string,
  relativePath: string,
  bytes: Uint8Array,
  approvedPrior: TargetPriorState,
): Promise<BlockerIssue | undefined> => {
  const parent = dirname(absolutePath);
  const bound = await ensureVerifiedDirectoryChain(
    deps,
    targetRootRealPath,
    relativePath,
  );
  if (!bound.ok) return bound.issue;

  let temporary: OwnedTemporaryFile;
  try {
    temporary = await deps.fileSystem.createTemporary(
      parent,
      basename(absolutePath),
    );
  } catch {
    return issueAt(ISSUE_CODES.targetWriteFailed, relativePath);
  }

  // The temporary is still empty here. An ancestor swapped between the check
  // above and the create is caught before a single sealed byte exists on disk.
  const staged = await bindVerifiedParent(
    deps,
    parent,
    relativePath,
    bound.identity,
  );
  if (!staged.ok) {
    await discardTemporary(deps, temporary);
    return staged.issue;
  }
  const ownership = await bindOwnedTemporary(deps, temporary, relativePath);
  if (ownership !== undefined) {
    await discardTemporary(deps, temporary);
    return ownership;
  }

  try {
    await temporary.handle.write(bytes);
    await temporary.handle.sync();
    await temporary.handle.close();
  } catch {
    await discardTemporary(deps, temporary);
    return issueAt(ISSUE_CODES.targetWriteFailed, relativePath);
  }

  return replaceApprovedTarget(
    deps,
    temporary,
    absolutePath,
    relativePath,
    approvedPrior,
  );
};

/**
 * Mutation authority gate. A verified plan is a plan whose bytes are trustworthy,
 * not permission to write it: the durable approval record for this exact plan ID
 * must still be readable, and a ready plan must still match the independently
 * recaptured approval context at the moment of the write.
 */
const gateApprovalAuthority = async (
  deps: TargetFolderWriterDeps,
  input: ApplyApprovedWritesInput,
  plan: WritableExportPlan,
): Promise<BlockerIssue | undefined> => {
  const mismatch = createIssue(ISSUE_CODES.approvalMismatch) as BlockerIssue;
  if (input.approval.planId !== plan.planId) return mismatch;
  if (!matchesPlanIdentity(input.approvalTransition, plan)) return mismatch;
  let recorded;
  try {
    recorded = await deps.readApproval(plan.planId);
  } catch {
    return mismatch;
  }
  if (!recorded.ok) return recorded.error[0];
  if (recorded.value !== plan.planId) return mismatch;
  if (plan.state === "no-changes") {
    // Nothing is mutated, so the recaptured fingerprint has nothing to guard.
    const now = Date.parse(deps.now());
    return Number.isNaN(now) ||
      now < Date.parse(plan.createdAtUtc) ||
      now >= Date.parse(plan.expiresAtUtc)
      ? mismatch
      : undefined;
  }
  return matchesApprovalContext(
    plan,
    input.approvalTransition,
    input.currentApprovalFingerprint,
    deps.now(),
  )
    ? undefined
    : mismatch;
};

type OutputPreflight =
  | { readonly ok: true; readonly bytes: ReadonlyMap<string, Uint8Array> }
  | {
      readonly ok: false;
      readonly targetPath: string;
      readonly issue: BlockerIssue;
    };

/**
 * Content gate over every sealed output, run once before the first mutation.
 *
 * Each action's bytes are copied into writer-owned storage and checked against
 * the sealed digest here, then inspected for credentials: a digest proves the
 * bytes are the approved ones, not that they are safe to write, and ADR 0003
 * requires credentials to be rejected even when they reach the output from
 * approved source content. One unsafe output fails the whole invocation, so no
 * approved sibling is written beside a rejected one.
 */
const preflightSealedOutputs = (
  actions: readonly ExportAction[],
  blobBytes: ReadonlyMap<string, Uint8Array>,
  hash: (bytes: Uint8Array) => Sha256Digest,
): OutputPreflight => {
  const owned = new Map<string, Uint8Array>();
  for (const action of actions) {
    const relativePath = action.targetPath;
    const bytes = materializeSealedBytes(action, blobBytes, hash);
    if (bytes === undefined)
      return {
        ok: false,
        targetPath: relativePath,
        issue: issueAt(ISSUE_CODES.targetWriteFailed, relativePath),
      };
    if (containsCredentialBearingOutput(bytes))
      return {
        ok: false,
        targetPath: relativePath,
        issue: issueAt(ISSUE_CODES.credentialUrl, relativePath),
      };
    owned.set(action.sealedOutput.planRelativePath, bytes);
  }
  return { ok: true, bytes: owned };
};

const applyOneAction = async (
  deps: TargetFolderWriterDeps,
  action: ExportAction,
  targetRootRealPath: string,
  blobBytes: ReadonlyMap<string, Uint8Array>,
): Promise<BlockerIssue | undefined> => {
  const relativePath = action.targetPath;
  const absolutePath = resolveContainedTargetPath(
    targetRootRealPath,
    relativePath,
  );
  if (absolutePath === undefined)
    return issueAt(ISSUE_CODES.unsafeTarget, relativePath);

  const segmentIssue = await assertPathSegmentsSafe(
    deps,
    targetRootRealPath,
    relativePath,
  );
  if (segmentIssue !== undefined) return segmentIssue;

  const live = await readLivePriorState(deps, absolutePath, relativePath);
  if (!live.ok) return live.issue;
  if (!priorStatesEqual(live.prior, action.approvedPriorTarget))
    return issueAt(ISSUE_CODES.targetChanged, relativePath);

  // Preflight already copied and digest-checked these bytes; a missing entry
  // here would mean the action set changed under us mid-invocation.
  const bytes = blobBytes.get(action.sealedOutput.planRelativePath);
  if (bytes === undefined)
    return issueAt(ISSUE_CODES.targetWriteFailed, relativePath);

  return writeOneTarget(
    deps,
    targetRootRealPath,
    absolutePath,
    relativePath,
    bytes,
    action.approvedPriorTarget,
  );
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

  const authorityIssue = await gateApprovalAuthority(deps, input, plan);
  if (authorityIssue !== undefined)
    return failure(
      [],
      [{ targetPath: "", issue: authorityIssue }],
      plan.actions.map((entry) => entry.targetPath),
    );

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

  let rootStat: { readonly kind: TargetEntryKind };
  try {
    rootStat = await deps.fileSystem.lstat(targetRootRealPath);
  } catch {
    const issue = createIssue(ISSUE_CODES.targetWriteFailed) as BlockerIssue;
    return failure([], [{ targetPath: "", issue }], []);
  }
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

  // Nothing is touched until every approved output has passed the content gate.
  const preflight = preflightSealedOutputs(actions, blobBytes, deps.hash);
  if (!preflight.ok)
    return failure(
      [],
      [{ targetPath: preflight.targetPath, issue: preflight.issue }],
      actions
        .map((entry) => entry.targetPath)
        .filter((targetPath) => targetPath !== preflight.targetPath),
    );
  const ownedBytes = preflight.bytes;

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]!;
    const remaining = () =>
      actions.slice(index + 1).map((entry) => entry.targetPath);
    const relativePath = action.targetPath;
    let issue: BlockerIssue | undefined;
    try {
      issue = await applyOneAction(
        deps,
        action,
        targetRootRealPath,
        ownedBytes,
      );
    } catch {
      // No filesystem surprise may escape as a rejection: the caller is owed
      // the completed/failed/unattempted partition in every outcome.
      issue = issueAt(ISSUE_CODES.targetWriteFailed, relativePath);
    }
    if (issue !== undefined)
      return failure(
        completed,
        [{ targetPath: relativePath, issue }],
        remaining(),
      );

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
export const isWritableTargetStat = (stat: {
  readonly kind: TargetEntryKind;
}): boolean => stat.kind === "absent" || stat.kind === "regularFile";
