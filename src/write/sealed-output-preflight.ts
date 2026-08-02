import { MDX_RELAY_LIMITS } from "../core/limits";
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
 * Bound on a single inspected candidate. Credentials live in the userinfo,
 * query, or fragment of a URL, so a longer candidate is inspected through this
 * prefix; a decisive marker past the prefix is refused outright rather than
 * cleared on the strength of bytes this gate declined to read.
 */
const MAX_CANDIDATE_LENGTH = 2048;

const AT_SIGN = "@";

/**
 * Characters that introduce the parts of a URL a credential can hide in:
 * userinfo (`@`), query (`?`), and fragment (`#`).
 *
 * These are also what makes candidate discovery cheap. `isCredentialBearingUrl`
 * cannot return true for a value containing none of them: every one of its
 * true-returning branches needs a query, a fragment, or userinfo. A candidate
 * carrying no marker is therefore skipped without calling the canonical rule.
 */
const isRiskMarker = (character: string): boolean =>
  character === AT_SIGN || character === "?" || character === "#";

/** Characters that can never appear inside a URL in generated output. */
const DELIMITERS = new Set([...`"'\`<>()[]{}|^`]);

/**
 * URL syntax is ASCII -- anything else must arrive percent-encoded -- so a
 * non-ASCII character ends a run. That is also what makes an ASCII credential
 * embedded in the binary metadata of an image output visible as its own run.
 *
 * Backslash is the one character whose delimiter status cannot be settled here:
 * it ends a run for the runs-between-backslashes reading and belongs to the run
 * for the malformed-URL reading, so `splitOnBackslash` selects the reading and
 * both are scanned.
 *
 * Note what is deliberately absent: `=`, `,`, `;`, `.` and the rest of ordinary
 * punctuation. A run is not a URL, and a URL is not assumed to start where a
 * run starts -- `href=https://host/x?token=secret` is one run whose URL begins
 * five characters in. Candidate discovery below finds that start rather than
 * growing this set.
 */
const isDelimiter = (character: string, splitOnBackslash: boolean): boolean => {
  const code = character.charCodeAt(0);
  return (
    code <= 0x20 ||
    code >= 0x7f ||
    (splitOnBackslash && character === "\\") ||
    DELIMITERS.has(character)
  );
};

/**
 * Sticky matcher for the supported schemes, applied at a single offset.
 *
 * `lastIndex` is assigned immediately before every use, so the shared instance
 * carries no state between calls.
 */
const SUPPORTED_SCHEME_AT = /(?:https?|ssh|git):/iuy;

/** First characters of a supported scheme, upper and lower case. */
const SCHEME_INITIALS = new Set([..."hHsSgG"]);

/** True when a supported scheme starts exactly at `offset`. */
const isSupportedSchemeAt = (text: string, offset: number): boolean => {
  if (!SCHEME_INITIALS.has(text[offset]!)) return false;
  SUPPORTED_SCHEME_AT.lastIndex = offset;
  return SUPPORTED_SCHEME_AT.test(text);
};

/**
 * Every candidate in one run, judged by the canonical rule.
 *
 * A candidate starts at a supported scheme wherever that scheme appears in the
 * run -- not only where the run itself starts -- which is what catches a URL
 * embedded after `=`, `,`, `;`, or any other non-delimiter punctuation. The run
 * start is a candidate too whenever the run carries userinfo, because the
 * scheme-less SCP and userinfo forms the canonical rule also classifies have no
 * scheme to anchor on.
 *
 * Each candidate is handed to `isCredentialBearingUrl` verbatim, with no extra
 * conditions layered on top and no second grammar of this module's own: a
 * supported-scheme URL whose secret sits in a query or fragment rather than its
 * userinfo is rejected here exactly as it is when it appears in a profile. The
 * conservatism that follows is deliberate -- `git:` in the middle of a run that
 * also holds a `?` is judged as the URL the canonical rule reads it to be.
 *
 * Work is bounded: each candidate start is judged at most once, discovery costs
 * one character each, and the marker cursor only moves forward across the run.
 */
const scanRun = (
  text: string,
  runStart: number,
  runEnd: number,
  hasUserInfo: boolean,
  lastMarker: number,
): boolean => {
  // No marker anywhere in the run means no candidate in it can be credential
  // bearing, so the whole run is settled without a single canonical call.
  if (lastMarker < 0) return false;

  // First marker at or after a given offset. Candidate starts only ever
  // increase, so this scan never revisits a character.
  let markerCursor = runStart - 1;
  const firstMarkerFrom = (offset: number): number => {
    if (markerCursor >= offset) return markerCursor;
    let index = Math.max(offset, markerCursor + 1);
    while (index < runEnd && !isRiskMarker(text[index]!)) index += 1;
    markerCursor = index;
    return markerCursor;
  };

  for (let start = runStart; start < runEnd; start += 1) {
    const isCandidate =
      isSupportedSchemeAt(text, start) || (start === runStart && hasUserInfo);
    if (!isCandidate) continue;

    // Userinfo, a query, or a fragment beyond the bounded prefix would decide
    // the canonical verdict on characters this gate refuses to read, so an
    // overlong candidate carrying one is refused rather than cleared.
    if (lastMarker >= start + MAX_CANDIDATE_LENGTH) return true;

    // No marker left in the run: neither this candidate nor any later one --
    // they all start further right -- can be credential bearing.
    if (firstMarkerFrom(start) >= runEnd) return false;

    const end = Math.min(runEnd, start + MAX_CANDIDATE_LENGTH);
    if (isCredentialBearingUrl(text.slice(start, end))) return true;
  }
  return false;
};

/**
 * One linear pass over the decoded output under a single backslash reading.
 *
 * Runs are delimited exactly as before; what changed is that a run is a search
 * space for URL starts rather than a URL itself.
 */
const scanText = (text: string, splitOnBackslash: boolean): boolean => {
  let index = 0;
  while (index < text.length) {
    if (isDelimiter(text[index]!, splitOnBackslash)) {
      index += 1;
      continue;
    }
    const runStart = index;
    let runEnd = index;
    let hasUserInfo = false;
    let lastMarker = -1;
    while (
      runEnd < text.length &&
      !isDelimiter(text[runEnd]!, splitOnBackslash)
    ) {
      const character = text[runEnd]!;
      if (isRiskMarker(character)) {
        lastMarker = runEnd;
        if (character === AT_SIGN) hasUserInfo = true;
      }
      runEnd += 1;
    }
    if (scanRun(text, runStart, runEnd, hasUserInfo, lastMarker)) return true;
    index = runEnd;
  }
  return false;
};

const decoder = new TextDecoder("utf-8");

/**
 * True when any URL-shaped candidate in these sealed bytes carries credentials
 * under the repository's canonical `isCredentialBearingUrl` rule.
 *
 * Every sealed output is scanned, text and binary alike: a credential embedded
 * in image metadata leaks exactly as far as one in Markdown. Invalid UTF-8 in
 * binary output decodes to replacement characters, which are non-ASCII and so
 * delimit runs -- an ASCII credential inside binary metadata stays visible as
 * its own run.
 *
 * Decoding the whole output at once is what lets a URL be found at any offset.
 * That allocation is bounded by `MDX_RELAY_LIMITS.sealedOutputBytes`, the hard
 * per-output ceiling the planner, plan store, and worker already enforce; a
 * larger input cannot be an approved sealed output at all and is refused here
 * rather than decoded.
 */
export const containsCredentialBearingOutput = (bytes: Uint8Array): boolean => {
  if (bytes.length > MDX_RELAY_LIMITS.sealedOutputBytes) return true;
  const text = decoder.decode(bytes);
  // Two passes, one per backslash reading. Splitting alone would let
  // `https:\\writer:token@host\repo.git` -- which the canonical rule rejects as
  // a malformed supported-scheme URL -- fall apart into safe-looking pieces;
  // never splitting alone would let a backslash glue a credential URL to
  // preceding text and hide it inside a run the canonical rule then discards
  // for containing a backslash. Neither reading is safe without the other.
  return scanText(text, true) || scanText(text, false);
};
