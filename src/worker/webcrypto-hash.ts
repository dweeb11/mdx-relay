import type { Sha256Digest } from "../contracts/export-plan";

const HEX = Array.from({ length: 256 }, (_, byte) =>
  byte.toString(16).padStart(2, "0"),
);

/**
 * Hashes bytes to the canonical `sha256:<hex>` digest using Web Crypto, which is
 * available in both the worker (self.crypto) and the host (globalThis.crypto).
 * The parent decoder and the worker share this format so hash verification lines
 * up exactly.
 */
export async function sha256Digest(bytes: ArrayBuffer): Promise<Sha256Digest> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) hex += HEX[byte];
  return `sha256:${hex}` as Sha256Digest;
}
