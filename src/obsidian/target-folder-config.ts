import { lstat } from "node:fs/promises";

import { isSafeAbsoluteTargetRoot } from "../profiles/machine-binding";

export type TargetFolderConfigProblem =
  | "empty"
  | "tilde"
  | "relative"
  | "unsafe"
  | "missing"
  | "inaccessible"
  | "not-directory"
  | "symlink";

export type TargetFolderConfigStatus =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: TargetFolderConfigProblem };

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;

/**
 * Synchronous shape checks for a configured target folder. `~` is never
 * expanded; relative paths are refused rather than resolved against cwd.
 */
export function classifyTargetFolderConfig(
  value: string,
): TargetFolderConfigStatus {
  if (value.length === 0) return { ok: false, problem: "empty" };
  if (value.startsWith("~")) return { ok: false, problem: "tilde" };
  if (!value.startsWith("/") && !/^[a-z]:[\\/]/iu.test(value))
    return { ok: false, problem: "relative" };
  if (!isSafeAbsoluteTargetRoot(value)) return { ok: false, problem: "unsafe" };
  return { ok: true };
}

/**
 * Filesystem probe for a path that already passed {@link classifyTargetFolderConfig}.
 * Uses `lstat` so a symlink root is reported as a symlink rather than followed.
 */
export async function probeTargetFolderConfig(
  value: string,
): Promise<TargetFolderConfigStatus> {
  const shape = classifyTargetFolderConfig(value);
  if (!shape.ok) return shape;
  try {
    const stats = await lstat(value);
    if (stats.isSymbolicLink()) return { ok: false, problem: "symlink" };
    if (!stats.isDirectory()) return { ok: false, problem: "not-directory" };
    return { ok: true };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ok: false, problem: "missing" };
    if (errorCode(error) === "ENOTDIR")
      return { ok: false, problem: "not-directory" };
    return { ok: false, problem: "inaccessible" };
  }
}

export function targetFolderConfigMessage(
  status: TargetFolderConfigStatus,
): string | undefined {
  if (status.ok) return undefined;
  switch (status.problem) {
    case "empty":
      return "Enter an absolute local folder path.";
    case "tilde":
      return "~ is not expanded. Use an absolute path.";
    case "relative":
      return "Target folder must be an absolute path.";
    case "unsafe":
      return "Target folder path is not a safe absolute path.";
    case "missing":
      return "Target folder does not exist.";
    case "inaccessible":
      return "Target folder is inaccessible.";
    case "not-directory":
      return "Target folder must be a directory.";
    case "symlink":
      return "Target folder must not be a symlink.";
    default: {
      const _exhaustive: never = status.problem;
      void _exhaustive;
      return "Target folder is invalid.";
    }
  }
}
