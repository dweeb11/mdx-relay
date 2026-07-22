import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { ISSUE_CODES } from "../../../src/contracts/issues";
import {
  transformMarkdown,
  transformNote,
} from "../../../src/markdown/transform";
import { validateMdx } from "../../../src/markdown/validate-mdx";
import { DPW_MIND_NET_V1 } from "../../../src/profiles/builtins/dpw-mind-net-v1";
import type { PortableProfileV1 } from "../../../src/profiles/profile-schema";

const note = (body: string, frontmatter = ""): string =>
  [
    "---",
    "title: Synthetic Note",
    "date: 26.07.22",
    "summary: Public synthetic fixture",
    "labels: [public]",
    "topic: examples",
    'msg: "#002"',
    "read: 3 min",
    frontmatter,
    "---",
    body,
  ]
    .filter((line) => line !== "")
    .join("\n");

const issueCount = (
  issues: readonly {
    readonly code: string;
    readonly displayDetails: { readonly count?: number };
  }[],
  code: string,
): number | undefined =>
  issues.find((issue) => issue.code === code)?.displayDetails.count;

describe("transformMarkdown", () => {
  it("matches the sanitized public compatibility fixture", async () => {
    const root = fileURLToPath(
      new URL("../../fixtures/public-baseline/", import.meta.url),
    );
    const [source, expectedMdx, expectedMetadataText] = await Promise.all([
      readFile(`${root}source-note.md`, "utf8"),
      readFile(`${root}expected.mdx`, "utf8"),
      readFile(`${root}expected-metadata.json`, "utf8"),
    ]);
    const expectedMetadata = JSON.parse(expectedMetadataText) as {
      slug: string;
      images: readonly unknown[];
      issueCodes: readonly string[];
    };

    const result = await transformMarkdown(source, DPW_MIND_NET_V1, {
      existingMessages: ["#001"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mdx).toBe(expectedMdx);
    expect(result.value.slug).toBe(expectedMetadata.slug);
    expect(result.value.images).toEqual(expectedMetadata.images);
    expect(result.value.issues.map((issue) => issue.code)).toEqual(
      expectedMetadata.issueCodes,
    );
  });

  it("flattens wikilinks, callouts, and images with aggregate counts", async () => {
    const source = note(
      [
        "[[One]] and [[Two|second]] and [[Braces|{label}]] and [[Less|a < 2]].",
        "> [!note]+ Title",
        "> body",
        "> [!warning]-",
        "![[first.PNG|600]] ![[second.jpg|alias]]",
      ].join("\n"),
    );
    const result = await transformMarkdown(source, DPW_MIND_NET_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.mdx).toContain(
      "One and second and &#123;label&#125; and a &lt; 2.",
    );
    expect(result.value.mdx).toContain("> Title\n> body\n>");
    expect(result.value.mdx).toContain(
      '<PostImage src="/posts/synthetic-note/img-1.webp" alt="" />',
    );
    expect(result.value.mdx).toContain(
      '<PostImage src="/posts/synthetic-note/img-2.webp" alt="" />',
    );
    expect(result.value.images).toEqual([
      { source: "first.PNG", destination: "img-1.webp" },
      { source: "second.jpg", destination: "img-2.webp" },
    ]);
    expect(
      issueCount(result.value.issues, ISSUE_CODES.wikilinksFlattened),
    ).toBe(4);
    expect(issueCount(result.value.issues, ISSUE_CODES.calloutsConverted)).toBe(
      2,
    );
    expect(issueCount(result.value.issues, ISSUE_CODES.mdxEscaped)).toBe(3);
    expect(
      issueCount(result.value.issues, ISSUE_CODES.imageAltTextMissing),
    ).toBe(2);
  });

  it("uses profile-driven component, URL, and filename templates", async () => {
    const profile: PortableProfileV1 = Object.freeze({
      ...DPW_MIND_NET_V1,
      output: Object.freeze({
        ...DPW_MIND_NET_V1.output,
        assetUrlTemplate: "/assets/{slug}/{assetFile}",
      }),
      images: Object.freeze({
        ...DPW_MIND_NET_V1.images,
        component: "Article.Image",
        filenameTemplate: "photo-{index}.webp",
      }),
    });
    const result = await transformMarkdown(note("![[photo.webp]]"), profile);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mdx).toContain(
      '<Article.Image src="/assets/synthetic-note/photo-1.webp" alt="" />',
    );
    expect(result.value.images).toEqual([
      { source: "photo.webp", destination: "photo-1.webp" },
    ]);
  });

  it("escapes prose but preserves inline, fenced, and indented code bytes", async () => {
    const body = [
      "A comparison is < 3 and {value}.",
      'Inline `[[code]] {raw} < 2 import"side-effect" export*from"pkg"` remains.',
      "~~~md",
      "> [!note] untouched",
      "![[inside.png]]",
      'import"side-effect"',
      'export*from"pkg"',
      "~~~",
      '    [[indented]] {raw} < 2 import"side-effect" export*from"pkg"',
    ].join("\n");
    const result = await transformMarkdown(note(body), DPW_MIND_NET_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mdx).toContain(
      "A comparison is &lt; 3 and &#123;value&#125;.",
    );
    expect(result.value.mdx).toContain(
      '`[[code]] {raw} < 2 import"side-effect" export*from"pkg"`',
    );
    expect(result.value.mdx).toContain(
      '~~~md\n> [!note] untouched\n![[inside.png]]\nimport"side-effect"\nexport*from"pkg"\n~~~',
    );
    expect(result.value.mdx).toContain(
      '    [[indented]] {raw} < 2 import"side-effect" export*from"pkg"',
    );
    expect(result.value.images).toEqual([]);
  });

  it("preserves ordinary HTML, links, hard breaks, and prose beginning with export", async () => {
    const body = [
      "exporting ideas is ordinary prose.",
      "important and exportable are ordinary prose words.",
      '<div className="notice">valid HTML</div>',
      "A [normal link](https://example.invalid/page) remains.  ",
      "An [external attachment link](https://example.invalid/archive.7z) remains.",
      "A [protocol-relative link](//cdn.example.invalid/archive.7z) remains.",
      "An [anchor](#section) remains.",
      "[Current](.) and [parent](..) directory links remain.",
      "Hard-break continuation.",
    ].join("\n\n");
    const result = await transformMarkdown(note(body), DPW_MIND_NET_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mdx).toContain(body);
  });

  it("blocks compiler-incompatible CommonMark autolinks as INVALID_MDX", async () => {
    const result = await transformMarkdown(
      note("<https://example.invalid/path>"),
      DPW_MIND_NET_V1,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ISSUE_CODES.invalidMdx);
  });

  it("handles a titleless callout at end of file", async () => {
    const result = await transformMarkdown(note("> [!note]"), DPW_MIND_NET_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mdx.endsWith(">")).toBe(true);
    expect(issueCount(result.value.issues, ISSUE_CODES.calloutsConverted)).toBe(
      1,
    );
  });

  it("escapes alias text that could compose executable MDX", async () => {
    const body = [
      "[[Target|<b]]",
      "[[Target|<]]",
      "[[Target|<Component />]]",
      "[[Target|<>fragment</>]]",
      "[[Target|<Foo.Bar />]]",
      "[[Target|<svg:path />]]",
      "[[Open|<]]>fragment[[Close|<]]/>",
      "[[Open|<]]Component />",
    ].join("\n");
    const result = await transformMarkdown(note(body), DPW_MIND_NET_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mdx).toContain("&lt;b");
    expect(result.value.mdx).toContain("&lt;Foo.Bar />");
    expect(result.value.mdx).toContain("&lt;svg:path />");
    expect(result.value.mdx).toContain("&lt;>fragment&lt;/>");
    expect(result.value.mdx).toContain("&lt;Component />");
    expect(result.value.mdx).not.toContain("<Foo.Bar />");
    expect(result.value.mdx).not.toContain("<svg:path />");
    expect(result.value.mdx).not.toContain("<>fragment</>");
    expect(result.value.mdx).not.toContain("<Component />");
  });

  it("reports invalid MDX for a literal trailing less-than", async () => {
    const result = await transformMarkdown(note("trailing <"), DPW_MIND_NET_V1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ISSUE_CODES.invalidMdx);
  });

  it("returns immutable plain output and exposes transformNote as the same operation", async () => {
    expect(transformNote).toBe(transformMarkdown);
    const result = await transformNote(note("No edits."), DPW_MIND_NET_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.issues).toEqual([]);
    expect(result.value.images).toEqual([]);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.issues)).toBe(true);
    expect(Object.isFrozen(result.value.images)).toBe(true);
  });

  it("propagates invalid frontmatter without transforming body content", async () => {
    const result = await transformMarkdown(
      "not frontmatter\n{x}",
      DPW_MIND_NET_V1,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ISSUE_CODES.invalidFrontmatter);
  });

  it("rebases malformed code ranges to the original note", async () => {
    const source = note("before `unclosed");
    const bodyStart = source.indexOf("before");
    const result = await transformMarkdown(source, DPW_MIND_NET_V1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ISSUE_CODES.unsupportedMarkdown);
    expect(result.error.sourceRange?.start.offset).toBe(bodyStart + 7);
  });

  it.each([
    [
      "comment-separated import",
      'import/*gap*/"x"',
      'import/*gap*/"x"',
      { line: 10, column: 1 },
      { line: 10, column: 17 },
    ],
    [
      "multiline compact export",
      'export*\nfrom"x"',
      'export*\nfrom"x"',
      { line: 10, column: 1 },
      { line: 11, column: 8 },
    ],
    [
      "import followed by later inline code",
      'import"x";// `protected`',
      'import"x";',
      { line: 10, column: 1 },
      { line: 10, column: 11 },
    ],
  ])(
    "blocks %s at the exact declaration range",
    async (_name, body, declaration, expectedStart, expectedEnd) => {
      const source = note(body);
      const declarationStart = source.indexOf(declaration);
      const result = await transformMarkdown(source, DPW_MIND_NET_V1);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(ISSUE_CODES.unsupportedMarkdown);
      expect(result.error.sourceRange).toEqual({
        start: { ...expectedStart, offset: declarationStart },
        end: {
          ...expectedEnd,
          offset: declarationStart + declaration.length,
        },
      });
      expect(
        source.slice(
          result.error.sourceRange!.start.offset,
          result.error.sourceRange!.end.offset,
        ),
      ).toBe(declaration);
    },
  );

  it("allows prose controls and declarations wholly inside protected code", async () => {
    const body = [
      "important exportable prose remains ordinary.",
      '`import/*gap*/"x"`',
      "```js",
      "export*",
      'from"x"',
      "```",
    ].join("\n");
    const result = await transformMarkdown(note(body), DPW_MIND_NET_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mdx).toContain(body);
  });

  it.each([
    [
      "parenthesized candidate",
      'import/**/(\nimport"valid"\n)!',
      'import"valid"',
    ],
    ["comment span", 'export{}/*\nimport"a"\n*/from!', 'import"a"'],
  ])(
    "blocks a compact import consumed by an earlier failing %s",
    async (_name, body, declaration) => {
      const source = note(body);
      const declarationStart = source.indexOf(declaration);
      const result = await transformMarkdown(source, DPW_MIND_NET_V1);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(ISSUE_CODES.unsupportedMarkdown);
      expect(result.error.sourceRange?.start.offset).toBe(declarationStart);
      expect(result.error.sourceRange?.end.offset).toBe(
        declarationStart + declaration.length,
      );
    },
  );

  it("preserves module-shaped prose that never forms a compact declaration", async () => {
    const body = [
      "import/**/(0)",
      'export*from"a`b`c"',
      'export{a as b,c as b}from"x"',
    ].join("\n\n");
    const result = await transformMarkdown(note(body), DPW_MIND_NET_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mdx).toContain("import/**/(0)");
    expect(result.value.mdx).toContain('export*from"a`b`c"');
    expect(result.value.mdx).toContain(
      'export&#123;a as b,c as b&#125;from"x"',
    );
  });

  it("blocks the exact declaration after earlier protected code and Unicode prose", async () => {
    const body = 'α prose `code`\nimport"blocked";';
    const source = note(body);
    const declarationStart = source.indexOf('import"blocked";');
    const result = await transformMarkdown(source, DPW_MIND_NET_V1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ISSUE_CODES.unsupportedMarkdown);
    expect(result.error.sourceRange?.start.offset).toBe(declarationStart);
    expect(result.error.sourceRange?.end.offset).toBe(
      declarationStart + 'import"blocked";'.length,
    );
  });

  it.each([
    ["import", "import Thing from 'thing'"],
    ["compact side-effect import", 'import"side-effect"'],
    ["compact named import", 'import{x}from"pkg"'],
    ["compact namespace import", 'import*as ns from"pkg"'],
    ["export", "export const value = 1"],
    ["compact star export", 'export*from"pkg"'],
    ["compact named export", 'export{x}from"pkg"'],
    ["compact aliased export", 'export{default as value}from"pkg"'],
    ["JSX", '<Component value="x" />'],
    ["inline JSX", 'prefix <Component value="x" /> suffix'],
    ["nested JSX", '<div className="shell"><Component /></div>'],
    ["member JSX", "<Foo.Bar />"],
    ["inline member JSX", "prefix <Foo.Bar /> suffix"],
    ["namespaced JSX", "<svg:path />"],
    ["underscore JSX", "<_Component />"],
    ["dollar JSX", "<$Component />"],
    ["fragment", "<>fragment</>"],
    ["expression", "{dangerous}"],
    ["multiline expression", "{\n  dangerous\n}"],
    ["transclusion", "![[Other Note]]"],
    ["unsupported embed", "![[archive.zip]]"],
    ["external image embed", "![[https://example.invalid/photo.png]]"],
    ["file URL image embed", "![[file:///tmp/photo.png]]"],
    ["protocol-relative image embed", "![[//cdn.example.invalid/photo.png]]"],
    [
      "encoded external image embed",
      "![[https%3A%2F%2Fexample.invalid%2Fphoto.png]]",
    ],
    ["absolute image embed", "![[/tmp/photo.png]]"],
    ["anchor image embed", "![[#photo.png]]"],
    ["malformed image embed", "![[bad%E0%A4%A.png]]"],
    ["query extension smuggling", "![[photo.txt?as=photo.png]]"],
    ["fragment extension smuggling", "![[photo.txt#photo.png]]"],
    ["current-directory image", "![[./photo.png]]"],
    ["parent-directory image", "![[images/../photo.png]]"],
    ["embedded current-directory image", "![[images/./photo.png]]"],
    ["empty path segment image", "![[images//photo.png]]"],
    ["whitespace-padded image", "![[ photo.png ]]"],
    ["attachment wikilink", "[[document.pdf]]"],
    ["archive wikilink", "[[archive.7z]]"],
    ["ebook alias wikilink", "[[book.epub|book]]"],
    ["markdown image", "![alt](image.png)"],
    ["multiline markdown image", "![alt](\nimage.png\n)"],
    ["reference markdown image", "![alt][img]\n\n[img]: image.png"],
    ["generic attachment", "[file](document.pdf?download=1)"],
    ["generic attachment with title", '[file](document.pdf "download")'],
    ["reference attachment", "[file][doc]\n\n[doc]: document.pdf"],
    ["archive attachment", "[file](archive.7z)"],
    ["ebook attachment with title", '[book](book.epub "download")'],
    ["disk image reference", "[disk][asset]\n\n[asset]: installer.dmg"],
    ["data attachment", "[data](export.csv)"],
    ["file URL", "[file](file:///tmp/report)"],
    ["malformed encoded destination", "[bad](broken%E0%A4%A)"],
    ["dotfile attachment", "[file](.env)"],
    ["punctuated extension", "[file](archive.c++)"],
    ["Unicode extension", "[file](archive.épub)"],
    ["encoded dotfile", "[file](%2Eenv)"],
    ["escaped extension separator", "[file](document\\.pdf)"],
    ["decimal entity separator", "[file](document&#46;pdf)"],
    ["hex entity separator", "[file](document&#x2e;pdf)"],
    ["named entity separator", "[file](document&period;pdf)"],
    ["double-encoded separator", "[file](document%252Epdf)"],
    ["double-encoded path", "[file](folder%252Fdocument%252Epdf)"],
  ])(
    "blocks unsupported %s with a stable source range",
    async (_name, body) => {
      const source = note(body);
      const result = await transformMarkdown(source, DPW_MIND_NET_V1);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(ISSUE_CODES.unsupportedMarkdown);
      const range = result.error.sourceRange!;
      expect(range.start.offset).toBeGreaterThanOrEqual(source.indexOf(body));
      expect(range.end.offset).toBeGreaterThan(range.start.offset);
      expect(source.slice(range.start.offset, range.end.offset)).not.toBe("");
    },
  );

  it("handles thousands of protected spans within the bounded worker budget", async () => {
    const body = Array.from(
      { length: 2_500 },
      (_, index) => `\`${index}\` [[Note ${index}|label ${index}]]`,
    ).join(" ");
    const result = await transformMarkdown(note(body), DPW_MIND_NET_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mdx).toContain("`0` label 0");
    expect(result.value.mdx).toContain("`2499` label 2499");
    expect(
      issueCount(result.value.issues, ISSUE_CODES.wikilinksFlattened),
    ).toBe(2_500);
  }, 5_000);

  it("blocks valid compact ESM after thousands of malformed candidates", async () => {
    const malformed = Array.from({ length: 2_000 }, () => "import/*").join(
      "\n",
    );
    const source = note(`${malformed}\nimport"blocked";`);
    const declarationStart = source.lastIndexOf('import"blocked";');
    const result = await transformMarkdown(source, DPW_MIND_NET_V1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ISSUE_CODES.unsupportedMarkdown);
    expect(result.error.sourceRange?.start.offset).toBe(declarationStart);
    expect(result.error.sourceRange?.end.offset).toBe(
      declarationStart + 'import"blocked";'.length,
    );
  });

  it("accepts keyword-shaped prose at scale", async () => {
    const body = Array.from(
      { length: 800 },
      (_, index) => `export{prose line ${index}`,
    ).join("\n\n");
    const result = await transformMarkdown(note(body), DPW_MIND_NET_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mdx).toContain("export&#123;prose line 0");
    expect(result.value.mdx).toContain("export&#123;prose line 799");
  });

  it("accepts candidates whose terminated comment spans the note", async () => {
    const body = `${Array.from({ length: 300 }, () => "import/*a").join(
      "\n",
    )}\n*/ 0!`;
    const result = await transformMarkdown(note(body), DPW_MIND_NET_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mdx).toContain("import/*a");
  });

  it("fails closed when hostile candidates demand super-linear scanning", async () => {
    const body = Array.from({ length: 400 }, () => "import/**/(").join("\n");
    const source = note(body);
    const result = await transformMarkdown(source, DPW_MIND_NET_V1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ISSUE_CODES.unsupportedMarkdown);
    const range = result.error.sourceRange!;
    expect(source.slice(range.start.offset, range.end.offset)).toBe("import");
  });

  it("bounds repeated malformed compact ESM candidate scanning near-linearly", async () => {
    const time = async (line: string, lineCount: number): Promise<number> => {
      const body = Array.from({ length: lineCount }, () => line).join("\n\n");
      const startedAt = performance.now();
      const result = await transformMarkdown(note(body), DPW_MIND_NET_V1);
      const duration = performance.now() - startedAt;
      expect(result.ok).toBe(true);
      return duration;
    };
    for (const lineCount of [1_000, 4_000]) await time("import/*", lineCount);
    // `lmport/*` differs from the malformed candidate only in never matching
    // the compact-candidate prefix, so both notes pay identical Micromark and
    // serialization costs; comparing them cancels hardware and coverage
    // instrumentation speed and isolates candidate scanning. The committed
    // quadratic scanner spent ~6x the baseline at this scale; the bounded
    // scanner adds milliseconds. The margin is generous, not a benchmark.
    const baseline = await time("lmport/*", 10_000);
    const malformed = await time("import/*", 10_000);
    expect(malformed).toBeLessThan(baseline * 3 + 1_000);
  }, 30_000);

  it("returns INVALID_MDX when profile-driven emitted JSX does not compile", async () => {
    const profile = {
      ...DPW_MIND_NET_V1,
      images: { ...DPW_MIND_NET_V1.images, component: "123PostImage" },
    } as PortableProfileV1;
    const result = await transformMarkdown(note("![[photo.png]]"), profile);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ISSUE_CODES.invalidMdx);
    expect(result.error.displayDetails).toEqual({
      summary: "The generated document is invalid MDX.",
    });
  });
});

describe("validateMdx", () => {
  it("passes the exact function-body compile option", async () => {
    const compiler = vi.fn(() => undefined);
    const result = await validateMdx("# valid", compiler);
    expect(result.ok).toBe(true);
    expect(compiler).toHaveBeenCalledWith("# valid", {
      outputFormat: "function-body",
    });
  });

  it("redacts compiler failures", async () => {
    const result = await validateMdx("private source", () => {
      throw new Error("private source leaked from compiler");
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ISSUE_CODES.invalidMdx);
    expect(JSON.stringify(result.error)).not.toContain("private source");
  });
});
