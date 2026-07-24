import { parse, postprocess, preprocess } from "micromark";

import {
  createIssue,
  ISSUE_CODES,
  type MdxRelayIssue,
  type SourcePoint,
  type SourceRange,
} from "../contracts/issues";
import { err, ok, type Result } from "../contracts/result";

const protectedTokenTypes = new Set(["codeText", "codeFenced", "codeIndented"]);

const destinationTokenTypes = new Set([
  "resourceDestinationString",
  "definitionDestinationString",
]);

export interface MarkdownSourceRanges {
  readonly code: readonly SourceRange[];
  readonly destinations: readonly SourceRange[];
}

const freezePoint = (point: {
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}): SourcePoint =>
  Object.freeze({
    line: point.line,
    column: point.column,
    offset: point.offset,
  });

const freezeRange = (start: SourcePoint, end: SourcePoint): SourceRange =>
  Object.freeze({ start: freezePoint(start), end: freezePoint(end) });

const pointAtOffset = (source: string, offset: number): SourcePoint => {
  const before = source.slice(0, offset);
  const lastNewline = before.lastIndexOf("\n");
  return Object.freeze({
    line: before.split("\n").length,
    column: offset - lastNewline,
    offset,
  });
};

const unsupportedAt = (
  source: string,
  startOffset: number,
  endOffset = startOffset + 1,
): Result<never, MdxRelayIssue> =>
  err(
    createIssue(
      ISSUE_CODES.unsupportedMarkdown,
      {},
      {
        sourceRange: freezeRange(
          pointAtOffset(source, startOffset),
          pointAtOffset(source, Math.min(source.length, endOffset)),
        ),
      },
    ),
  );

const hasClosingFence = (source: string, range: SourceRange): boolean => {
  const text = source.slice(range.start.offset, range.end.offset);
  const firstLine = text.split("\n", 1)[0]!;
  const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(firstLine)![1]!;
  const lastLine = text.split("\n").at(-1)!.replace(/\r$/u, "");
  const candidate = lastLine
    .slice(/^ {0,3}/u.exec(lastLine)![0].length)
    .trimEnd();
  return (
    candidate.length >= marker.length &&
    [...candidate].every((character) => character === marker[0])
  );
};

export function isOffsetProtected(
  ranges: readonly SourceRange[],
  offset: number,
): boolean {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle]!.end.offset <= offset) low = middle + 1;
    else high = middle;
  }
  const range = ranges[low];
  return range !== undefined && offset >= range.start.offset;
}

export function mergeSourceRanges(
  ...groups: readonly (readonly SourceRange[])[]
): readonly SourceRange[] {
  return Object.freeze(
    groups.flat().sort((left, right) => left.start.offset - right.start.offset),
  );
}

const rangesForTypes = (
  events: ReturnType<typeof postprocess>,
  tokenTypes: ReadonlySet<string>,
): readonly SourceRange[] =>
  Object.freeze(
    events
      .filter((event) => event[0] === "enter" && tokenTypes.has(event[1].type))
      .map((event) =>
        freezeRange(freezePoint(event[1].start), freezePoint(event[1].end)),
      )
      .sort((left, right) => left.start.offset - right.start.offset),
  );

export function findProtectedRanges(
  source: string,
  parser: typeof parse = parse,
): Result<MarkdownSourceRanges, MdxRelayIssue> {
  try {
    const events = postprocess(
      parser()
        .document()
        .write(preprocess()(source, "utf8", true)),
    );
    const code = rangesForTypes(events, protectedTokenTypes);
    const destinations = rangesForTypes(events, destinationTokenTypes);

    for (const range of code) {
      if (
        range.start.column <= 4 &&
        /^ {0,3}(?:`{3,}|~{3,})/u.test(
          source.slice(range.start.offset, range.end.offset),
        ) &&
        !hasClosingFence(source, range)
      ) {
        return unsupportedAt(source, range.start.offset, range.end.offset);
      }
    }

    const fence = /^ {0,3}(?:`{3,}|~{3,})/gmu;
    for (const match of source.matchAll(fence)) {
      if (!isOffsetProtected(code, match.index))
        return unsupportedAt(
          source,
          match.index,
          match.index + match[0].length,
        );
    }

    for (let offset = 0; offset < source.length; offset += 1) {
      if (isOffsetProtected(code, offset) || source[offset] !== "`") continue;
      let escapes = 0;
      for (let index = offset - 1; source[index] === "\\"; index -= 1)
        escapes += 1;
      if (escapes % 2 === 1) continue;
      let end = offset + 1;
      while (source[end] === "`") end += 1;
      return unsupportedAt(source, offset, end);
    }

    return ok(
      Object.freeze({
        code: Object.freeze(code),
        destinations: Object.freeze(destinations),
      }),
    );
  } catch {
    return unsupportedAt(source, 0, Math.min(1, source.length));
  }
}
