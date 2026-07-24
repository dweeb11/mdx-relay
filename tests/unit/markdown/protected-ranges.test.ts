import { describe, expect, it } from "vitest";

import { ISSUE_CODES } from "../../../src/contracts/issues";
import {
  findProtectedRanges,
  isOffsetProtected,
  mergeSourceRanges,
} from "../../../src/markdown/protected-ranges";

const protectedSlices = (source: string): readonly string[] => {
  const result = findProtectedRanges(source);
  expect(result.ok).toBe(true);
  if (!result.ok) return [];
  return result.value.code.map((range) =>
    source.slice(range.start.offset, range.end.offset),
  );
};

describe("findProtectedRanges", () => {
  it("uses micromark positions for matching inline delimiter lengths", () => {
    const source = "one `x` two ``a ` b`` three ```c `` d```";
    expect(protectedSlices(source)).toEqual([
      "`x`",
      "``a ` b``",
      "```c `` d```",
    ]);
  });

  it("protects backtick fences, tilde fences, and indented code exactly", () => {
    const source = [
      "before",
      "```ts",
      "[[inside]] {raw}",
      "```",
      "~~~md",
      "![[inside.png]]",
      "~~~",
      "    [[indented]] {raw}",
      "after",
    ].join("\n");
    expect(protectedSlices(source)).toEqual([
      "```ts\n[[inside]] {raw}\n```",
      "~~~md\n![[inside.png]]\n~~~",
      "    [[indented]] {raw}",
    ]);
  });

  it("preserves CRLF offsets and freezes ranges and points", () => {
    const source = "before\r\n`x`\r\nafter";
    const result = findProtectedRanges(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [range] = result.value.code;
    expect(source.slice(range!.start.offset, range!.end.offset)).toBe("`x`");
    expect(range!.start).toMatchObject({ line: 2, column: 1, offset: 8 });
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.code)).toBe(true);
    expect(Object.isFrozen(range)).toBe(true);
    expect(Object.isFrozen(range!.start)).toBe(true);
  });

  it("does not reject apostrophes or escaped backticks", () => {
    expect(protectedSlices("Dave's note and \\`literal\\` text")).toEqual([]);
  });

  it("reports membership at protected boundaries", () => {
    const source = "a `code` b";
    const result = findProtectedRanges(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const range = result.value.code[0]!;
    expect(isOffsetProtected(result.value.code, range.start.offset)).toBe(true);
    expect(isOffsetProtected(result.value.code, range.end.offset - 1)).toBe(
      true,
    );
    expect(isOffsetProtected(result.value.code, range.end.offset)).toBe(false);
  });

  it.each([
    ["unclosed inline", "before `unclosed"],
    ["unclosed double inline", "before ``unclosed"],
    ["unclosed backtick fence", "```ts\ncontent"],
    ["unclosed tilde fence", "~~~\ncontent"],
  ])("fails closed for %s with a source range", (_name, source) => {
    const result = findProtectedRanges(source);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ISSUE_CODES.unsupportedMarkdown);
    expect(result.error.sourceRange?.start.offset).toBeGreaterThanOrEqual(0);
    expect(result.error.sourceRange?.end.offset).toBeGreaterThan(
      result.error.sourceRange?.start.offset ?? -1,
    );
  });

  it("fails closed when a parser omits a source-looking fence", () => {
    const parser = (() => ({
      document: () => ({ write: () => [] }),
    })) as never;
    const result = findProtectedRanges("```ts\ncontent\n```", parser);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ISSUE_CODES.unsupportedMarkdown);
    expect(result.error.sourceRange?.start.offset).toBe(0);
  });

  it("fails closed when the parser throws", () => {
    const parser = (() => {
      throw new Error("synthetic parser failure");
    }) as never;
    const result = findProtectedRanges("x", parser);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ISSUE_CODES.unsupportedMarkdown);
    expect(result.error.sourceRange).toMatchObject({
      start: { offset: 0 },
      end: { offset: 1 },
    });
  });

  it("handles an empty parser failure range without leaking data", () => {
    const parser = (() => {
      throw new Error("synthetic parser failure");
    }) as never;
    const result = findProtectedRanges("", parser);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.sourceRange).toMatchObject({
      start: { offset: 0 },
      end: { offset: 0 },
    });
    expect(result.error.displayDetails).toEqual({
      summary: "The note contains unsupported Markdown or Obsidian syntax.",
    });
  });

  it("uses micromark positions for inline, image, and reference destinations", () => {
    const source = [
      "[ref](https://example.com/[[id]])",
      "![alt](https://example.com/[[id]].png)",
      "[ref][label]",
      "",
      "[label]: <https://example.com/[[id]]>",
    ].join("\n");
    const result = findProtectedRanges(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.destinations.map((range) =>
        source.slice(range.start.offset, range.end.offset),
      ),
    ).toEqual([
      "https://example.com/[[id]]",
      "https://example.com/[[id]].png",
      "https://example.com/[[id]]",
    ]);
    expect(Object.isFrozen(result.value.destinations)).toBe(true);
    expect(Object.isFrozen(result.value.destinations[0])).toBe(true);
  });
});

describe("mergeSourceRanges", () => {
  it("orders mixed code and destination ranges by start offset", () => {
    const source = "`code` then [ref](https://example.com/[[id]])";
    const result = findProtectedRanges(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const merged = mergeSourceRanges(
      result.value.destinations,
      result.value.code,
    );
    expect(
      merged.map((range) => source.slice(range.start.offset, range.end.offset)),
    ).toEqual(["`code`", "https://example.com/[[id]]"]);
  });
});
