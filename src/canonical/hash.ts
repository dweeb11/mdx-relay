/**
 * Node-backed sha256 helpers for canonical bytes. This is the only module
 * under `src/` that may import `node:crypto`. It may import `./index`; index
 * must never import this file — that one-directional edge keeps the worker
 * bundle Node-free. See ADR 0002 §2.
 */

import { createHash } from "node:crypto";

import type { Sha256Digest } from "../contracts/export-plan";
import { canonicalizeJcs } from "./index";

export const sha256OfBytes = (bytes: Uint8Array): Sha256Digest =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}` as Sha256Digest;

export const sha256OfUtf8 = (value: string): Sha256Digest =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}` as Sha256Digest;

/** Digest of the RFC 8785 canonical form of `value`. */
export const sha256OfCanonical = (value: unknown): Sha256Digest =>
  sha256OfUtf8(canonicalizeJcs(value));
