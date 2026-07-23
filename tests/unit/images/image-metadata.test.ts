import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ISSUE_CODES } from "../../../src/contracts/issues";
import {
  readExifOrientation,
  readImageHeader,
  sniffImageMime,
} from "../../../src/images/image-metadata";

const fixture = (name: string): Uint8Array =>
  new Uint8Array(
    readFileSync(
      fileURLToPath(new URL(`../../fixtures/images/${name}`, import.meta.url)),
    ),
  );

describe("sniffImageMime", () => {
  it("recognizes the supported container magic bytes", () => {
    expect(sniffImageMime(fixture("gradient.png"))).toBe("image/png");
    expect(sniffImageMime(fixture("gradient.jpg"))).toBe("image/jpeg");
    expect(sniffImageMime(fixture("gradient.webp"))).toBe("image/webp");
  });

  it("rejects unsupported and truncated inputs", () => {
    expect(
      sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38])),
    ).toBeUndefined(); // GIF
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8]))).toBeUndefined();
    expect(sniffImageMime(new Uint8Array())).toBeUndefined();
    // RIFF container that is not WEBP.
    const riffWave = new Uint8Array(12);
    riffWave.set([0x52, 0x49, 0x46, 0x46], 0);
    riffWave.set([0x57, 0x41, 0x56, 0x45], 8);
    expect(sniffImageMime(riffWave)).toBeUndefined();
  });
});

describe("readExifOrientation", () => {
  it("reads the orientation tag from a JPEG EXIF block", () => {
    expect(readExifOrientation("image/jpeg", fixture("oriented-6.jpg"))).toBe(
      6,
    );
  });

  it("defaults to upright when no EXIF orientation is present", () => {
    expect(readExifOrientation("image/jpeg", fixture("gradient.jpg"))).toBe(1);
    expect(readExifOrientation("image/webp", fixture("gradient.webp"))).toBe(1);
    expect(readExifOrientation("image/png", fixture("gradient.png"))).toBe(1);
  });

  it("fails closed to 1 on malformed JPEG marker data", () => {
    // SOI followed by a non-marker byte.
    expect(
      readExifOrientation(
        "image/jpeg",
        new Uint8Array([0xff, 0xd8, 0x00, 0x00]),
      ),
    ).toBe(1);
    // APP1 with a truncated length.
    expect(
      readExifOrientation(
        "image/jpeg",
        new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00]),
      ),
    ).toBe(1);
  });

  it("reads a WebP EXIF chunk orientation and tolerates missing chunks", () => {
    // Minimal RIFF/WEBP with an EXIF chunk carrying big-endian orientation 8.
    const tiff = [
      0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12,
      0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00,
    ];
    const chunkSize = tiff.length;
    const bytes = new Uint8Array(12 + 8 + chunkSize);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x57, 0x45, 0x42, 0x50], 8);
    bytes.set([0x45, 0x58, 0x49, 0x46], 12); // "EXIF"
    new DataView(bytes.buffer).setUint32(16, chunkSize, true);
    bytes.set(tiff, 20);
    expect(readExifOrientation("image/webp", bytes)).toBe(8);
    // A WEBP header with no chunks stays upright.
    expect(readExifOrientation("image/webp", bytes.subarray(0, 12))).toBe(1);
  });
});

/**
 * The cumulative decoded-work cap is a work cap, not a post-work report, so the
 * decode cost of a source must be knowable before the decode. These probe only
 * fixed-position container header fields and fail closed on anything else.
 */
describe("readImageHeader", () => {
  const png = (
    width: number,
    height: number,
    mutate?: (bytes: Uint8Array, view: DataView) => void,
  ): Uint8Array => {
    const bytes = new Uint8Array(33);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const view = new DataView(bytes.buffer);
    view.setUint32(8, 13, false);
    bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
    view.setUint32(16, width, false);
    view.setUint32(20, height, false);
    mutate?.(bytes, view);
    return bytes;
  };

  const sof = (width: number, height: number, marker = 0xc0): number[] => [
    0xff,
    marker,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    ...Array<number>(9).fill(0),
  ];

  const jpeg = (...segments: number[]): Uint8Array =>
    Uint8Array.from([0xff, 0xd8, ...segments]);

  const chunk = (id: string, payload: readonly number[]): number[] => {
    const size = [
      payload.length & 0xff,
      (payload.length >> 8) & 0xff,
      (payload.length >> 16) & 0xff,
      (payload.length >> 24) & 0xff,
    ];
    const padding = payload.length % 2 === 1 ? [0] : [];
    return [
      ...[...id].map((character) => character.charCodeAt(0)),
      ...size,
      ...payload,
      ...padding,
    ];
  };

  const riff = (...chunks: number[][]): Uint8Array => {
    const body = chunks.flat();
    const length = 4 + body.length;
    return Uint8Array.from([
      0x52,
      0x49,
      0x46,
      0x46, // "RIFF"
      length & 0xff,
      (length >> 8) & 0xff,
      (length >> 16) & 0xff,
      (length >> 24) & 0xff,
      0x57,
      0x45,
      0x42,
      0x50, // "WEBP"
      ...body,
    ]);
  };

  const uint24 = (value: number): number[] => [
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
  ];

  const vp8x = (width: number, height: number): number[] =>
    chunk("VP8X", [0, 0, 0, 0, ...uint24(width - 1), ...uint24(height - 1)]);

  const vp8Lossy = (width: number, height: number): number[] =>
    chunk("VP8 ", [
      0,
      0,
      0,
      0x9d,
      0x01,
      0x2a,
      width & 0xff,
      (width >> 8) & 0x3f,
      height & 0xff,
      (height >> 8) & 0x3f,
    ]);

  const vp8Lossless = (width: number, height: number): number[] => {
    const bits = (width - 1) | ((height - 1) << 14);
    return chunk("VP8L", [
      0x2f,
      bits & 0xff,
      (bits >>> 8) & 0xff,
      (bits >>> 16) & 0xff,
      (bits >>> 24) & 0xff,
    ]);
  };

  const size = (bytes: Uint8Array): unknown => {
    const header = readImageHeader(bytes);
    return header.ok
      ? [header.value.mime, header.value.width, header.value.height]
      : header.error.code;
  };

  it("reads the stored dimensions of every supported fixture format", () => {
    expect(size(fixture("gradient.png"))).toEqual(["image/png", 16, 12]);
    expect(size(fixture("gradient.jpg"))).toEqual(["image/jpeg", 16, 12]);
    expect(size(fixture("gradient.webp"))).toEqual(["image/webp", 16, 12]);
    expect(size(fixture("wide.png"))).toEqual(["image/png", 48, 12]);
  });

  it("reports the pre-orientation size of an EXIF-rotated source", () => {
    // orientation 6 presents 2x6, but the decoder still pays for the stored 6x2.
    expect(size(fixture("oriented-6.jpg"))).toEqual(["image/jpeg", 6, 2]);
  });

  it("reads all three WebP bitstream headers", () => {
    expect(size(riff(vp8Lossy(16, 12)))).toEqual(["image/webp", 16, 12]);
    expect(size(riff(vp8Lossless(16, 12)))).toEqual(["image/webp", 16, 12]);
    expect(size(riff(vp8x(1_000, 800)))).toEqual(["image/webp", 1_000, 800]);
    // Odd-sized leading chunks are padded; the walk must still find the frame.
    expect(size(riff(chunk("ICCP", [1, 2, 3]), vp8Lossy(4, 4)))).toEqual([
      "image/webp",
      4,
      4,
    ]);
  });

  it("reads a frame header that follows other JPEG segments", () => {
    expect(
      size(
        jpeg(
          0xff,
          0xe0,
          0x00,
          0x04,
          0x00,
          0x00, // APP0
          ...sof(1_600, 1_200, 0xc2), // progressive
        ),
      ),
    ).toEqual(["image/jpeg", 1_600, 1_200]);
  });

  it("reports an unrecognized container as UNSUPPORTED_IMAGE", () => {
    expect(size(Uint8Array.of(0x47, 0x49, 0x46, 0x38))).toBe(
      ISSUE_CODES.unsupportedImage,
    ); // GIF
    expect(size(new Uint8Array())).toBe(ISSUE_CODES.unsupportedImage);
  });

  it.each([
    ["a PNG truncated before IHDR", png(4, 4).subarray(0, 20)],
    [
      "a PNG whose first chunk is not IHDR",
      png(4, 4, (bytes) => bytes.set([0x67, 0x41, 0x4d, 0x41], 12)),
    ],
    [
      "a PNG with a non-13-byte IHDR",
      png(4, 4, (_bytes, view) => {
        view.setUint32(8, 12, false);
      }),
    ],
    ["a PNG declaring a zero edge", png(0, 4)],
    ["a JPEG with no frame header", jpeg(0xff, 0xd9)],
    ["a JPEG whose scan starts before any frame", jpeg(0xff, 0xda)],
    ["a JPEG with a truncated frame header", jpeg(...sof(4, 4).slice(0, 6))],
    [
      "a JPEG segment length running past the end",
      jpeg(0xff, 0xe0, 0x40, 0x00, 0x00),
    ],
    [
      "a JPEG segment followed by a non-marker byte",
      jpeg(0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00),
    ],
    [
      "a JPEG frame header shorter than its fields",
      jpeg(0xff, 0xc0, 0x00, 0x05, 0, 0, 0),
    ],
    ["a WebP with no bitstream chunk", riff(chunk("ICCP", [1, 2]))],
    ["a WebP chunk size past the end", riff(vp8Lossy(4, 4)).subarray(0, 18)],
    ["a truncated VP8L chunk", riff(chunk("VP8L", [0x2f, 0x00]))],
    ["a VP8L chunk with no signature", riff(chunk("VP8L", [0, 0, 0, 0, 0]))],
    [
      "a VP8 chunk with no start code",
      riff(chunk("VP8 ", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    ],
    ["a WebP header with no chunks at all", riff()],
  ])("fails closed on %s", (_name, bytes) => {
    expect(size(bytes)).toBe(ISSUE_CODES.imageDecodeFailed);
  });

  it("reports absurd declared dimensions rather than overflowing", () => {
    // 0xFFFFFFFF squared is far past MAX_SAFE_INTEGER: the probe reports the
    // declared edges exactly and leaves the ceiling decision to the caller.
    const header = readImageHeader(png(0xffffffff, 0xffffffff));
    expect(header.ok).toBe(true);
    if (!header.ok) return;
    expect([header.value.width, header.value.height]).toEqual([
      4_294_967_295, 4_294_967_295,
    ]);
    expect(Number.isSafeInteger(header.value.width)).toBe(true);
  });
});
