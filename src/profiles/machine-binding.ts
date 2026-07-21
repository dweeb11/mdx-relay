import { createHash } from "node:crypto";

import type { Sha256Digest } from "../contracts/export-plan";
import { createIssue, ISSUE_CODES } from "../contracts/issues";
import {
  mdxRelayErr,
  mdxRelayOk,
  type MdxRelayResult,
} from "../contracts/result";
import { isCredentialBearingRepositoryUrl } from "./portable-profile";

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

const hasValidUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const isPlainDataPropertyGraph = (
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet(),
): boolean => {
  if (value === null) return true;
  if (typeof value === "string") return hasValidUnicode(value);
  if (typeof value === "boolean" || typeof value === "number") return true;
  if (typeof value !== "object" || Array.isArray(value) || ancestors.has(value))
    return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) => typeof key === "symbol" || !hasValidUnicode(key as string),
    )
  )
    return false;

  ancestors.add(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      !isPlainDataPropertyGraph(descriptor.value, ancestors)
    ) {
      ancestors.delete(value);
      return false;
    }
  }
  ancestors.delete(value);
  return true;
};

const containsCredentialUrl = (value: unknown): boolean => {
  if (typeof value === "string") return isCredentialBearingRepositoryUrl(value);
  if (value === null || typeof value !== "object") return false;
  return Reflect.ownKeys(value).some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return containsCredentialUrl(
      (descriptor as PropertyDescriptor & { value: unknown }).value,
    );
  });
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
        (!windows || !/[<>:"|?*]/u.test(segment)) &&
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
  if (/^(?:https?|ssh|git):/iu.test(value)) {
    if (!/^(?:https?|ssh|git):\/\//iu.test(value) || value.includes("\\"))
      return false;
    try {
      const parsed = new URL(value);
      return (
        parsed.hostname.length > 0 &&
        !parsed.search &&
        !parsed.hash &&
        !parsed.password &&
        (parsed.protocol === "ssh:" || !parsed.username)
      );
    } catch {
      return false;
    }
  }
  return /^(?:[^/@:\s]+@)?(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)*):(?!.*\/\/)(?!(?:.*\/)?\.{1,2}(?:\/|$))[^\\?#\s]+$/iu.test(
    value,
  );
};

const cloneAndFreeze = (binding: MachineBindingV1): MachineBindingV1 =>
  Object.freeze(structuredClone(binding));

const canonicalizeMachineBinding = (binding: MachineBindingV1): string =>
  `{"profileId":${JSON.stringify(binding.profileId)},"repositoryRoot":${JSON.stringify(
    binding.repositoryRoot,
  )},"repositoryUrl":${JSON.stringify(
    binding.repositoryUrl,
  )},"schemaVersion":${JSON.stringify(binding.schemaVersion)}}`;

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
    if (!isPlainDataPropertyGraph(value)) return invalid("invalidProfile");
    if (containsCredentialUrl(value)) return invalid("credentialUrl");
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
    const fingerprint = `sha256:${createHash("sha256")
      .update(canonicalizeMachineBinding(binding), "utf8")
      .digest("hex")}` as Sha256Digest;
    return mdxRelayOk(Object.freeze({ binding, fingerprint }));
  } catch {
    return invalid("invalidProfile");
  }
}
