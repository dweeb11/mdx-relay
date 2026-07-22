import { parse, postprocess, preprocess } from "micromark";
import { decodeString } from "micromark-util-decode-string";

import {
  createIssue,
  ISSUE_CODES,
  type MdxRelayIssue,
  type SourceRange,
} from "../contracts/issues";
import { err, ok, type Result } from "../contracts/result";
import type { PortableProfileV1 } from "../profiles/profile-schema";
import { parseFrontmatter, type FrontmatterOptions } from "./frontmatter";
import { findProtectedRanges } from "./protected-ranges";
import { validateMdx } from "./validate-mdx";

export interface MarkdownImageReference {
  readonly source: string;
  readonly destination: string;
}

export interface MarkdownTransformResult {
  readonly slug: string;
  readonly mdx: string;
  readonly images: readonly MarkdownImageReference[];
  readonly issues: readonly MdxRelayIssue[];
}

export type MarkdownTransformOptions = FrontmatterOptions;

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

const supportedImage = /\.(?:jpe?g|png|webp)$/iu;
const externalSchemes = new Set(["http", "https", "mailto", "tel"]);
const explicitScheme = /^([A-Za-z][A-Za-z0-9+.-]*):/u;
const unsupportedHtml = /<(?:\/?[A-Z]|>|\/>)/u;

const normalizeDestination = (value: string): string | undefined => {
  let decoded = decodeString(value.trim());
  try {
    for (;;) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return undefined;
  }
  return decoded.replace(/\\/gu, "/");
};

const isLocalAttachmentDestination = (value: string): boolean => {
  const decoded = normalizeDestination(value);
  if (decoded === undefined) return true;
  if (decoded.startsWith("//") || decoded.startsWith("#")) return false;
  const scheme = explicitScheme.exec(decoded)?.[1];
  if (scheme) return !externalSchemes.has(scheme.toLowerCase());
  const path = decoded.split(/[?#]/u, 1)[0]!;
  const segment = path.split("/").at(-1)!;
  return segment !== "." && segment !== ".." && segment.includes(".");
};

const isSupportedLocalImageSource = (value: string): boolean => {
  const decoded = normalizeDestination(value);
  const segments = decoded?.split("/");
  return (
    value === value.trim() &&
    decoded !== undefined &&
    decoded === value &&
    segments !== undefined &&
    segments.every(
      (segment) => segment !== "" && segment !== "." && segment !== "..",
    ) &&
    !decoded.startsWith("//") &&
    !decoded.startsWith("/") &&
    !decoded.startsWith("#") &&
    !/[?#]/u.test(decoded) &&
    !explicitScheme.test(decoded) &&
    supportedImage.test(decoded)
  );
};

const rangeAt = (source: string, start: number, end: number): SourceRange => {
  const point = (offset: number) => {
    const before = source.slice(0, offset);
    const lastNewline = before.lastIndexOf("\n");
    return Object.freeze({
      line: before.split("\n").length,
      column: offset - lastNewline,
      offset,
    });
  };
  return Object.freeze({ start: point(start), end: point(end) });
};

const unsupported = (
  source: string,
  start: number,
  end: number,
): Result<never, MdxRelayIssue> =>
  err(
    createIssue(
      ISSUE_CODES.unsupportedMarkdown,
      {},
      {
        sourceRange: rangeAt(source, start, end),
      },
    ),
  );

const overlapsProtected = (
  edit: Edit,
  ranges: readonly SourceRange[],
): boolean => {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle]!.end.offset <= edit.start) low = middle + 1;
    else high = middle;
  }
  const range = ranges[low];
  return range !== undefined && range.start.offset < edit.end;
};

const addEdit = (
  edits: Edit[],
  protectedRanges: readonly SourceRange[],
  edit: Edit,
): boolean => {
  let low = 0;
  let high = edits.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (edits[middle]!.start < edit.start) low = middle + 1;
    else high = middle;
  }
  const previous = edits[low - 1];
  const next = edits[low];
  /* v8 ignore next 9 -- caller candidates are prefiltered; this is a fail-closed invariant guard. */
  if (
    edit.start < 0 ||
    edit.end <= edit.start ||
    overlapsProtected(edit, protectedRanges) ||
    (previous !== undefined && previous.end > edit.start) ||
    (next !== undefined && next.start < edit.end)
  ) {
    return false;
  }
  edits.splice(low, 0, Object.freeze(edit));
  return true;
};

const proseMatches = (
  source: string,
  ranges: readonly SourceRange[],
  expression: RegExp,
): readonly RegExpExecArray[] => {
  const matches: RegExpExecArray[] = [];
  expression.lastIndex = 0;
  for (
    let match = expression.exec(source);
    match;
    match = expression.exec(source)
  ) {
    const candidate = {
      start: match.index,
      end: match.index + match[0].length,
      replacement: "",
    };
    if (!overlapsProtected(candidate, ranges)) matches.push(match);
  }
  return matches;
};

const maskMatches = (
  source: string,
  matches: readonly RegExpExecArray[],
): string => {
  let cursor = 0;
  let output = "";
  for (const match of matches) {
    output += source.slice(cursor, match.index);
    output += " ".repeat(match[0].length);
    cursor = match.index + match[0].length;
  }
  return output + source.slice(cursor);
};

const firstUnsupported = (
  source: string,
  ranges: readonly SourceRange[],
): { readonly start: number; readonly end: number } | undefined => {
  const candidates: { readonly start: number; readonly end: number }[] = [];
  const patterns = [
    /^ {0,3}(?:import|export)(?:\s|$).*$/gmu,
    /^ {0,3}(?:<>|<\/?>)/gmu,
    /^ {0,3}\{[^\r\n]*$/gmu,
  ];
  for (const pattern of patterns)
    for (const match of proseMatches(source, ranges, pattern))
      candidates.push({
        start: match.index,
        end: match.index + match[0].length,
      });

  const wikilinks = proseMatches(
    source,
    ranges,
    /(?<!!)\[\[([^\]\r\n]+)\]\]/gu,
  );
  const sourceForParsing = maskMatches(source, wikilinks);

  try {
    const events = postprocess(
      parse()
        .document()
        .write(preprocess()(sourceForParsing, "utf8", true)),
    );
    for (const event of events) {
      if (event[0] !== "enter") continue;
      const token = event[1];
      const text = source.slice(token.start.offset, token.end.offset);
      const isAttachmentDestination =
        (token.type === "resourceDestinationString" ||
          token.type === "definitionDestinationString") &&
        isLocalAttachmentDestination(text);
      const isUnsupportedHtml =
        (token.type === "htmlText" || token.type === "htmlFlow") &&
        unsupportedHtml.test(text.trimStart());
      if (
        token.type === "image" ||
        isAttachmentDestination ||
        isUnsupportedHtml
      )
        candidates.push({ start: token.start.offset, end: token.end.offset });
    }
    /* v8 ignore next 3 -- findProtectedRanges already completed the same deterministic parse. */
  } catch {
    return Object.freeze({ start: 0, end: Math.min(1, source.length) });
  }

  const embeds = proseMatches(source, ranges, /!\[\[([^\]\r\n]*)\]\]/gu);
  for (const match of embeds) {
    const imageSource = match[1]!.split("|", 1)[0]!;
    if (!isSupportedLocalImageSource(imageSource))
      candidates.push({
        start: match.index,
        end: match.index + match[0].length,
      });
  }
  for (const match of wikilinks) {
    const target = match[1]!.split("|", 1)[0]!.trim();
    if (isLocalAttachmentDestination(target))
      candidates.push({
        start: match.index,
        end: match.index + match[0].length,
      });
  }

  const first = candidates.sort((left, right) => left.start - right.start)[0];
  return first ? Object.freeze(first) : undefined;
};

const applyEdits = (source: string, edits: readonly Edit[]): string => {
  let result = source;
  const ordered = [...edits].sort((left, right) => right.start - left.start);
  for (const edit of ordered)
    result =
      result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  return result;
};

const template = (
  value: string,
  replacements: Readonly<Record<string, string>>,
): string =>
  Object.entries(replacements).reduce(
    (result, [name, replacement]) =>
      result.replaceAll(`{${name}}`, replacement),
    value,
  );

const escapeProse = (
  value: string,
): { readonly value: string; readonly count: number } => {
  let count = 0;
  let output = "";
  for (let offset = 0; offset < value.length; offset += 1) {
    const character = value[offset]!;
    if (character === "{") {
      output += "&#123;";
      count += 1;
    } else if (character === "}") {
      output += "&#125;";
      count += 1;
    } else if (character === "<") {
      output += "&lt;";
      count += 1;
    } else {
      output += character;
    }
  }
  return Object.freeze({ value: output, count });
};

export async function transformMarkdown(
  source: string,
  profile: PortableProfileV1,
  options: MarkdownTransformOptions = {},
): Promise<Result<MarkdownTransformResult, MdxRelayIssue>> {
  const parsed = parseFrontmatter(source, options);
  if (!parsed.ok) return parsed;

  const body = parsed.value.body;
  const protectedResult = findProtectedRanges(body);
  if (!protectedResult.ok) {
    const range = protectedResult.error.sourceRange;
    /* v8 ignore next -- findProtectedRanges always attaches a safe range to failures. */
    if (!range) return protectedResult;
    return unsupported(
      source,
      parsed.value.bodyOffset + range.start.offset,
      parsed.value.bodyOffset + range.end.offset,
    );
  }
  const ranges = protectedResult.value;
  const blocked = firstUnsupported(body, ranges);
  if (blocked)
    return unsupported(
      source,
      parsed.value.bodyOffset + blocked.start,
      parsed.value.bodyOffset + blocked.end,
    );

  const edits: Edit[] = [];
  const images: MarkdownImageReference[] = [];
  let wikilinks = 0;
  let callouts = 0;
  let escaped = 0;

  for (const match of proseMatches(body, ranges, /!\[\[([^\]\r\n]+)\]\]/gu)) {
    const imageSource = match[1]!.split("|", 1)[0]!.trim();
    const destination = template(profile.images.filenameTemplate, {
      index: String(images.length + 1),
    });
    const src = template(profile.output.assetUrlTemplate, {
      slug: parsed.value.slug,
      assetFile: destination,
    });
    const edit = {
      start: match.index,
      end: match.index + match[0].length,
      replacement: `<${profile.images.component} src="${src}" alt="" />`,
    };
    /* v8 ignore next 7 -- edits originate from non-overlapping parser/regex candidates. */
    if (!addEdit(edits, ranges, edit))
      return unsupported(
        source,
        parsed.value.bodyOffset + edit.start,
        parsed.value.bodyOffset + edit.end,
      );
    images.push(Object.freeze({ source: imageSource, destination }));
  }

  for (const match of proseMatches(
    body,
    ranges,
    /(?<!!)\[\[([^\]\r\n]+)\]\]/gu,
  )) {
    const inner = match[1]!;
    const display = (
      inner.includes("|") ? inner.split("|").at(-1)! : inner
    ).trim();
    const replacement = escapeProse(display);
    const edit = {
      start: match.index,
      end: match.index + match[0].length,
      replacement: replacement.value,
    };
    /* v8 ignore next 7 -- edits originate from non-overlapping parser/regex candidates. */
    if (!addEdit(edits, ranges, edit))
      return unsupported(
        source,
        parsed.value.bodyOffset + edit.start,
        parsed.value.bodyOffset + edit.end,
      );
    wikilinks += 1;
    escaped += replacement.count;
  }

  for (const match of proseMatches(
    body,
    ranges,
    /^( {0,3}>)[ \t]*\[![A-Za-z0-9_-]+\][-+]?[ \t]*/gmu,
  )) {
    const lineEnd = body.indexOf("\n", match.index);
    const contentEnd = lineEnd < 0 ? body.length : lineEnd;
    const hasTitle = contentEnd > match.index + match[0].length;
    const edit = {
      start: match.index,
      end: match.index + match[0].length,
      replacement: `${match[1]}${hasTitle ? " " : ""}`,
    };
    /* v8 ignore next 7 -- edits originate from non-overlapping parser/regex candidates. */
    if (!addEdit(edits, ranges, edit))
      return unsupported(
        source,
        parsed.value.bodyOffset + edit.start,
        parsed.value.bodyOffset + edit.end,
      );
    callouts += 1;
  }

  let protectedIndex = 0;
  let editIndex = 0;
  for (let offset = 0; offset < body.length; offset += 1) {
    while (ranges[protectedIndex]?.end.offset === offset) protectedIndex += 1;
    while (edits[editIndex]?.end === offset) editIndex += 1;
    const protectedRange = ranges[protectedIndex];
    const existingEdit = edits[editIndex];
    if (
      (protectedRange !== undefined &&
        offset >= protectedRange.start.offset &&
        offset < protectedRange.end.offset) ||
      (existingEdit !== undefined &&
        offset >= existingEdit.start &&
        offset < existingEdit.end)
    ) {
      continue;
    }
    const character = body[offset];
    const replacement =
      character === "{"
        ? "&#123;"
        : character === "}"
          ? "&#125;"
          : character === "<" && /[\s\d]/u.test(body[offset + 1] ?? "")
            ? "&lt;"
            : undefined;
    if (!replacement) continue;
    const edit = { start: offset, end: offset + 1, replacement };
    /* v8 ignore next 7 -- edits originate from non-overlapping parser/regex candidates. */
    if (!addEdit(edits, ranges, edit))
      return unsupported(
        source,
        parsed.value.bodyOffset + edit.start,
        parsed.value.bodyOffset + edit.end,
      );
    escaped += 1;
  }

  const issues: MdxRelayIssue[] = [...parsed.value.warnings];
  if (wikilinks > 0)
    issues.push(
      createIssue(ISSUE_CODES.wikilinksFlattened, { count: wikilinks }),
    );
  if (callouts > 0)
    issues.push(
      createIssue(ISSUE_CODES.calloutsConverted, { count: callouts }),
    );
  if (escaped > 0)
    issues.push(createIssue(ISSUE_CODES.mdxEscaped, { count: escaped }));
  if (images.length > 0)
    issues.push(
      createIssue(ISSUE_CODES.imageAltTextMissing, { count: images.length }),
    );

  const mdx = `${parsed.value.frontmatter}\n${applyEdits(body, edits)}`;
  const validation = await validateMdx(mdx);
  if (!validation.ok) return validation;
  return ok(
    Object.freeze({
      slug: parsed.value.slug,
      mdx,
      images: Object.freeze(images),
      issues: Object.freeze(issues),
    }),
  );
}

export const transformNote = transformMarkdown;
