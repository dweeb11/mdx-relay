import { readFile } from "node:fs/promises";
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
      "Inline `[[code]] {raw} < 2` remains.",
      "~~~md",
      "> [!note] untouched",
      "![[inside.png]]",
      "~~~",
      "    [[indented]] {raw} < 2",
    ].join("\n");
    const result = await transformMarkdown(note(body), DPW_MIND_NET_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mdx).toContain(
      "A comparison is &lt; 3 and &#123;value&#125;.",
    );
    expect(result.value.mdx).toContain("`[[code]] {raw} < 2`");
    expect(result.value.mdx).toContain(
      "~~~md\n> [!note] untouched\n![[inside.png]]\n~~~",
    );
    expect(result.value.mdx).toContain("    [[indented]] {raw} < 2");
    expect(result.value.images).toEqual([]);
  });

  it("preserves ordinary HTML, links, hard breaks, and prose beginning with export", async () => {
    const body = [
      "exporting ideas is ordinary prose.",
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
      "[[Target|<Foo.Bar />]]",
      "[[Open|<]]>fragment[[Close|<]]/>",
      "[[Open|<]]Component />",
    ].join("\n");
    const result = await transformMarkdown(note(body), DPW_MIND_NET_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mdx).toContain("&lt;b");
    expect(result.value.mdx).toContain("&lt;Foo.Bar />");
    expect(result.value.mdx).toContain("&lt;>fragment&lt;/>");
    expect(result.value.mdx).toContain("&lt;Component />");
    expect(result.value.mdx).not.toContain("<Foo.Bar />");
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
    ["import", "import Thing from 'thing'"],
    ["export", "export const value = 1"],
    ["JSX", '<Component value="x" />'],
    ["inline JSX", 'prefix <Component value="x" /> suffix'],
    ["nested JSX", '<div className="shell"><Component /></div>'],
    ["wikilink alias JSX", "[[Target|<Component />]]"],
    ["wikilink alias fragment", "[[Target|<>fragment</>]]"],
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
