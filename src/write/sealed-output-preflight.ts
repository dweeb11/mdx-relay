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
const QUESTION_MARK = 0x3f;
const NUMBER_SIGN = 0x23;
const BACKSLASH = 0x5c;

/**
 * Bytes that introduce the parts of a URL a credential can hide in: userinfo
 * (`@`), query (`?`), and fragment (`#`). Their position decides whether the
 * bounded prefix is enough to classify a run.
 */
const isRiskMarker = (byte: number): boolean =>
  byte === AT_SIGN || byte === QUESTION_MARK || byte === NUMBER_SIGN;

/**
 * Longest supported scheme label (`https`) plus its colon. A run's scheme is
 * decided from at most this many bytes, so scheme detection never decodes more
 * than a few bytes per run.
 */
const MAX_SCHEME_BYTES = 6;

const supportedSchemePrefix = /^(?:https?|ssh|git):/iu;

/** Bytes that can never appear inside a URL run in generated output. */
const DELIMITER_BYTES = new Set(
  [..."\"'`<>()[]{}|^"].map((character) => character.charCodeAt(0)),
);

/**
 * URL syntax is ASCII -- anything else must arrive percent-encoded -- so a
 * non-ASCII byte ends a run. That is also what makes an ASCII credential
 * embedded in the binary metadata of an image output visible as its own run.
 *
 * Backslash is the one byte whose delimiter status cannot be settled here: it
 * ends a run for the runs-between-backslashes reading and belongs to the run
 * for the malformed-URL reading, so `splitOnBackslash` selects the reading and
 * both are scanned.
 */
const isDelimiter = (byte: number, splitOnBackslash: boolean): boolean =>
  byte <= 0x20 ||
  byte >= 0x7f ||
  (splitOnBackslash && byte === BACKSLASH) ||
  DELIMITER_BYTES.has(byte);

const decoder = new TextDecoder("utf-8");

/**
 * One linear pass over the sealed bytes under a single backslash reading.
 *
 * A run is URL-shaped when it opens with a supported scheme (`http`, `https`,
 * `ssh`, `git`) or carries userinfo (`@`); those are exactly the shapes the
 * canonical rule can classify. Every such run is handed to that rule verbatim,
 * with no extra conditions layered on top, so a supported-scheme URL whose
 * secret sits in a query string or fragment rather than its userinfo -- for
 * example `https://example.invalid/site.git?access_token=secret` -- is rejected
 * here exactly as it is when it appears in a profile.
 */
const scanRuns = (bytes: Uint8Array, splitOnBackslash: boolean): boolean => {
  let start = -1;
  let isCandidate = false;
  let schemeDecided = false;
  let riskMarkerBeyondPrefix = false;
  for (let index = 0; index <= bytes.length; index += 1) {
    // The trailing virtual space closes a run that reaches the final byte.
    const byte = index < bytes.length ? bytes[index]! : 0x20;
    if (!isDelimiter(byte, splitOnBackslash)) {
      if (start < 0) {
        start = index;
        isCandidate = false;
        schemeDecided = false;
        riskMarkerBeyondPrefix = false;
      }
      if (byte === AT_SIGN) isCandidate = true;
      // A marker past the bounded prefix is a part of the URL the canonical
      // rule would read but this scan cannot show it, so it is remembered
      // rather than dropped.
      if (isRiskMarker(byte) && index - start >= MAX_CANDIDATE_BYTES)
        riskMarkerBeyondPrefix = true;
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
      // Userinfo, a query, or a fragment beyond the prefix would decide the
      // canonical verdict on bytes this scan refuses to decode, so an overlong
      // URL-shaped run carrying one is rejected rather than cleared on the
      // strength of a prefix that cannot see it.
      if (riskMarkerBeyondPrefix) return true;
      const end = Math.min(index, start + MAX_CANDIDATE_BYTES);
      if (isCredentialBearingUrl(decoder.decode(bytes.subarray(start, end))))
        return true;
    }
    start = -1;
  }
  return false;
};

/**
 * True when any URL-shaped run in these sealed bytes carries credentials under
 * the repository's canonical `isCredentialBearingUrl` rule.
 *
 * Every sealed output is scanned, text and binary alike: a credential embedded
 * in image metadata leaks exactly as far as one in Markdown.
 */
export const containsCredentialBearingOutput = (bytes: Uint8Array): boolean =>
  // Two linear passes, one per backslash reading. Splitting alone would let
  // `https:\\writer:token@host\repo.git` -- which the canonical rule rejects as
  // a malformed supported-scheme URL -- fall apart into safe-looking pieces;
  // never splitting alone would let a backslash glue a credential URL to
  // preceding text and hide it inside a run the canonical rule then discards
  // for containing a backslash. Neither reading is safe without the other.
  scanRuns(bytes, true) || scanRuns(bytes, false);
