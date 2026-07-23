import { createHash } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { ISSUE_CODES } from "../../../src/contracts/issues";
import type { ImageCodec } from "../../../src/images/image-codec";
import { createPortableWebpCodec } from "../../../src/images/portable-webp-codec";
import { imageFixture, loadCodecWasm } from "../../helpers/codec-wasm";

const sha256 = (bytes: ArrayBuffer): string =>
  createHash("sha256").update(new Uint8Array(bytes)).digest("hex");

// Deterministic WebP output hashes for the pinned codec WASM. Recorded on
// arm64 macOS; WebAssembly execution is defined, so x86_64 is expected to match.
const EXPECTED = {
  png: "56537a3799f105e50bc5e30d4723bd1b71f483ac915070f78e34d4c051dfdff6",
  jpeg: "dd84baffebaa6ef929bff9aafa935159b4225c49bb51561a3ebdf1517997ad0d",
  webp: "9ab4e6ae4eb722cba49a33360ea03ae0857d8f51e4be9e07cee3e61e47a087fe",
} as const;

const quality85 = { maxDimension: 2000, webpQuality: 85 } as const;

let codec: ImageCodec;

beforeAll(async () => {
  codec = createPortableWebpCodec(await loadCodecWasm());
});

describe("portable WebP codec", () => {
  it("decodes PNG, JPEG, and WebP sources to WebP", async () => {
    for (const [name, mime] of [
      ["gradient.png", "image/png"],
      ["gradient.jpg", "image/jpeg"],
      ["gradient.webp", "image/webp"],
    ] as const) {
      const result = await codec.transform(await imageFixture(name), quality85);
      expect(result.ok, name).toBe(true);
      if (!result.ok) return;
      expect(result.value.decodedMime).toBe(mime);
      expect([result.value.width, result.value.height]).toEqual([16, 12]);
      expect(result.value.bytes.byteLength).toBeGreaterThan(0);
    }
  });

  it("produces byte-identical WebP across repeated runs", async () => {
    const source = await imageFixture("gradient.png");
    const first = await codec.transform(source, quality85);
    const second = await codec.transform(
      await imageFixture("gradient.png"),
      quality85,
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(sha256(first.value.bytes)).toBe(sha256(second.value.bytes));
  });

  it("matches the recorded deterministic output hash per source format", async () => {
    const actual: Record<string, string> = {};
    for (const [name, key] of [
      ["gradient.png", "png"],
      ["gradient.jpg", "jpeg"],
      ["gradient.webp", "webp"],
    ] as const) {
      const result = await codec.transform(await imageFixture(name), quality85);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      actual[key] = sha256(result.value.bytes);
    }
    expect(actual).toEqual(EXPECTED);
  });

  it("applies EXIF orientation, rotating a 6x2 source upright to 2x6", async () => {
    const result = await codec.transform(
      await imageFixture("oriented-6.jpg"),
      quality85,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decodedMime).toBe("image/jpeg");
    expect([result.value.width, result.value.height]).toEqual([2, 6]);
  });

  it("downscales without upscaling", async () => {
    const shrunk = await codec.transform(await imageFixture("wide.png"), {
      maxDimension: 24,
      webpQuality: 85,
    });
    expect(shrunk.ok).toBe(true);
    if (!shrunk.ok) return;
    expect([shrunk.value.width, shrunk.value.height]).toEqual([24, 6]);

    const untouched = await codec.transform(
      await imageFixture("gradient.png"),
      quality85,
    );
    expect(untouched.ok).toBe(true);
    if (!untouched.ok) return;
    expect([untouched.value.width, untouched.value.height]).toEqual([16, 12]);
  });

  it("reports the raw decoded source size, before orientation and resize", async () => {
    // The cumulative decoded-work budget is measured in decode cost, so these
    // must describe the source the codec actually decoded, not the output.
    const shrunk = await codec.transform(await imageFixture("wide.png"), {
      maxDimension: 24,
      webpQuality: 85,
    });
    expect(shrunk.ok).toBe(true);
    if (!shrunk.ok) return;
    expect([shrunk.value.decodedWidth, shrunk.value.decodedHeight]).toEqual([
      48, 12,
    ]);
    expect([shrunk.value.width, shrunk.value.height]).toEqual([24, 6]);

    // Orientation 6 transposes the output but not the decoded source.
    const oriented = await codec.transform(
      await imageFixture("oriented-6.jpg"),
      quality85,
    );
    expect(oriented.ok).toBe(true);
    if (!oriented.ok) return;
    expect([oriented.value.decodedWidth, oriented.value.decodedHeight]).toEqual(
      [6, 2],
    );
    expect([oriented.value.width, oriented.value.height]).toEqual([2, 6]);
  });

  it("blocks unsupported formats with a stable issue code", async () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]).buffer;
    const result = await codec.transform(gif, quality85);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ISSUE_CODES.unsupportedImage);
  });

  it("blocks a corrupt but well-signed image as a decode failure", async () => {
    const corrupt = new Uint8Array(64);
    corrupt.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const result = await codec.transform(corrupt.buffer, quality85);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ISSUE_CODES.imageDecodeFailed);
  });
});
