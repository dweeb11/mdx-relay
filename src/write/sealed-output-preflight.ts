import { isCredentialBearingUrl } from "../profiles/portable-profile";

/**
 * Output-content credential gate.
 *
 * ADR 0003 requires credentials to be rejected from written output even when
 * they originate in approved source content, so sealed bytes are inspected once
 * before any filesystem mutation rather than trusted because their digest is
 * intact.
 */

/**
 * Bound on a single inspected run. Credentials live in the userinfo, query, or
 * fragment of a URL, so a longer run is inspected through this prefix instead
 * of being decoded whole; the scan stays linear in output size and allocates
 * nothing proportional to it.
 */
const MAX_CANDIDATE_BYTES = 2048;

const AT_SIGN = 0x40;
const COLON = 0x3a;

/**
 * Longest supported scheme label (`https`) plus its colon. A run's scheme is
 * decided from at most this many bytes, so scheme detection never decodes more
 * than a few bytes per run.
 */
const MAX_SCHEME_BYTES = 6;

const supportedSchemePrefix = /^(?:https?|ssh|git):/iu;

/** Bytes that can never appear inside a URL run in generated output. */
const DELIMITER_BYTES = new Set(
  [..."\"'`<>()[]{}|^\\"].map((character) => character.charCodeAt(0)),
);

/**
 * URL syntax is ASCII -- anything else must arrive percent-encoded -- so a
 * non-ASCII byte ends a run. That is also what makes an ASCII credential
 * embedded in the binary metadata of an image output visible as its own run.
 */
const isDelimiter = (byte: number): boolean =>
  byte <= 0x20 || byte >= 0x7f || DELIMITER_BYTES.has(byte);

const decoder = new TextDecoder("utf-8");

/**
 * True when any URL-shaped run in these sealed bytes carries credentials under
 * the repository's canonical `isCredentialBearingUrl` rule.
 *
 * A run is URL-shaped when it opens with a supported scheme (`http`, `https`,
 * `ssh`, `git`) or carries userinfo (`@`); those are exactly the shapes the
 * canonical rule can classify. Every such run is handed to that rule verbatim,
 * with no extra conditions layered on top, so a supported-scheme URL whose
 * secret sits in a query string or fragment rather than its userinfo -- for
 * example `https://example.invalid/site.git?access_token=secret` -- is rejected
 * here exactly as it is when it appears in a profile.
 *
 * Every sealed output is scanned, text and binary alike: a credential embedded
 * in image metadata leaks exactly as far as one in Markdown.
 */
export const containsCredentialBearingOutput = (bytes: Uint8Array): boolean => {
  let start = -1;
  let isCandidate = false;
  let schemeDecided = false;
  for (let index = 0; index <= bytes.length; index += 1) {
    // The trailing virtual space closes a run that reaches the final byte.
    const byte = index < bytes.length ? bytes[index]! : 0x20;
    if (!isDelimiter(byte)) {
      if (start < 0) {
        start = index;
        isCandidate = false;
        schemeDecided = false;
      }
      if (byte === AT_SIGN) isCandidate = true;
      // The scheme, if any, ends at the run's first colon; decoding those few
      // bytes keeps detection bounded regardless of how long the run runs on.
      if (byte === COLON && !schemeDecided) {
        schemeDecided = true;
        if (index - start < MAX_SCHEME_BYTES)
          isCandidate ||= supportedSchemePrefix.test(
            decoder.decode(bytes.subarray(start, index + 1)),
          );
      }
      continue;
    }
    if (start >= 0 && isCandidate) {
      const end = Math.min(index, start + MAX_CANDIDATE_BYTES);
      if (isCredentialBearingUrl(decoder.decode(bytes.subarray(start, end))))
        return true;
    }
    start = -1;
  }
  return false;
};
