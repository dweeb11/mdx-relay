import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const CODEQL_USES =
  /uses:\s+(?<spec>github\/codeql-action\/[^@\s]+@[^\s]+)(?:\s+#\s+(?<comment>[^\n]*))?/g;

const PINNED_RELEASE =
  /^github\/codeql-action\/[^@\s]+@(?<sha>[a-f0-9]{40})$/;

const VERSION_COMMENT = /^v\d+\.\d+\.\d+$/;

function collectCodeqlPins(workflow: string): string[] {
  const uses = [...workflow.matchAll(CODEQL_USES)].map(({ groups }) => ({
    spec: groups?.spec ?? "",
    comment: groups?.comment?.trim() ?? "",
  }));

  expect(uses.length).toBeGreaterThan(0);

  return uses.map(({ spec, comment }) => {
    const pin = PINNED_RELEASE.exec(spec);
    const sha = pin?.groups?.sha;
    expect(sha, `CodeQL step must use a 40-char SHA pin: ${spec}`).toMatch(
      /^[a-f0-9]{40}$/,
    );
    expect(
      comment,
      `CodeQL step must include a semantic version comment: ${spec}`,
    ).toMatch(VERSION_COMMENT);
    return `${sha} ${comment}`;
  });
}

describe("CodeQL workflow", () => {
  it("keeps every CodeQL action on the same pinned release", () => {
    const workflow = readFileSync(
      new URL("../../../.github/workflows/codeql.yml", import.meta.url),
      "utf8",
    );
    const pins = collectCodeqlPins(workflow);

    expect(new Set(pins).size).toBe(1);
  });

  it("rejects tags, malformed SHAs, and missing version comments", () => {
    const cases = [
      "uses: github/codeql-action/init@v4.37.3",
      "uses: github/codeql-action/init@e4fba868fa4b1b91e1fdab776edc8cfbe6e9fb8 # v4.37.3",
      "uses: github/codeql-action/init@e4fba868fa4b1b91e1fdab776edc8cfbe6e9fb81",
      [
        "uses: github/codeql-action/init@e4fba868fa4b1b91e1fdab776edc8cfbe6e9fb81 # v4.37.3",
        "uses: github/codeql-action/analyze@v4.37.3",
      ].join("\n"),
    ];

    for (const workflow of cases) {
      expect(() => collectCodeqlPins(workflow)).toThrow();
    }
  });

  it("rejects mismatched pinned releases across CodeQL steps", () => {
    const workflow = [
      "uses: github/codeql-action/init@e4fba868fa4b1b91e1fdab776edc8cfbe6e9fb81 # v4.37.3",
      "uses: github/codeql-action/analyze@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # v4.37.2",
    ].join("\n");

    const pins = collectCodeqlPins(workflow);
    expect(new Set(pins).size).toBeGreaterThan(1);
  });
});
