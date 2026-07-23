import type { DecodedRgbaImage } from "./image-codec";

/**
 * Applies an EXIF orientation (1..8) to RGBA pixels, returning upright pixels.
 * Orientations 5..8 transpose the axes, so output width and height swap. The
 * remap is a pure integer index permutation and therefore fully deterministic.
 */
export function applyExifOrientation(
  image: DecodedRgbaImage,
  orientation: number,
): DecodedRgbaImage {
  if (orientation === 1) return image;
  const { width: w, height: h, data } = image;
  const swaps = orientation >= 5;
  const outW = swaps ? h : w;
  const outH = swaps ? w : h;
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let oy = 0; oy < outH; oy += 1) {
    for (let ox = 0; ox < outW; ox += 1) {
      let sx: number;
      let sy: number;
      switch (orientation) {
        case 2:
          sx = w - 1 - ox;
          sy = oy;
          break;
        case 3:
          sx = w - 1 - ox;
          sy = h - 1 - oy;
          break;
        case 4:
          sx = ox;
          sy = h - 1 - oy;
          break;
        case 5:
          sx = oy;
          sy = ox;
          break;
        case 6:
          sx = oy;
          sy = h - 1 - ox;
          break;
        case 7:
          sx = w - 1 - oy;
          sy = h - 1 - ox;
          break;
        default: // 8
          sx = w - 1 - oy;
          sy = ox;
          break;
      }
      const from = (sy * w + sx) * 4;
      const to = (oy * outW + ox) * 4;
      out[to] = data[from]!;
      out[to + 1] = data[from + 1]!;
      out[to + 2] = data[from + 2]!;
      out[to + 3] = data[from + 3]!;
    }
  }
  return { width: outW, height: outH, data: out };
}

/** Longest-edge target that never exceeds the source (no upscaling). */
export function targetDimensions(
  width: number,
  height: number,
  maxDimension: number,
): { readonly width: number; readonly height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxDimension) return { width, height };
  const scale = maxDimension / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Downscales RGBA pixels to fit maxDimension on the longest edge using area
 * (box) averaging with fractional edge coverage. Never upscales: a source that
 * already fits is returned unchanged. Fixed-order IEEE-754 math makes the output
 * bit-identical across architectures.
 */
export function resizeNoUpscale(
  image: DecodedRgbaImage,
  maxDimension: number,
): DecodedRgbaImage {
  const { width: w, height: h, data } = image;
  const target = targetDimensions(w, h, maxDimension);
  if (target.width === w && target.height === h) return image;
  const outW = target.width;
  const outH = target.height;
  const scaleX = w / outW;
  const scaleY = h / outH;
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let oy = 0; oy < outH; oy += 1) {
    const srcTop = oy * scaleY;
    const srcBottom = (oy + 1) * scaleY;
    const y0 = Math.floor(srcTop);
    const y1 = Math.min(h, Math.ceil(srcBottom));
    for (let ox = 0; ox < outW; ox += 1) {
      const srcLeft = ox * scaleX;
      const srcRight = (ox + 1) * scaleX;
      const x0 = Math.floor(srcLeft);
      const x1 = Math.min(w, Math.ceil(srcRight));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weightSum = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        const wy = Math.min(sy + 1, srcBottom) - Math.max(sy, srcTop);
        for (let sx = x0; sx < x1; sx += 1) {
          const wx = Math.min(sx + 1, srcRight) - Math.max(sx, srcLeft);
          const weight = wx * wy;
          const index = (sy * w + sx) * 4;
          r += data[index]! * weight;
          g += data[index + 1]! * weight;
          b += data[index + 2]! * weight;
          a += data[index + 3]! * weight;
          weightSum += weight;
        }
      }
      const to = (oy * outW + ox) * 4;
      out[to] = Math.round(r / weightSum);
      out[to + 1] = Math.round(g / weightSum);
      out[to + 2] = Math.round(b / weightSum);
      out[to + 3] = Math.round(a / weightSum);
    }
  }
  return { width: outW, height: outH, data: out };
}
