// esbuild's `binary` loader emits a Uint8Array default export for `*.wasm`
// imports, letting the worker instantiate codecs from bytes with no runtime
// fetch or filesystem access.
declare module "*.wasm" {
  const bytes: Uint8Array;
  export default bytes;
}
