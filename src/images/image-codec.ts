import type { MdxRelayIssue } from "../contracts/issues";
import type { Result } from "../contracts/result";

/** The only raster inputs MDX Relay decodes. */
export type SupportedImageMime = "image/png" | "image/jpeg" | "image/webp";

/** Row-major RGBA pixels, four bytes per pixel, length === width * height * 4. */
export interface DecodedRgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** Profile-derived transform bounds. Both come from validated portable rules. */
export interface ImageTransformParams {
  /** Longest output edge in pixels; never upscales beyond the source. */
  readonly maxDimension: number;
  /** WebP quality 1..100. */
  readonly webpQuality: number;
}

/** Deterministic WebP output plus the decoded source format and final size. */
export interface TransformedImage {
  readonly decodedMime: SupportedImageMime;
  /**
   * Dimensions of the raw decoded source, before EXIF orientation and resize.
   * This is the decode cost the caller actually paid, so it -- not the output
   * size -- is what a cumulative decoded-work budget must be measured in.
   */
  readonly decodedWidth: number;
  readonly decodedHeight: number;
  readonly width: number;
  readonly height: number;
  readonly bytes: ArrayBuffer;
}

/**
 * Portable, browser/worker-compatible image transformer.
 *
 * Implementations MUST decode PNG/JPEG/WebP, apply EXIF orientation, downscale
 * without upscaling, and encode WebP, using only browser-safe WebAssembly — no
 * native Sharp and no `.node` binaries. Byte-for-byte deterministic output for a
 * fixed source and params is part of the contract. This abstraction is frozen:
 * if a codec implementation fails a mandatory gate it is replaced behind this
 * same interface, never around it.
 */
export interface ImageCodec {
  transform(
    source: ArrayBuffer,
    params: ImageTransformParams,
  ): Promise<Result<TransformedImage, MdxRelayIssue>>;
}
