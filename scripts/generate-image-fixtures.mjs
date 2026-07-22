// Regenerates the sanitized synthetic image fixtures under tests/fixtures/images.
// The vectors are procedural gradients — no private or personal content — so the
// repository never carries baseline image bytes. Run: node scripts/generate-image-fixtures.mjs
/* global WebAssembly */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const jsquash = new URL("../node_modules/@jsquash/", import.meta.url);
const outDir = fileURLToPath(
  new URL("../tests/fixtures/images/", import.meta.url),
);

const compile = async (relativePath) =>
  new WebAssembly.Module(await readFile(new URL(relativePath, jsquash)));

const pngEncode = await import(new URL("png/encode.js", jsquash).href);
const jpegEncode = await import(new URL("jpeg/encode.js", jsquash).href);

await pngEncode.init(await compile("png/codec/pkg/squoosh_png_bg.wasm"));
await jpegEncode.init(await compile("jpeg/codec/enc/mozjpeg_enc.wasm"));
// Force the non-SIMD encoder for reproducibility regardless of host SIMD.
const { initEmscriptenModule } = await import(
  new URL("webp/utils.js", jsquash).href
);
const webpEncFactory = (
  await import(new URL("webp/codec/enc/webp_enc.js", jsquash).href)
).default;
const { defaultOptions } = await import(new URL("webp/meta.js", jsquash).href);
const webpEncModule = await initEmscriptenModule(
  webpEncFactory,
  await compile("webp/codec/enc/webp_enc.wasm"),
);

const gradient = (width, height) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = (x * 255) / Math.max(1, width - 1);
      data[i + 1] = (y * 255) / Math.max(1, height - 1);
      data[i + 2] = ((x + y) * 255) / Math.max(1, width + height - 2);
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
};

const withExifOrientation = (jpegBytes, orientation) => {
  const tiff = [
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0x00,
    0x00,
    0x00,
    0x08,
    0x00,
    0x01,
    0x01,
    0x12,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x01,
    (orientation >> 8) & 0xff,
    orientation & 0xff,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ];
  const exif = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const length = exif.length + 2;
  const app1 = [0xff, 0xe1, (length >> 8) & 0xff, length & 0xff, ...exif];
  const out = new Uint8Array(2 + app1.length + (jpegBytes.length - 2));
  out.set(jpegBytes.subarray(0, 2), 0);
  out.set(app1, 2);
  out.set(jpegBytes.subarray(2), 2 + app1.length);
  return out;
};

await mkdir(outDir, { recursive: true });

const base = gradient(16, 12);
const wide = gradient(48, 12);

const png = new Uint8Array(await pngEncode.default(base));
const jpeg = new Uint8Array(await jpegEncode.default(base, { quality: 90 }));
const webp = new Uint8Array(
  webpEncModule.encode(
    new Uint8Array(base.data.buffer),
    base.width,
    base.height,
    {
      ...defaultOptions,
      quality: 85,
    },
  ),
);
// A 6x2 source with orientation 6 rotates to an upright 2x6 image.
const orientedBase = gradient(6, 2);
const orientedJpeg = withExifOrientation(
  new Uint8Array(await jpegEncode.default(orientedBase, { quality: 90 })),
  6,
);
const widePng = new Uint8Array(await pngEncode.default(wide));

await writeFile(`${outDir}gradient.png`, png);
await writeFile(`${outDir}gradient.jpg`, jpeg);
await writeFile(`${outDir}gradient.webp`, webp);
await writeFile(`${outDir}oriented-6.jpg`, orientedJpeg);
await writeFile(`${outDir}wide.png`, widePng);

process.stdout.write(
  `fixtures written: gradient.png(${png.length}) gradient.jpg(${jpeg.length}) ` +
    `gradient.webp(${webp.length}) oriented-6.jpg(${orientedJpeg.length}) wide.png(${widePng.length})\n`,
);
