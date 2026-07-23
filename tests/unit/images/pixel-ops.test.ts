import { describe, expect, it } from "vitest";

import type { DecodedRgbaImage } from "../../../src/images/image-codec";
import {
  applyExifOrientation,
  resizeNoUpscale,
  targetDimensions,
} from "../../../src/images/pixel-ops";

// A 2x2 image with four distinguishable opaque pixels: TL red, TR green,
// BL blue, BR yellow. Orientation and resize can be reasoned about exactly.
const quad = (): DecodedRgbaImage => ({
  width: 2,
  height: 2,
  data: new Uint8ClampedArray([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
  ]),
});

const pixel = (image: DecodedRgbaImage, x: number, y: number): number[] => {
  const i = (y * image.width + x) * 4;
  return [...image.data.slice(i, i + 4)];
};

describe("applyExifOrientation", () => {
  it("returns the same reference for the upright orientation", () => {
    const image = quad();
    expect(applyExifOrientation(image, 1)).toBe(image);
  });

  it("mirrors horizontally for orientation 2", () => {
    const out = applyExifOrientation(quad(), 2);
    expect([out.width, out.height]).toEqual([2, 2]);
    expect(pixel(out, 0, 0)).toEqual([0, 255, 0, 255]); // was TR (green)
    expect(pixel(out, 1, 0)).toEqual([255, 0, 0, 255]); // was TL (red)
  });

  it("rotates 180 degrees for orientation 3", () => {
    const out = applyExifOrientation(quad(), 3);
    expect(pixel(out, 0, 0)).toEqual([255, 255, 0, 255]); // was BR (yellow)
  });

  it("mirrors vertically for orientation 4", () => {
    const out = applyExifOrientation(quad(), 4);
    expect(pixel(out, 0, 0)).toEqual([0, 0, 255, 255]); // was BL (blue)
  });

  it("transposes for orientation 5 and swaps non-square axes", () => {
    const wide: DecodedRgbaImage = {
      width: 3,
      height: 1,
      data: new Uint8ClampedArray([1, 1, 1, 255, 2, 2, 2, 255, 3, 3, 3, 255]),
    };
    const out = applyExifOrientation(wide, 5);
    expect([out.width, out.height]).toEqual([1, 3]);
    expect(pixel(out, 0, 2)).toEqual([3, 3, 3, 255]);
  });

  it("rotates 90 clockwise for orientation 6", () => {
    const out = applyExifOrientation(quad(), 6);
    expect([out.width, out.height]).toEqual([2, 2]);
    expect(pixel(out, 0, 0)).toEqual([0, 0, 255, 255]); // BL rotates to TL
  });

  it("applies transverse orientation 7", () => {
    const out = applyExifOrientation(quad(), 7);
    expect(pixel(out, 0, 0)).toEqual([255, 255, 0, 255]); // BR to TL
  });

  it("rotates 90 counter-clockwise for orientation 8", () => {
    const out = applyExifOrientation(quad(), 8);
    expect(pixel(out, 0, 0)).toEqual([0, 255, 0, 255]); // TR rotates to TL
  });
});

describe("targetDimensions", () => {
  it("never upscales a source already within the limit", () => {
    expect(targetDimensions(100, 80, 2000)).toEqual({ width: 100, height: 80 });
  });

  it("scales the longest edge down to the limit", () => {
    expect(targetDimensions(4000, 2000, 2000)).toEqual({
      width: 2000,
      height: 1000,
    });
  });

  it("keeps at least one pixel on the short edge", () => {
    expect(targetDimensions(1000, 1, 10)).toEqual({ width: 10, height: 1 });
  });
});

describe("resizeNoUpscale", () => {
  it("returns the same reference when no downscaling is required", () => {
    const image = quad();
    expect(resizeNoUpscale(image, 2000)).toBe(image);
  });

  it("area-averages a 2x2 quad down to its mean single pixel", () => {
    const out = resizeNoUpscale(quad(), 1);
    expect([out.width, out.height]).toEqual([1, 1]);
    // Mean of red, green, blue, yellow channels.
    expect(pixel(out, 0, 0)).toEqual([128, 128, 64, 255]);
  });

  it("produces deterministic output bytes across repeated runs", () => {
    const wide: DecodedRgbaImage = {
      width: 8,
      height: 4,
      data: new Uint8ClampedArray(8 * 4 * 4).map(
        (_, index) => (index * 7) % 256,
      ),
    };
    const first = resizeNoUpscale(wide, 3);
    const second = resizeNoUpscale(wide, 3);
    expect([first.width, first.height]).toEqual([3, 2]);
    expect([...first.data]).toEqual([...second.data]);
  });
});
