import jpegWasm from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm";
// The PNG package ships wasm-bindgen typings for this file; esbuild's binary
// loader yields the raw bytes, so the default import is the WASM byte array.
// @ts-expect-error binary WASM import default is Uint8Array, not the JS bindings
import pngWasm from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm";
import webpDecWasm from "@jsquash/webp/codec/dec/webp_dec.wasm";
import webpEncWasm from "@jsquash/webp/codec/enc/webp_enc.wasm";

import { readImageHeader } from "../images/image-metadata";
import { createPortableWebpCodec } from "../images/portable-webp-codec";
import { transformMarkdown } from "../markdown/transform";
import type {
  WorkerRequest,
  WorkerWireEvent,
} from "../contracts/worker-protocol";
import { processPlan } from "./process-plan";
import { sha256Digest } from "./webcrypto-hash";

interface DedicatedWorkerScope {
  postMessage(message: WorkerWireEvent, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
}

const scope = self as unknown as DedicatedWorkerScope;

// Compiled once per worker; jSquash instantiates from these precompiled modules
// so no codec ever fetches or locates a WASM file at runtime.
const codec = createPortableWebpCodec({
  pngDecode: new WebAssembly.Module(pngWasm),
  jpegDecode: new WebAssembly.Module(jpegWasm),
  webpDecode: new WebAssembly.Module(webpDecWasm),
  webpEncode: new WebAssembly.Module(webpEncWasm),
});

const post = (
  event: WorkerWireEvent,
  transfer?: readonly Transferable[],
): void => {
  scope.postMessage(event, transfer ? [...transfer] : undefined);
};

scope.addEventListener("message", (event: MessageEvent) => {
  const request = event.data as WorkerRequest;
  // Cancellation is enforced by the parent terminating this worker; a
  // cancel-generation message here needs no in-band handling.
  if (request.type !== "process-plan") return;
  void processPlan(request, {
    codec,
    readImageHeader,
    hash: sha256Digest,
    transformMarkdown,
    post,
    now: () => Date.now(),
  });
});
