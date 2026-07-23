import {
  init as pngDecodeInit,
  decode as pngDecode,
} from "@jsquash/png/decode";
import mozjpegDecFactory from "@jsquash/jpeg/codec/dec/mozjpeg_dec";
import webpDecFactory from "@jsquash/webp/codec/dec/webp_dec";
import webpEncFactory from "@jsquash/webp/codec/enc/webp_enc";
import { defaultOptions as webpDefaultOptions } from "@jsquash/webp/meta";
import { initEmscriptenModule } from "@jsquash/webp/utils";

import {
  createIssue,
  ISSUE_CODES,
  type MdxRelayIssue,
} from "../contracts/issues";
import { err, ok, type Result } from "../contracts/result";
import { MDX_RELAY_LIMITS } from "../core/limits";
import type {
  DecodedRgbaImage,
  ImageCodec,
  ImageTransformParams,
  SupportedImageMime,
  TransformedImage,
} from "./image-codec";
import { readExifOrientation, sniffImageMime } from "./image-metadata";
import { applyExifOrientation, resizeNoUpscale } from "./pixel-ops";

/** Precompiled WebAssembly modules for each codec, supplied by the caller. */
export interface PortableCodecWasm {
  readonly pngDecode: WebAssembly.Module;
  readonly jpegDecode: WebAssembly.Module;
  readonly webpDecode: WebAssembly.Module;
  readonly webpEncode: WebAssembly.Module;
}

interface CodecRuntime {
  readonly jpeg: {
    decode(data: BufferSource, preserveOrientation: boolean): ImageData | null;
  };
  readonly webp: { decode(data: BufferSource): ImageData | null };
  readonly encode: (
    data: BufferSource,
    width: number,
    height: number,
    options: typeof webpDefaultOptions,
  ) => Uint8Array | null;
}

const asDecoded = (image: ImageData): DecodedRgbaImage => ({
  width: image.width,
  height: image.height,
  data: image.data,
});

const decodeError = (): Result<never, MdxRelayIssue> =>
  err(createIssue(ISSUE_CODES.imageDecodeFailed));

/**
 * Builds the frozen ImageCodec from precompiled WASM. WebP encoding uses the
 * explicit non-SIMD build so output never depends on runtime SIMD detection;
 * decode, EXIF orientation, and no-upscale resize are all deterministic.
 */
export function createPortableWebpCodec(wasm: PortableCodecWasm): ImageCodec {
  let runtime: Promise<CodecRuntime> | undefined;
  const ready = (): Promise<CodecRuntime> => {
    if (!runtime) {
      runtime = (async () => {
        await pngDecodeInit(wasm.pngDecode);
        const [jpeg, webp, encoder] = await Promise.all([
          initEmscriptenModule(mozjpegDecFactory, wasm.jpegDecode),
          initEmscriptenModule(webpDecFactory, wasm.webpDecode),
          initEmscriptenModule(webpEncFactory, wasm.webpEncode),
        ]);
        return {
          jpeg,
          webp,
          encode: encoder.encode.bind(encoder),
        };
      })();
    }
    return runtime;
  };

  const decode = async (
    codec: CodecRuntime,
    mime: SupportedImageMime,
    source: ArrayBuffer,
  ): Promise<DecodedRgbaImage | undefined> => {
    if (mime === "image/png") return asDecoded(await pngDecode(source));
    if (mime === "image/jpeg") {
      const decoded = codec.jpeg.decode(source, false);
      return decoded ? asDecoded(decoded) : undefined;
    }
    const decoded = codec.webp.decode(source);
    return decoded ? asDecoded(decoded) : undefined;
  };

  return {
    async transform(
      source: ArrayBuffer,
      params: ImageTransformParams,
    ): Promise<Result<TransformedImage, MdxRelayIssue>> {
      const bytes = new Uint8Array(source);
      const mime = sniffImageMime(bytes);
      if (!mime) return err(createIssue(ISSUE_CODES.unsupportedImage));

      const codec = await ready();
      let decoded: DecodedRgbaImage | undefined;
      try {
        decoded = await decode(codec, mime, source);
      } catch {
        return decodeError();
      }
      if (
        !decoded ||
        decoded.width < 1 ||
        decoded.height < 1 ||
        decoded.data.length !== decoded.width * decoded.height * 4
      )
        return decodeError();
      if (decoded.width * decoded.height > MDX_RELAY_LIMITS.decodedImagePixels)
        return err(createIssue(ISSUE_CODES.decodedImageTooLarge));

      const oriented = applyExifOrientation(
        decoded,
        readExifOrientation(mime, bytes),
      );
      const resized = resizeNoUpscale(oriented, params.maxDimension);

      let encoded: Uint8Array | null;
      try {
        encoded = codec.encode(
          new Uint8Array(
            resized.data.buffer,
            resized.data.byteOffset,
            resized.data.byteLength,
          ),
          resized.width,
          resized.height,
          { ...webpDefaultOptions, quality: params.webpQuality },
        );
      } catch {
        return err(createIssue(ISSUE_CODES.imageEncodeFailed));
      }
      if (!encoded || encoded.byteLength === 0)
        return err(createIssue(ISSUE_CODES.imageEncodeFailed));

      const output = new Uint8Array(encoded);
      return ok(
        Object.freeze({
          decodedMime: mime,
          decodedWidth: decoded.width,
          decodedHeight: decoded.height,
          width: resized.width,
          height: resized.height,
          bytes: output.buffer,
        }),
      );
    },
  };
}
