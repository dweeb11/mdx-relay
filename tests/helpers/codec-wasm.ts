import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { PortableCodecWasm } from "../../src/images/portable-webp-codec";

const jsquashRoot = new URL("../../node_modules/@jsquash/", import.meta.url);

const compile = async (relativePath: string): Promise<WebAssembly.Module> => {
  const bytes = await readFile(
    fileURLToPath(new URL(relativePath, jsquashRoot)),
  );
  return new WebAssembly.Module(bytes);
};

/**
 * Compiles the exact pinned codec WASM from node_modules for unit tests. These
 * are the same bytes esbuild inlines into the production worker bundle, so the
 * codec tests exercise real WebAssembly, never mocks.
 */
export async function loadCodecWasm(): Promise<PortableCodecWasm> {
  const [pngDecode, jpegDecode, webpDecode, webpEncode] = await Promise.all([
    compile("png/codec/pkg/squoosh_png_bg.wasm"),
    compile("jpeg/codec/dec/mozjpeg_dec.wasm"),
    compile("webp/codec/dec/webp_dec.wasm"),
    compile("webp/codec/enc/webp_enc.wasm"),
  ]);
  return { pngDecode, jpegDecode, webpDecode, webpEncode };
}

export const imageFixture = async (name: string): Promise<ArrayBuffer> => {
  const bytes = await readFile(
    fileURLToPath(new URL(`../fixtures/images/${name}`, import.meta.url)),
  );
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
};
