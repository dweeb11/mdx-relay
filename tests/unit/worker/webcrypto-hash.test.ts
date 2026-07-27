import { describe, expect, it } from "vitest";

import { sha256OfBytes } from "../../../src/canonical/hash";
import { sha256Digest } from "../../../src/worker/webcrypto-hash";

const bufferOf = (value: string): ArrayBuffer => {
  const bytes = new TextEncoder().encode(value);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
};

describe("sha256Digest", () => {
  it("hashes bytes to the canonical sha256:<hex> digest via Web Crypto", async () => {
    expect(await sha256Digest(new ArrayBuffer(0))).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256Digest(bufferOf("abc"))).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches the Node-backed parent digest for the same bytes", async () => {
    // Parent verification and the worker share this format; a divergence would
    // fail closed every honest completion as MALFORMED_WORKER_RESPONSE.
    const text = "mdx-relay-webcrypto-parity";
    expect(await sha256Digest(bufferOf(text))).toBe(
      sha256OfBytes(new TextEncoder().encode(text)),
    );
  });
});
