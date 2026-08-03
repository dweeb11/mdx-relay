import { beforeEach, describe, expect, it, vi } from "vitest";

import { ISSUE_CODES } from "../../../src/contracts/issues";

const pngDecode = vi.fn();
const jpegDecode = vi.fn();
const webpDecode = vi.fn();
const webpEncode = vi.fn();

vi.mock("@jsquash/png/decode", () => ({
  init: vi.fn(async () => undefined),
  decode: (source: ArrayBuffer) => pngDecode(source),
}));

vi.mock("@jsquash/webp/utils", () => ({
  initEmscriptenModule: vi.fn(async (factory: unknown) => {
    if (factory === "jpeg") return { decode: jpegDecode };
    if (factory === "webp-dec") return { decode: webpDecode };
    return { encode: webpEncode };
  }),
}));

vi.mock("@jsquash/jpeg/codec/dec/mozjpeg_dec", () => ({
  default: "jpeg",
}));
vi.mock("@jsquash/webp/codec/dec/webp_dec", () => ({
  default: "webp-dec",
}));
vi.mock("@jsquash/webp/codec/enc/webp_enc", () => ({
  default: "webp-enc",
}));
vi.mock("@jsquash/webp/meta", () => ({
  defaultOptions: { quality: 75 },
}));

const { createPortableWebpCodec } =
  await import("../../../src/images/portable-webp-codec");

const pngMagic = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
]).buffer;

const rgba = (width: number, height: number): ImageData =>
  ({
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  }) as ImageData;

describe("portable WebP codec fail-closed paths", () => {
  beforeEach(() => {
    pngDecode.mockReset();
    jpegDecode.mockReset();
    webpDecode.mockReset();
    webpEncode.mockReset();
  });

  const codec = () =>
    createPortableWebpCodec({
      pngDecode: {} as WebAssembly.Module,
      jpegDecode: {} as WebAssembly.Module,
      webpDecode: {} as WebAssembly.Module,
      webpEncode: {} as WebAssembly.Module,
    });

  it("blocks a decode that yields no usable pixels", async () => {
    pngDecode.mockResolvedValue(rgba(0, 0));
    const result = await codec().transform(pngMagic, {
      maxDimension: 2000,
      webpQuality: 85,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ISSUE_CODES.imageDecodeFailed);
  });

  it("blocks a decode whose pixel count exceeds the locked ceiling", async () => {
    // 8001 * 5000 = 40_005_000 > decodedImagePixels (40_000_000).
    pngDecode.mockResolvedValue(rgba(8_001, 5_000));
    const result = await codec().transform(pngMagic, {
      maxDimension: 2000,
      webpQuality: 85,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ISSUE_CODES.decodedImageTooLarge);
  });

  it("blocks when the WebP encoder throws", async () => {
    pngDecode.mockResolvedValue(rgba(2, 2));
    webpEncode.mockImplementation(() => {
      throw new Error("encode boom");
    });
    const result = await codec().transform(pngMagic, {
      maxDimension: 2000,
      webpQuality: 85,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ISSUE_CODES.imageEncodeFailed);
  });

  it("blocks when the WebP encoder returns empty bytes", async () => {
    pngDecode.mockResolvedValue(rgba(2, 2));
    webpEncode.mockReturnValue(new Uint8Array());
    const result = await codec().transform(pngMagic, {
      maxDimension: 2000,
      webpQuality: 85,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ISSUE_CODES.imageEncodeFailed);
  });
});
