import { describe, expect, it } from "vitest";

import { ISSUE_CODES } from "../../../src/contracts/issues";
import {
  parseFrontmatter,
  serializeFrontmatter,
  slugify,
  type DpwPostFrontmatter,
} from "../../../src/markdown/frontmatter";

const validSource = (overrides = ""): string =>
  [
    "---",
    "title: A Public Example’s Contract",
    "date: 26.07.22",
    "summary: Synthetic summary",
    "labels: [public, synthetic]",
    "topic: examples",
    'msg: "#001"',
    "read: 3 min",
    overrides,
    "---",
    "Body bytes.  ",
  ]
    .filter((line) => line !== "")
    .join("\n");

const metadata: DpwPostFrontmatter = Object.freeze({
  title: "A title",
  date: "26.07.22",
  summary: "combat design thoughts",
  labels: Object.freeze(["site"]),
  topic: "games",
  msg: "#002",
  read: "3 min",
});

describe("slugify", () => {
  it("preserves the source CLI compatibility rules", () => {
    expect(slugify("Every Part of a Sandbox Answers a Question")).toBe(
      "every-part-of-a-sandbox-answers-a-question",
    );
    expect(slugify("Dave’s BBS!")).toBe("daves-bbs");
    expect(slugify("  déjà vu  ")).toBe("d-j-vu");
  });
});

describe("serializeFrontmatter", () => {
  it("emits canonical order and quotes date and msg", () => {
    expect(serializeFrontmatter(metadata)).toBe(
      [
        "---",
        "title: A title",
        'date: "26.07.22"',
        "summary: combat design thoughts",
        "labels: [site]",
        "topic: games",
        'msg: "#002"',
        "read: 3 min",
        "---",
      ].join("\n"),
    );
  });

  it("safely serializes quoted and multiline scalar values", () => {
    expect(
      serializeFrontmatter({
        ...metadata,
        title: "a: title",
        labels: Object.freeze(["line\nbreak", "hash # label"]),
      }),
    ).toContain('labels: ["line\\nbreak", "hash # label"]');
  });
});

describe("parseFrontmatter", () => {
  it("parses YAML, drops unknown keys, preserves body bytes, and freezes output", () => {
    const source = validSource("unknown: drop-me");
    const result = parseFrontmatter(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.slug).toBe("a-public-examples-contract");
    expect(result.value.body).toBe("Body bytes.  ");
    expect(source.slice(result.value.bodyOffset)).toBe(result.value.body);
    expect(result.value.frontmatter).not.toContain("unknown");
    expect(result.value.metadata.labels).toEqual(["public", "synthetic"]);
    expect(result.value.warnings).toEqual([]);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.metadata)).toBe(true);
    expect(Object.isFrozen(result.value.metadata.labels)).toBe(true);
    expect(Object.isFrozen(result.value.warnings)).toBe(true);
  });

  it("accepts BOM/CRLF and finite numeric dates", () => {
    const source =
      "\uFEFF---\r\ntitle: Numbered\r\ndate: 20260722\r\nsummary: yes\r\nlabels: []\r\n---\r\nbody";
    const result = parseFrontmatter(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.metadata.date).toBe("20260722");
    expect(result.value.body).toBe("body");
  });

  it("uses untitled when title is absent and drops non-string scalar labels", () => {
    const result = parseFrontmatter(
      "---\ndate: 1\nsummary: ok\nlabels: [good, 2, true, null]\n---\nbody",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.slug).toBe("untitled");
    expect(result.value.metadata.labels).toEqual(["good"]);
    expect(result.value.metadata.topic).toBe("");
  });

  it("emits stable aggregate warning codes for missing summary and duplicate msg", () => {
    const result = parseFrontmatter(
      "---\ntitle: Warning\nsummary: '  '\nmsg: '#002'\n---\nbody",
      { existingMessages: ["#002"] },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings.map((issue) => issue.code)).toEqual([
      ISSUE_CODES.summaryMissing,
      ISSUE_CODES.duplicateMessageField,
    ]);
  });

  it.each([
    ["missing opener", "title: nope\n---\nbody"],
    ["missing closer", "---\ntitle: nope\nbody"],
    ["invalid yaml", "---\ntitle: [unterminated\n---\nbody"],
    ["duplicate keys", "---\ntitle: one\ntitle: two\n---\nbody"],
    ["non-map root", "---\n- one\n- two\n---\nbody"],
    ["comment-only root", "---\n# only a comment\n---\nbody"],
    ["alias", "---\ntitle: &name hi\nsummary: *name\n---\nbody"],
    ["custom tag", "---\ntitle: !thing hi\n---\nbody"],
    ["non-string key", "---\n1: value\n---\nbody"],
    ["non-finite date", "---\ntitle: x\ndate: .inf\n---\nbody"],
    ["boolean date", "---\ntitle: x\ndate: true\n---\nbody"],
    ["labels not array", "---\ntitle: x\nlabels: no\n---\nbody"],
    ["nested label", "---\ntitle: x\nlabels: [ok, {bad: value}]\n---\nbody"],
  ])("blocks %s with redacted INVALID_FRONTMATTER", (_name, source) => {
    const result = parseFrontmatter(source);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ISSUE_CODES.invalidFrontmatter);
    expect(result.error.displayDetails).toEqual({
      summary: "The note frontmatter is invalid.",
    });
  });
});
