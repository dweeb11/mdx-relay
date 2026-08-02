import { describe, expect, it } from "vitest";

import { isCredentialBearingUrl } from "../../../src/profiles/portable-profile";
import { containsCredentialBearingOutput } from "../../../src/write/sealed-output-preflight";

const utf8 = (value: string) => new TextEncoder().encode(value);

describe("containsCredentialBearingOutput", () => {
  it("rejects credentials wherever they sit in generated output", () => {
    for (const output of [
      "https://deploy:s3cr3t@example.test/site.git",
      "Mirror: https://deploy:s3cr3t@example.test/site.git\n",
      "[mirror](https://deploy:s3cr3t@example.test/site.git)",
      "<https://user@example.test/repo>",
      "prefix\thttps://user:pw@example.test/x\tsuffix",
      "text https://deploy:pa,ss@example.test/site.git more",
      "user:pw@example.test/repo.git",
    ])
      expect(containsCredentialBearingOutput(utf8(output)), output).toBe(true);
  });

  it("rejects supported-scheme secrets that sit outside the userinfo", () => {
    // The canonical rule treats any query or fragment on a supported-scheme
    // URL as credential-bearing, so a run with no `@` must reach it unchanged.
    for (const output of [
      "https://example.invalid/site.git?access_token=secret",
      "[docs](https://example.test/search?q=1#top)",
      "Mirror: git://example.test/repo.git#token\n",
      "HTTPS://EXAMPLE.TEST/repo?t=1",
    ])
      expect(containsCredentialBearingOutput(utf8(output)), output).toBe(true);
  });

  it("accepts ordinary post content, links, and addresses", () => {
    for (const output of [
      "---\ntitle: Example\n---\n\nBody\n",
      "[docs](https://example.test/search)",
      "Ask alice@example.test about it.",
      "Clone git@example.test:owner/repo.git to start.",
      "ssh://git@example.test/owner/repo.git",
      "Note:something? is not a URL.",
      "",
    ])
      expect(containsCredentialBearingOutput(utf8(output)), output).toBe(false);
  });

  it("scans binary outputs, where metadata can carry the same leak", () => {
    const image = new Uint8Array([
      ...utf8("RIFF\0\0WEBP"),
      0x00,
      0xff,
      ...utf8("https://deploy:s3cr3t@example.test/site.git"),
      0x00,
    ]);
    expect(containsCredentialBearingOutput(image)).toBe(true);
  });

  it("inspects a bounded prefix of an unterminated run", () => {
    // A single run longer than the candidate bound is still rejected on its
    // userinfo, and a bounded run of filler never becomes a candidate.
    const long = `https://deploy:s3cr3t@example.test/${"a".repeat(10_000)}`;
    expect(containsCredentialBearingOutput(utf8(long))).toBe(true);
    expect(containsCredentialBearingOutput(utf8("a".repeat(10_000)))).toBe(
      false,
    );
  });

  it("rejects a URL-shaped run whose secret sits past the bounded prefix", () => {
    // Length must not buy safety: the query, fragment, or userinfo that decides
    // the canonical verdict can be pushed beyond the inspected prefix, so an
    // overlong candidate carrying one of those markers is refused outright.
    const filler = "a".repeat(3000);
    for (const output of [
      `https://example.test/${filler}?access_token=secret`,
      `https://example.test/${filler}#access_token=secret`,
      `Mirror: https://example.test/${filler}?access_token=secret\n`,
      `[docs](https://example.test/${filler}#tok)`,
      // Userinfo past the prefix, both with and without a leading scheme.
      `https://example.test/${filler}@evil.test/site.git`,
      `${filler}:s3cr3t@example.test/site.git`,
      `ssh://${filler}:s3cr3t@example.test/repo.git`,
    ])
      expect(containsCredentialBearingOutput(utf8(output)), output).toBe(true);
  });

  it("leaves overlong runs without risk markers alone", () => {
    // The bound is only relaxed for the markers a credential can hide behind;
    // ordinary long output -- a base64 image payload, a long path -- stays
    // acceptable.
    for (const output of [
      `data:image/png;base64,${"QUJD".repeat(3000)}`,
      `https://example.test/${"a".repeat(10_000)}/index.html`,
      `${"a".repeat(10_000)}\n`,
    ])
      expect(containsCredentialBearingOutput(utf8(output)), output).toBe(false);
  });

  it("rejects malformed supported-scheme credentials written with backslashes", () => {
    // The canonical rule rejects these as malformed supported-scheme URLs, so
    // splitting the run on backslashes must not turn them into safe-looking
    // fragments.
    const malformed = [
      String.raw`https:\\writer:token@example.invalid\site.git`,
      String.raw`ssh:\\writer:token@example.invalid\repo.git`,
      String.raw`git:\\writer:token@example.invalid\repo.git`,
    ];
    for (const url of malformed) {
      // The preflight must agree with the canonical rule, not approximate it.
      expect(isCredentialBearingUrl(url), `canonical: ${url}`).toBe(true);
      expect(containsCredentialBearingOutput(utf8(url)), url).toBe(true);
    }
    for (const output of [
      `Mirror: ${malformed[0]!}\n`,
      `[mirror](${malformed[1]!})`,
      // A backslash must not glue a credential URL to preceding text and hide
      // it from the split reading either.
      String.raw`see\https://deploy:s3cr3t@example.test/site.git`,
    ])
      expect(containsCredentialBearingOutput(utf8(output)), output).toBe(true);
  });

  it("keeps backslash-bearing prose acceptable", () => {
    for (const output of [
      String.raw`Escaped \*emphasis\* and a path C:\Users\alice\notes.md`,
      String.raw`A windows share \\server\share\file.md`,
      String.raw`Ask alice@example.test about \[brackets\].`,
    ])
      expect(containsCredentialBearingOutput(utf8(output)), output).toBe(false);
  });
});
