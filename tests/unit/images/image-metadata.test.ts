import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  readExifOrientation,
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
