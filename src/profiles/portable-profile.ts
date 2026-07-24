import { createHash } from "node:crypto";

import { createIssue, ISSUE_CODES } from "../contracts/issues";
import type {
  Sha256Digest,
  ValidatedPortableProfileSnapshot,
} from "../contracts/export-plan";
import {
  mdxRelayErr,
  mdxRelayOk,
  type MdxRelayResult,
} from "../contracts/result";
import type { PortableProfileV1 } from "./profile-schema";
import {
  hasUnsafePortablePath,
  parsePortableProfile,
} from "./parse-portable-profile";

export { parsePortableProfile } from "./parse-portable-profile";

export interface ValidatedPortableProfile {
  readonly profile: PortableProfileV1;
  readonly snapshot: ValidatedPortableProfileSnapshot;
  readonly profileSnapshotSha256: Sha256Digest;
}

type JsonRecord = Record<string, unknown>;

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
  if (typeof value !== "object" || ancestors.has(value)) return false;

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (
    (isArray && prototype !== Array.prototype) ||
    (!isArray && prototype !== Object.prototype)
  )
    return false;

  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) => typeof key === "symbol" || !hasValidUnicode(key as string),
    )
  )
    return false;
  if (
    isArray &&
    (keys.length !== value.length + 1 ||
      !keys.every(
        (key) =>
          key === "length" ||
          (/^(?:0|[1-9]\d*)$/u.test(key as string) &&
            Number(key) < value.length),
      ))
  )
    return false;

  ancestors.add(value);
  for (const key of keys) {
    if (isArray && key === "length") continue;
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

const supportedSchemePrefix = /^(https?|ssh|git):/iu;
const strictSupportedSchemeUrl = /^(?:https?|ssh|git):\/\//iu;

export const isCredentialBearingRepositoryUrl = (value: string): boolean => {
  const schemeMatch = supportedSchemePrefix.exec(value);
  if (schemeMatch) {
    if (value.includes("?") || value.includes("#")) return true;
    if (strictSupportedSchemeUrl.test(value) && !value.includes("\\")) {
      try {
        const parsed = new URL(value);
        return (
          parsed.password.length > 0 ||
          (parsed.protocol !== "ssh:" && parsed.username.length > 0)
        );
      } catch {
        // Inspect malformed supported-scheme values below without SCP fallback.
      }
    }
    const authority = value
      .slice(schemeMatch[0].length)
      .replace(/^[/\\]+/u, "")
      .split(/[/\\]/u, 1)[0]!;
    const atIndex = authority.lastIndexOf("@");
    if (atIndex <= 0) return false;
    const userInfo = authority.slice(0, atIndex);
    return schemeMatch[1]!.toLowerCase() !== "ssh" || userInfo.includes(":");
  }

  if (/^[a-z]:[\\/]/iu.test(value)) return false;
  if (value.includes("\\")) return false;
  if (/^[^/@:\s]+:[^@/\s]+@[^/@:\s]+\//u.test(value)) return true;
  if (/^[^/@:\s]+:[^@/\s]+@[^/@:\s]+:[^\\?#\s]+$/u.test(value)) return true;
  if (/^(?:[^/@:\s]+@)?[^/@:\s]+:[^\\?#\s]+[?#].*$/u.test(value)) return true;
  return false;
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

const canonicalizeValidated = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value
      .map((_, index) =>
        canonicalizeValidated(
          Object.getOwnPropertyDescriptor(value, String(index))!.value,
        ),
      )
      .join(",")}]`;
  const record = value as JsonRecord;
  return `{${(Reflect.ownKeys(record) as string[])
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalizeValidated(
          Object.getOwnPropertyDescriptor(record, key)!.value,
        )}`,
    )
    .join(",")}}`;
};

export const canonicalizeProfileData = (value: unknown): string => {
  if (!isPlainDataPropertyGraph(value))
    throw new TypeError("Non-JSON profile value");
  return canonicalizeValidated(value);
};

const cloneAndFreeze = <T>(value: T): T => {
  const clone = structuredClone(value);
  const freeze = (entry: unknown): void => {
    if (entry === null || typeof entry !== "object" || Object.isFrozen(entry))
      return;
    for (const nested of Object.values(entry)) freeze(nested);
    Object.freeze(entry);
  };
  freeze(clone);
  return clone;
};

type ProfileBlockerCode =
  | typeof ISSUE_CODES.invalidProfile
  | typeof ISSUE_CODES.unsafePath
  | typeof ISSUE_CODES.credentialUrl;

const invalid = (code: ProfileBlockerCode): MdxRelayResult<never> => {
  if (code === ISSUE_CODES.unsafePath)
    return mdxRelayErr([createIssue(ISSUE_CODES.unsafePath)]);
  if (code === ISSUE_CODES.credentialUrl)
    return mdxRelayErr([createIssue(ISSUE_CODES.credentialUrl)]);
  return mdxRelayErr([createIssue(ISSUE_CODES.invalidProfile)]);
};

export function validatePortableProfile(
  value: unknown,
): MdxRelayResult<ValidatedPortableProfile> {
  try {
    if (!isPlainDataPropertyGraph(value))
      return invalid(ISSUE_CODES.invalidProfile);
    if (containsCredentialUrl(value)) return invalid(ISSUE_CODES.credentialUrl);
    if (hasUnsafePortablePath(value)) return invalid(ISSUE_CODES.unsafePath);
    const profile = parsePortableProfile(value);
    if (!profile) return invalid(ISSUE_CODES.invalidProfile);
    const stableProfile = cloneAndFreeze(profile);
    const snapshot = canonicalizeProfileData(
      stableProfile,
    ) as ValidatedPortableProfileSnapshot;
    const profileSnapshotSha256 = `sha256:${createHash("sha256")
      .update(snapshot, "utf8")
      .digest("hex")}` as Sha256Digest;
    return mdxRelayOk(
      Object.freeze({
        profile: stableProfile,
        snapshot,
        profileSnapshotSha256,
      }),
    );
  } catch {
    return invalid(ISSUE_CODES.invalidProfile);
  }
}
