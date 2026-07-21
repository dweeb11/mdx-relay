import { createHash } from "node:crypto";

import type { Sha256Digest } from "../contracts/export-plan";
import { createIssue, ISSUE_CODES } from "../contracts/issues";
import {
  mdxRelayErr,
  mdxRelayOk,
  type MdxRelayResult,
} from "../contracts/result";
import {
  canonicalizeProfileData,
  isCredentialBearingRepositoryUrl,
} from "./portable-profile";

export interface MachineBindingV1 {
  readonly schemaVersion: 1;
  readonly profileId: string;
  readonly repositoryRoot: string;
  readonly repositoryUrl: string;
}

export interface ValidatedMachineBinding {
  readonly binding: MachineBindingV1;
  readonly fingerprint: Sha256Digest;
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasExactKeys = (
  value: JsonRecord,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
};

const containsExecutable = (
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): boolean => {
  if (typeof value === "function") return true;
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((entry) => containsExecutable(entry, seen));
};

const containsCredentialUrl = (
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): boolean => {
  if (typeof value === "string") return isCredentialBearingRepositoryUrl(value);
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((entry) =>
    containsCredentialUrl(entry, seen),
  );
};

const windowsReservedSegment =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

const hasControlOrSpace = (value: string, includeSpace: boolean): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      (codePoint <= (includeSpace ? 0x20 : 0x1f) || codePoint === 0x7f)
    );
  });

const isSafeAbsoluteRepositoryRoot = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 4096 ||
    hasControlOrSpace(value, false) ||
    value.startsWith("//") ||
    value.startsWith("\\\\") ||
    value.endsWith("/") ||
    value.endsWith("\\")
  )
    return false;
  const windows = /^[a-z]:[\\/]/iu.test(value);
  if (!windows && !value.startsWith("/")) return false;
  const normalized = value.replaceAll("\\", "/");
  if (normalized.includes("//")) return false;
  const body = windows ? normalized.slice(3) : normalized.slice(1);
  const segments = body.split("/");
  return (
    segments.length > 0 &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !windowsReservedSegment.test(segment) &&
        !/[. ]$/u.test(segment),
    )
  );
};

const isCredentialFreeRepositoryUrl = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2048 ||
    hasControlOrSpace(value, true) ||
    isCredentialBearingRepositoryUrl(value)
  )
    return false;
  if (/^(?:https?|ssh|git):\/\//iu.test(value)) {
    try {
      const parsed = new URL(value);
      return parsed.hostname.length > 0;
    } catch {
      return false;
    }
  }
  return /^(?:[^/@:\s]+@)?[^/@:\s]+:[^\s]+$/u.test(value);
};

const cloneAndFreeze = (binding: MachineBindingV1): MachineBindingV1 =>
  Object.freeze(structuredClone(binding));

const invalid = (
  code: keyof Pick<
    typeof ISSUE_CODES,
    "invalidProfile" | "unsafePath" | "credentialUrl"
  >,
) => mdxRelayErr([createIssue(ISSUE_CODES[code])]);

export function validateMachineBinding(
  value: unknown,
): MdxRelayResult<ValidatedMachineBinding> {
  try {
    if (containsCredentialUrl(value)) return invalid("credentialUrl");
    if (containsExecutable(value)) return invalid("invalidProfile");
    if (
      isRecord(value) &&
      typeof value.repositoryRoot === "string" &&
      !isSafeAbsoluteRepositoryRoot(value.repositoryRoot)
    )
      return invalid("unsafePath");
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        "schemaVersion",
        "profileId",
        "repositoryRoot",
        "repositoryUrl",
      ]) ||
      value.schemaVersion !== 1 ||
      typeof value.profileId !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value.profileId) ||
      !isSafeAbsoluteRepositoryRoot(value.repositoryRoot) ||
      !isCredentialFreeRepositoryUrl(value.repositoryUrl)
    )
      return invalid("invalidProfile");
    const binding = cloneAndFreeze(value as unknown as MachineBindingV1);
    const fingerprint = createHash("sha256")
      .update(canonicalizeProfileData(binding), "utf8")
      .digest("hex") as Sha256Digest;
    return mdxRelayOk(Object.freeze({ binding, fingerprint }));
  } catch {
    return invalid("invalidProfile");
  }
}
