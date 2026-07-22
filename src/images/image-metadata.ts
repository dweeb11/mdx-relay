import type { SupportedImageMime } from "./image-codec";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  bytes.length >= signature.length &&
  signature.every((byte, index) => bytes[index] === byte);

/** Detects the container format from magic bytes; unsupported inputs are undefined. */
export function sniffImageMime(
  bytes: Uint8Array,
): SupportedImageMime | undefined {
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "image/jpeg";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  )
    return "image/webp";
  return undefined;
}

/** EXIF orientation values are 1..8; anything else is treated as upright (1). */
const isOrientation = (value: number): boolean =>
  Number.isInteger(value) && value >= 1 && value <= 8;

/**
 * Reads the EXIF Orientation tag (0x0112) from a raw TIFF/EXIF block. Any
 * truncation, unknown byte order, or missing tag falls back to 1 (upright).
 */
const readTiffOrientation = (view: DataView, tiffStart: number): number => {
  if (tiffStart + 8 > view.byteLength) return 1;
  const byteOrder = view.getUint16(tiffStart, false);
  let little: boolean;
  if (byteOrder === 0x4949) little = true;
  else if (byteOrder === 0x4d4d) little = false;
  else return 1;
  if (view.getUint16(tiffStart + 2, little) !== 0x002a) return 1;
  const ifdOffset = view.getUint32(tiffStart + 4, little);
  const ifdStart = tiffStart + ifdOffset;
  if (ifdStart + 2 > view.byteLength) return 1;
  const entryCount = view.getUint16(ifdStart, little);
  for (let index = 0; index < entryCount; index += 1) {
    const entry = ifdStart + 2 + index * 12;
    if (entry + 12 > view.byteLength) return 1;
    if (view.getUint16(entry, little) === 0x0112) {
      const value = view.getUint16(entry + 8, little);
      return isOrientation(value) ? value : 1;
    }
  }
  return 1;
};

const readJpegOrientation = (bytes: Uint8Array, view: DataView): number => {
  // Walk marker segments after the SOI looking for the APP1/Exif block.
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return 1;
    const marker = bytes[offset + 1]!;
    // Standalone markers (SOI/EOI/RSTn) carry no length; stop at scan data.
    if (marker === 0xd9 || marker === 0xda) return 1;
    const length = view.getUint16(offset + 2, false);
    if (length < 2 || offset + 2 + length > bytes.length) return 1;
    const payload = offset + 4;
    if (
      marker === 0xe1 &&
      payload + 6 <= bytes.length &&
      bytes[payload] === 0x45 && // E
      bytes[payload + 1] === 0x78 && // x
      bytes[payload + 2] === 0x69 && // i
      bytes[payload + 3] === 0x66 && // f
      bytes[payload + 4] === 0x00 &&
      bytes[payload + 5] === 0x00
    ) {
      return readTiffOrientation(view, payload + 6);
    }
    offset += 2 + length;
  }
  return 1;
};

const readWebpOrientation = (bytes: Uint8Array, view: DataView): number => {
  // RIFF chunks after the "WEBP" fourcc: 4-byte id, 4-byte LE size, payload.
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    if (payload + size > bytes.length) return 1;
    if (
      bytes[offset] === 0x45 && // E
      bytes[offset + 1] === 0x58 && // X
      bytes[offset + 2] === 0x49 && // I
      bytes[offset + 3] === 0x46 // F
    ) {
      // Some encoders prefix the standard "Exif\0\0" header; skip it if present.
      const hasHeader =
        size >= 6 &&
        bytes[payload] === 0x45 &&
        bytes[payload + 1] === 0x78 &&
        bytes[payload + 2] === 0x69 &&
        bytes[payload + 3] === 0x66 &&
        bytes[payload + 4] === 0x00 &&
        bytes[payload + 5] === 0x00;
      return readTiffOrientation(view, hasHeader ? payload + 6 : payload);
    }
    // Chunks are padded to an even byte boundary.
    offset = payload + size + (size % 2);
  }
  return 1;
};

/**
 * Returns the EXIF orientation (1..8) for the given source. PNG is always
 * treated as upright; JPEG and WebP EXIF blocks are parsed fail-closed to 1.
 */
export function readExifOrientation(
  mime: SupportedImageMime,
  bytes: Uint8Array,
): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === "image/jpeg") return readJpegOrientation(bytes, view);
  if (mime === "image/webp") return readWebpOrientation(bytes, view);
  return 1;
}
