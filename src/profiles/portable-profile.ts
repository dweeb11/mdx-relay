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
import { MDX_RELAY_LIMITS } from "../core/limits";
import type { PortableProfileV1 } from "./profile-schema";

export interface ValidatedPortableProfile {
  readonly profile: PortableProfileV1;
  readonly snapshot: ValidatedPortableProfileSnapshot;
  readonly profileSnapshotSha256: Sha256Digest;
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

const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });

const isBoundedString = (
  value: unknown,
  maximumLength: number,
): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximumLength &&
  hasValidUnicode(value) &&
  !hasControlCharacter(value);

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

const windowsReservedSegment =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const windowsForbiddenSegmentCharacter = /[<>:"|?*]/u;

const isPortableSegment = (segment: string): boolean =>
  segment.length > 0 &&
  segment !== "." &&
  segment !== ".." &&
  segment.toLowerCase() !== ".git" &&
  !windowsReservedSegment.test(segment) &&
  !windowsForbiddenSegmentCharacter.test(segment) &&
  !/[. ]$/u.test(segment) &&
  !hasControlCharacter(segment);

const isPortableRelativePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 240 &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !/^[a-z]:/iu.test(value) &&
  !/^[a-z][a-z0-9+.-]*:/iu.test(value) &&
  value.split("/").every(isPortableSegment);

const placeholders = (value: string): readonly string[] | undefined => {
  const found = [...value.matchAll(/\{([^{}]+)\}/gu)];
  const withoutPlaceholders = value.replaceAll(/\{[^{}]+\}/gu, "");
  if (withoutPlaceholders.includes("{") || withoutPlaceholders.includes("}"))
    return undefined;
  return found.map((match) => match[1]!);
};

const hasExactPlaceholders = (
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): value is string => {
  if (typeof value !== "string") return false;
  const found = placeholders(value);
  if (!found || found.some((name) => !allowed.includes(name))) return false;
  return (
    required.every(
      (name) => found.filter((item) => item === name).length === 1,
    ) && found.length === required.length
  );
};

const isAssetUrlTemplate = (value: unknown): value is string => {
  if (
    !hasExactPlaceholders(
      value,
      ["slug", "assetFile"],
      ["slug", "assetFile"],
    ) ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("%") ||
    value.includes("?") ||
    value.includes("#")
  )
    return false;
  const segments = value.slice(1).split("/");
  return (
    segments.every(isPortableSegment) &&
    segments.includes("{slug}") &&
    segments.includes("{assetFile}")
  );
};

const isFilenameTemplate = (value: unknown): value is string =>
  hasExactPlaceholders(value, ["index"], ["index"]) &&
  !value.includes("/") &&
  !value.includes("\\") &&
  value.endsWith(".webp") &&
  isPortableSegment(value.replace("{index}", "1"));

const isCommitTemplate = (value: unknown): value is string =>
  hasExactPlaceholders(value, ["title"], ["title"]) &&
  value.length <= 10_000 &&
  !value.includes("\r") &&
  !value.includes("\0");

const isRemoteName = (value: unknown): value is string =>
  isBoundedString(value, 100) &&
  /^[a-z0-9][a-z0-9._-]*$/iu.test(value) &&
  !value.includes("..");

const isBranchName = (value: unknown): value is string =>
  isBoundedString(value, 240) &&
  value !== "HEAD" &&
  !value.startsWith("-") &&
  !value.startsWith("/") &&
  !value.endsWith("/") &&
  !value.endsWith(".") &&
  !value.includes("..") &&
  !value.includes("//") &&
  !value.includes("@{") &&
  !/[~^:?*[\]\\\s]/u.test(value) &&
  value
    .split("/")
    .every(
      (component) =>
        !component.startsWith(".") &&
        !component.toLowerCase().endsWith(".lock"),
    );

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

const parsePortableProfile = (
  value: unknown,
): PortableProfileV1 | undefined => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "id",
      "name",
      "repository",
      "output",
      "document",
      "images",
      "commit",
    ]) ||
    value.schemaVersion !== 1 ||
    !isBoundedString(value.id, 64) ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value.id) ||
    !isBoundedString(value.name, 100)
  )
    return undefined;
  const { repository, output, document, images, commit } = value;
  if (
    !isRecord(repository) ||
    !hasExactKeys(repository, ["remote", "branch"]) ||
    !isRemoteName(repository.remote) ||
    !isBranchName(repository.branch) ||
    !isRecord(output) ||
    !hasExactKeys(output, ["contentRoot", "assetRoot", "assetUrlTemplate"]) ||
    !isPortableRelativePath(output.contentRoot) ||
    !isPortableRelativePath(output.assetRoot) ||
    !isAssetUrlTemplate(output.assetUrlTemplate) ||
    !isRecord(document) ||
    !hasExactKeys(document, [
      "preset",
      "wikilinks",
      "callouts",
      "frontmatterPreset",
    ]) ||
    document.preset !== "dpw-mind-net-v1" ||
    document.wikilinks !== "flatten" ||
    document.callouts !== "blockquote" ||
    document.frontmatterPreset !== "dpw-post-v1" ||
    !isRecord(images) ||
    !hasExactKeys(images, [
      "component",
      "filenameTemplate",
      "maxDimension",
      "webpQuality",
    ]) ||
    !isBoundedString(images.component, 100) ||
    !/^[A-Z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/u.test(images.component) ||
    !isFilenameTemplate(images.filenameTemplate) ||
    !Number.isInteger(images.maxDimension) ||
    (images.maxDimension as number) < 1 ||
    (images.maxDimension as number) >
      Math.floor(Math.sqrt(MDX_RELAY_LIMITS.decodedImagePixels)) ||
    !Number.isInteger(images.webpQuality) ||
    (images.webpQuality as number) < 1 ||
    (images.webpQuality as number) > 100 ||
    !isRecord(commit) ||
    !hasExactKeys(commit, ["message"]) ||
    !isCommitTemplate(commit.message)
  )
    return undefined;
  return value as unknown as PortableProfileV1;
};

const hasUnsafePortablePath = (value: unknown): boolean => {
  if (!isRecord(value) || !isRecord(value.output)) return false;
  const { contentRoot, assetRoot, assetUrlTemplate } = value.output;
  if (
    (typeof contentRoot === "string" && !isPortableRelativePath(contentRoot)) ||
    (typeof assetRoot === "string" && !isPortableRelativePath(assetRoot))
  )
    return true;
  if (
    isRecord(value.images) &&
    typeof value.images.filenameTemplate === "string" &&
    windowsForbiddenSegmentCharacter.test(value.images.filenameTemplate)
  )
    return true;
  return (
    typeof assetUrlTemplate === "string" &&
    (assetUrlTemplate.includes("../") ||
      assetUrlTemplate.includes("/./") ||
      assetUrlTemplate.includes("\\") ||
      assetUrlTemplate.includes("%") ||
      assetUrlTemplate
        .slice(1)
        .split("/")
        .some(
          (segment) =>
            segment.toLowerCase() === ".git" ||
            windowsForbiddenSegmentCharacter.test(segment),
        ))
  );
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
