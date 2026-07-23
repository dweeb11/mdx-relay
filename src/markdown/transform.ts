import { Parser as EcmascriptParser } from "acorn";
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
import {
  findDestinationRanges,
  findProtectedRanges,
  mergeSourceRanges,
} from "./protected-ranges";
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

interface EcmascriptStatement {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

interface EcmascriptStatementParser {
  pos: number;
  start: number;
  end: number;
  lastTokStart: number;
  lastTokEnd: number;
  nextToken(): void;
  parseStatement(
    context: null,
    topLevel: boolean,
    exports: Readonly<Record<string, never>>,
  ): EcmascriptStatement;
  skipBlockComment(): void;
  raise(position: number, message: string): never;
  raiseRecoverable(position: number, message: string): never;
}

const StatementParser = EcmascriptParser as unknown as new (
  options: Readonly<Record<string, unknown>>,
  input: string,
) => EcmascriptStatementParser;

// Flat scan cost charged per block comment: the parser below resolves any
// comment with one indexed lookup, so its contents are never rescanned.
const commentScanCost = 16;

// Acorn rescans from offset zero to derive the start line, formats every
// failure with another such rescan, and finds `*/` by searching to the end of
// input. Parsing each compact candidate this way made repeated malformed
// candidates quadratic (APP-595). This subclass preserves Acorn's grammar,
// token stream, and statement offsets while making each candidate cost only
// the characters it newly consumes: the start state is seeded directly (line
// bookkeeping stays dead because locations are disabled and `raise` stops
// formatting positions), block comments resolve against one shared sorted
// `*/` index, and failures throw without deriving line information.
class CompactCandidateParser extends StatementParser {
  readonly commentCloses: readonly number[];

  // Characters inside skipped block comments beyond the flat cost, excluded
  // from the scan budget because they are never rescanned.
  commentExcess = 0;

  constructor(source: string, start: number, commentCloses: readonly number[]) {
    super({ ecmaVersion: "latest", sourceType: "module" }, source);
    this.commentCloses = commentCloses;
    this.pos = start;
    this.start = start;
    this.end = start;
    this.lastTokStart = start;
    this.lastTokEnd = start;
  }

  override skipBlockComment(): void {
    const opening = this.pos;
    this.pos += 2;
    let low = 0;
    let high = this.commentCloses.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.commentCloses[middle]! < this.pos) low = middle + 1;
      else high = middle;
    }
    const close = this.commentCloses[low];
    if (close === undefined) this.raise(opening, "Unterminated comment");
    this.pos = close + 2;
    const skipped = this.pos - opening;
    if (skipped > commentScanCost)
      this.commentExcess += skipped - commentScanCost;
  }

  override raise(position: number, message: string): never {
    throw new SyntaxError(`${message} at ${String(position)}`);
  }

  override raiseRecoverable(position: number, message: string): never {
    this.raise(position, message);
  }
}

const parseModuleStatementAt = (
  source: string,
  start: number,
  commentCloses: readonly number[],
): {
  readonly statement: EcmascriptStatement | undefined;
  readonly scanCost: number;
} => {
  const parser = new CompactCandidateParser(source, start, commentCloses);
  let statement: EcmascriptStatement | undefined;
  try {
    parser.nextToken();
    statement = parser.parseStatement(null, true, {});
  } catch {
    // Invalid JavaScript is prose here; final MDX validation remains fail closed.
  }
  return Object.freeze({
    statement,
    scanCost: parser.pos - parser.commentExcess - start,
  });
};

const compactModuleDeclarations = (
  source: string,
  ranges: readonly SourceRange[],
): readonly { readonly start: number; readonly end: number }[] => {
  const declarations: { readonly start: number; readonly end: number }[] = [];
  const candidates = source.matchAll(
    /^ {0,3}(?:import(?=[/"'{*])|export(?=[/{*]))/gmu,
  );
  const commentCloses = [...source.matchAll(/\*\//gu)].map(
    (close) => close.index,
  );
  // Candidate parses may overlap, so hostile notes could still multiply the
  // per-candidate costs above. Capping total consumed characters at a fixed
  // multiple of the source length keeps the scan near-linear: O(source)
  // tokenizer work plus one O(log closes) lookup per skipped comment.
  // Ordinary notes stay far below the cap because each failing candidate
  // consumes only its own statement or line, while a note that exceeds it is
  // reported as unsupported at the current candidate — exhaustion fails
  // closed instead of skipping detection.
  const scanBudget = source.length * 4 + 1024;
  let scanned = 0;
  let protectedIndex = 0;
  for (const candidate of candidates) {
    for (;;) {
      const preceding = ranges[protectedIndex];
      if (preceding === undefined || preceding.end.offset > candidate.index)
        break;
      protectedIndex += 1;
    }
    // Whether a candidate begins inside protected code is the only
    // protected-range question for compact declarations, so it is settled
    // here: a candidate that does is preserved verbatim, and skipping it
    // before parsing also keeps protected content out of the scan budget.
    const enclosing = ranges[protectedIndex];
    if (enclosing !== undefined && enclosing.start.offset <= candidate.index)
      continue;
    if (scanned > scanBudget) {
      declarations.push({
        start: candidate.index,
        end: candidate.index + candidate[0].length,
      });
      break;
    }
    const parsed = parseModuleStatementAt(
      source,
      candidate.index,
      commentCloses,
    );
    scanned += parsed.scanCost;
    const statement = parsed.statement;
    if (statement === undefined) continue;
    // Only the start position matters. A declaration that begins in prose is
    // executable ESM even when its JavaScript strings or comments contain
    // backtick pairs that CommonMark reports as inline code, and a later
    // unrelated code span must not hide it either, so internal overlap never
    // suppresses the declaration. The candidate anchor is a line start and the
    // parser only skips spaces to reach `statement.start`, so no protected
    // range can begin between the offset checked above and the declaration.
    if (
      statement.type === "ImportDeclaration" ||
      statement.type === "ExportAllDeclaration" ||
      statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration"
    ) {
      declarations.push({ start: statement.start, end: statement.end });
    }
  }
  return declarations;
};

const firstUnsupported = (
  source: string,
  ranges: readonly SourceRange[],
  wikilinkExcludedRanges: readonly SourceRange[],
): { readonly start: number; readonly end: number } | undefined => {
  const candidates: { readonly start: number; readonly end: number }[] = [];
  const wikilinks = proseMatches(
    source,
    wikilinkExcludedRanges,
    /(?<!!)\[\[([^\]\r\n]+)\]\]/gu,
  );
  const sourceForParsing = maskMatches(source, wikilinks);
  const patterns = [
    /^ {0,3}(?:import|export)(?:\s|$).*$/gmu,
    /^ {0,3}(?:<>|<\/?>)/gmu,
    /^ {0,3}\{[^\r\n]*$/gmu,
    /<\/?(?:(?:[A-Z_$][\w$-]*)|(?:[A-Za-z_$][\w$-]*(?:[.:][A-Za-z_$][\w$-]*)+))(?=\s|\/?>)/gu,
  ];
  for (const pattern of patterns)
    for (const match of proseMatches(sourceForParsing, ranges, pattern))
      candidates.push({
        start: match.index,
        end: match.index + match[0].length,
      });
  candidates.push(...compactModuleDeclarations(sourceForParsing, ranges));

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

  const embeds = proseMatches(
    source,
    wikilinkExcludedRanges,
    /!\[\[([^\]\r\n]*)\]\]/gu,
  );
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
  const destinationResult = findDestinationRanges(body);
  if (!destinationResult.ok) {
    const range = destinationResult.error.sourceRange;
    /* v8 ignore next -- findDestinationRanges always attaches a safe range to failures. */
    if (!range) return destinationResult;
    return unsupported(
      source,
      parsed.value.bodyOffset + range.start.offset,
      parsed.value.bodyOffset + range.end.offset,
    );
  }
  const wikilinkExcludedRanges = mergeSourceRanges(
    ranges,
    destinationResult.value,
  );
  const blocked = firstUnsupported(body, ranges, wikilinkExcludedRanges);
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

  for (const match of proseMatches(
    body,
    wikilinkExcludedRanges,
    /!\[\[([^\]\r\n]+)\]\]/gu,
  )) {
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
    if (!addEdit(edits, wikilinkExcludedRanges, edit))
      return unsupported(
        source,
        parsed.value.bodyOffset + edit.start,
        parsed.value.bodyOffset + edit.end,
      );
    images.push(Object.freeze({ source: imageSource, destination }));
  }

  for (const match of proseMatches(
    body,
    wikilinkExcludedRanges,
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
    if (!addEdit(edits, wikilinkExcludedRanges, edit))
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
