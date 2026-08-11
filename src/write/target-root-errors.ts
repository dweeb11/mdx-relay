/**
 * Typed failures from resolving a configured target root. Preview and settings
 * map these to distinct blockers so a missing folder is never reported as
 * mid-planning staleness.
 */
export type TargetRootFailureKind =
  "missing" | "not-directory" | "symlink" | "inaccessible";

export class TargetRootResolutionError extends Error {
  readonly kind: TargetRootFailureKind;
  readonly configuredRoot: string;

  constructor(kind: TargetRootFailureKind, configuredRoot: string) {
    super(`Target root ${kind}`);
    this.name = "TargetRootResolutionError";
    this.kind = kind;
    this.configuredRoot = configuredRoot;
  }
}

export const isTargetRootResolutionError = (
  error: unknown,
): error is TargetRootResolutionError =>
  error instanceof TargetRootResolutionError;
