import { canonicalizeJcs, isPlainDataPropertyGraph } from "../canonical";
import { sha256OfUtf8 } from "../canonical/hash";
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

const supportedSchemePrefix = /^(https?|ssh|git):/iu;
const strictSupportedSchemeUrl = /^(?:https?|ssh|git):\/\//iu;

export const isCredentialBearingUrl = (value: string): boolean => {
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
  if (typeof value === "string") return isCredentialBearingUrl(value);
  if (value === null || typeof value !== "object") return false;
  return Reflect.ownKeys(value).some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return containsCredentialUrl(
      (descriptor as PropertyDescriptor & { value: unknown }).value,
    );
  });
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
    const snapshot = canonicalizeJcs(
      stableProfile,
    ) as ValidatedPortableProfileSnapshot;
    const profileSnapshotSha256 = sha256OfUtf8(snapshot);
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
