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

  it("rejects a URL that starts after non-delimiter punctuation", () => {
    // A URL does not have to start where a run starts. Attribute syntax and
    // ordinary prose punctuation glue one to the preceding text, and none of
    // `=`, `,`, `;`, `:` or `.` ends a run, so the scheme has to be found at
    // its own offset rather than assumed to sit at the run start.
    for (const output of [
      "href=https://example.test/search?access_token=secret",
      "src=https://user:pw@example.test/repo.git",
      "x,https://example.test/repo#token",
      "<img src=https://user:pw@example.test/logo.png alt=logo />",
      '<a href="https://example.test/x?token=secret">docs</a>',
      "Mirrors:https://user:pw@example.test/site.git",
      "Mirrors;https://example.test/site.git?token=secret",
      "See(https://example.test/a)and,https://example.test/b#tok",
      "Ends here.https://user:pw@example.test/repo.git",
      "SRC=HTTPS://USER:PW@EXAMPLE.TEST/REPO.GIT",
      // The scheme-less forms the canonical rule also classifies keep working
      // after punctuation, where the run start is still the URL start.
      "clone=user:pw@example.test/repo.git",
    ])
      expect(containsCredentialBearingOutput(utf8(output)), output).toBe(true);
  });

  it("rejects a scheme-less credential URL that starts after a slash", () => {
    // A scheme-less credential form has no scheme to be found at its own
    // offset, and `/` does not end a run, so a single slash in front of one
    // would otherwise hide it from a gate that only reads the run start. The
    // canonical rule is what decides each of these; the offset is this
    // module's job to find.
    for (const output of [
      "/user:pw@example.test/repo.git",
      "see/user:pw@example.test/repo.git",
      "See the mirror at /user:pw@example.test/repo.git today.",
      "Clone ./user:pw@example.test/repo.git into place.",
      "[mirror](/user:pw@example.test/repo.git)",
      "<img src=/user:pw@example.test/logo.png alt=logo />",
      "a/b/c/user:pw@example.test/repo.git",
      "see/user:pw@example.test:owner/repo.git",
      // A run that opens with the separator hides the same form one character
      // further on.
      ":user:pw@example.test/repo.git",
    ]) {
      expect(containsCredentialBearingOutput(utf8(output)), output).toBe(true);
    }
  });

  it("does not let an earlier harmless address hide a later credential", () => {
    // The first `@` in the run belongs to something the canonical rule clears,
    // so anchoring on it alone would clear the whole run. Each `@` gets its own
    // candidate, starting where an embedded scheme-less form could start.
    for (const output of [
      "x@y:pw@example.test/repo.git",
      "see/x@y:pw@example.test/repo.git",
      "alice@example.test,deploy:s3cr3t@example.test/site.git",
      "Contact alice@example.test/user:pw@example.test/repo.git",
    ]) {
      expect(containsCredentialBearingOutput(utf8(output)), output).toBe(true);
    }
  });

  it("keeps multi-address prose and slash-bearing text acceptable", () => {
    // Finding a start after every `/` and `@` must not turn ordinary addresses,
    // paths, and SCP-style remotes into rejections.
    for (const output of [
      "Mail alice@example.test,bob@example.test today.",
      "see/git@example.test:owner/repo.git",
      "Notes at notes/2024/alice@example.test are fine.",
      "a/b@c/d.md",
      "https://example.test/a/b@c/d.png",
    ]) {
      expect(containsCredentialBearingOutput(utf8(output)), output).toBe(false);
    }
  });

  it("agrees with the canonical rule about the embedded candidate", () => {
    // The verdict stays the canonical rule's, not an approximation of it: what
    // this module adds is the offset the candidate begins at.
    for (const [prefix, url] of [
      ["/", "user:pw@example.test/repo.git"],
      ["see/", "user:pw@example.test/repo.git"],
      ["x@", "y:pw@example.test/repo.git"],
    ] as const) {
      expect(isCredentialBearingUrl(url), `canonical: ${url}`).toBe(true);
      expect(isCredentialBearingUrl(prefix + url), `run: ${prefix}${url}`).toBe(
        false,
      );
      expect(
        containsCredentialBearingOutput(utf8(prefix + url)),
        `${prefix}${url}`,
      ).toBe(true);
    }
  });

  it("rejects an embedded URL whose secret sits past the bounded prefix", () => {
    // Fail-closed behaviour is measured from the candidate's own start, not
    // from the run start, so padding in front of the scheme buys nothing.
    const filler = "a".repeat(3000);
    for (const output of [
      `href=https://example.test/${filler}?access_token=secret`,
      `src=https://example.test/${filler}@evil.test/site.git`,
      `x,ssh://${filler}:s3cr3t@example.test/repo.git`,
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
      // Finding a scheme at any offset must not turn plain embedded links into
      // rejections: these carry no query, fragment, or userinfo at all.
      "href=https://example.test/search",
      '<img src="https://example.test/logo.png" alt="logo" />',
      "See(https://example.test/a)and,https://example.test/b",
      "Ends here.https://example.test/repo.git",
      "clone=git@example.test:owner/repo.git",
      "Mail alice@example.test, then read https://example.test/docs.",
      String.raw`Open C:\Users\alice\notes.md, then https://example.test/x`,
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
      // Measured from the embedded candidate's own start as well.
      `see/${filler}:s3cr3t@example.test/site.git`,
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
