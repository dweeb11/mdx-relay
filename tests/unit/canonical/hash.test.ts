import { describe, expect, it } from "vitest";

import {
  sha256OfBytes,
  sha256OfCanonical,
  sha256OfUtf8,
} from "../../../src/canonical/hash";

describe("sha256OfBytes / sha256OfUtf8", () => {
  it("hashes bytes and UTF-8 text with the sha256: digest prefix", () => {
    expect(sha256OfBytes(new TextEncoder().encode(""))).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256OfUtf8("")).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256OfUtf8("abc")).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("sha256OfCanonical", () => {
  it("digests the JCS form, matching a hand-written key-sorted object", () => {
    const value = {
      profileId: "dpw-mind-net",
      repositoryRoot: "/Users/example/sites/checkout",
      repositoryUrl: "https://example.invalid/checkout.git",
      schemaVersion: 1 as const,
    };
    // Field order below is already RFC 8785 code-unit order.
    const handRolled =
      '{"profileId":"dpw-mind-net","repositoryRoot":"/Users/example/sites/checkout","repositoryUrl":"https://example.invalid/checkout.git","schemaVersion":1}';
    expect(sha256OfCanonical(value)).toBe(sha256OfUtf8(handRolled));
  });
});
