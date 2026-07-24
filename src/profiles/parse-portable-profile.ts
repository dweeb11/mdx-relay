import { MDX_RELAY_LIMITS } from "../core/limits";
import type { PortableProfileV1 } from "./profile-schema";

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

/**
 * Exact portable-profile schema check shared by planning and the worker.
 * Returns the typed profile on success; undefined for any shape or range
 * violation. Does not allocate, freeze, or hash — callers that need a sealed
 * snapshot use `validatePortableProfile`.
 *
 * Kept free of Node built-ins so the dedicated worker can import it without
 * pulling `node:crypto` into the browser-safe bundle.
 */
export const parsePortableProfile = (
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

/** True when string-shaped path fields violate portable-path rules. */
export const hasUnsafePortablePath = (value: unknown): boolean => {
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
