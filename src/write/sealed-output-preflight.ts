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

/**
 * Boundaries a scheme-less credential form cannot cross before its `@`.
 *
 * Every scheme-less form the canonical rule accepts reads `user:secret@host`,
 * `user:secret@host:path`, or `[user@]host:path?query`, and each spells the text
 * ahead of its decisive `@` with character classes that exclude `/` and `@`. So
 * a scheme-less candidate embedded in a longer run can only begin immediately
 * after one of those two characters -- which is what makes discovery of the
 * embedded starts cheap rather than a scan from every offset.
 */
const isAuthorityBoundary = (character: string): boolean =>
  character === "/" || character === AT_SIGN;

/** Characters that can never appear inside a URL in generated output. */
const DELIMITERS = new Set([...`"'\`<>(){}|^`]);

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

/** True when a supported scheme starts exactly at `offset`. */
const isSupportedSchemeAt = (text: string, offset: number): boolean => {
  SUPPORTED_SCHEME_AT.lastIndex = offset;
  return SUPPORTED_SCHEME_AT.test(text);
};

/** Supported-scheme candidates cannot cross Unicode whitespace. */
const isSupportedSchemeSegmentBoundary = (character: string): boolean =>
  /\s/u.test(character);

const MAX_SCHEMES_PER_SEGMENT = 2048;

type SupportedSchemeWrapper =
  | { readonly kind: "parenthesis" }
  | { readonly kind: "character"; readonly closing: ">" | '"' | "'" }
  | { readonly kind: "backticks"; readonly width: number };

const isBackslashEscaped = (
  text: string,
  index: number,
  candidateStart: number,
): boolean => {
  let backslashes = 0;
  for (
    let cursor = index - 1;
    cursor >= candidateStart && text[cursor] === "\\";
    cursor -= 1
  )
    backslashes += 1;
  return backslashes % 2 === 1;
};

/** Sticky recognition of a real named HTML/MDX tag after `<`. */
const NAMED_TAG_AT = /\/?[A-Za-z][A-Za-z0-9:._-]*(?=\s|\/?>)/uy;

const isNamedTagAt = (text: string, offset: number): boolean => {
  NAMED_TAG_AT.lastIndex = offset;
  return NAMED_TAG_AT.test(text);
};

/**
 * Finds one candidate's end within the locked inspection prefix. Punctuation is
 * ordinary URL content unless the output syntax explicitly opened a wrapper
 * immediately before the scheme. This keeps Unicode and WHATWG-normalized URL
 * characters intact without attributing markers after a Markdown link to the
 * link URL.
 */
const supportedSchemeCandidateEnd = (
  text: string,
  start: number,
  segmentEnd: number,
  wrapper: SupportedSchemeWrapper | undefined,
): { readonly end: number; readonly wrapperClosed: boolean } => {
  const limit = Math.min(segmentEnd, start + MAX_CANDIDATE_LENGTH);
  if (wrapper === undefined) return { end: limit, wrapperClosed: false };

  let parenthesisDepth = 0;
  for (let index = start; index < limit; index += 1) {
    const character = text[index]!;
    if (wrapper.kind === "parenthesis") {
      if (character !== "(" && character !== ")") continue;
      if (isBackslashEscaped(text, index, start)) continue;
      if (character === "(") parenthesisDepth += 1;
      else if (character === ")") {
        if (parenthesisDepth === 0) return { end: index, wrapperClosed: true };
        parenthesisDepth -= 1;
      }
    } else if (
      wrapper.kind === "character" &&
      character === wrapper.closing &&
      !isBackslashEscaped(text, index, start)
    ) {
      return { end: index, wrapperClosed: true };
    } else if (wrapper.kind === "backticks" && character === "`") {
      let runEnd = index + 1;
      while (runEnd < limit && text[runEnd] === "`") runEnd += 1;
      if (runEnd - index === wrapper.width)
        return { end: index, wrapperClosed: true };
      index = runEnd - 1;
    }
  }
  return { end: limit, wrapperClosed: false };
};

/**
 * Scans supported-scheme candidates independently of scheme-less run parsing.
 * Segments are traversed once and retain every URL character through Unicode;
 * candidate inspection is bounded, and a pathological segment with more scheme
 * anchors than the fixed cap fails closed when it also carries a risk marker.
 */
const scanSupportedSchemes = (text: string): boolean => {
  let index = 0;
  let openBacktickWidth = 0;
  let insideTag = false;
  let tagQuote: '"' | "'" | undefined;
  let expectingAttributeValue = false;
  let insideUnquotedAttributeValue = false;

  while (index < text.length) {
    const segmentStart = index;
    let lastMarker = -1;
    const starts: {
      readonly offset: number;
      readonly wrapper: SupportedSchemeWrapper | undefined;
    }[] = [];
    while (
      index < text.length &&
      !isSupportedSchemeSegmentBoundary(text[index]!)
    ) {
      const character = text[index]!;

      if (!insideTag && character === "`") {
        let runEnd = index + 1;
        while (runEnd < text.length && text[runEnd] === "`") runEnd += 1;
        const width = runEnd - index;
        if (
          openBacktickWidth === 0 &&
          !isBackslashEscaped(text, index, segmentStart)
        )
          openBacktickWidth = width;
        else if (width === openBacktickWidth) openBacktickWidth = 0;
        index = runEnd;
        continue;
      }

      if (
        !insideTag &&
        openBacktickWidth === 0 &&
        character === "<" &&
        !isBackslashEscaped(text, index, 0) &&
        isNamedTagAt(text, index + 1)
      ) {
        insideTag = true;
        tagQuote = undefined;
        expectingAttributeValue = false;
        insideUnquotedAttributeValue = false;
      } else if (insideTag) {
        if (tagQuote !== undefined) {
          if (character === tagQuote) tagQuote = undefined;
        } else if (insideUnquotedAttributeValue) {
          if (character === ">") {
            insideTag = false;
            insideUnquotedAttributeValue = false;
          }
        } else if (character === ">") {
          insideTag = false;
          expectingAttributeValue = false;
        } else if (
          expectingAttributeValue &&
          (character === '"' || character === "'")
        ) {
          tagQuote = character;
          expectingAttributeValue = false;
        } else if (character === "=") {
          expectingAttributeValue = true;
        } else if (expectingAttributeValue) {
          insideUnquotedAttributeValue = true;
          expectingAttributeValue = false;
        }
      }

      if (isRiskMarker(character)) lastMarker = index;
      if (
        starts.length <= MAX_SCHEMES_PER_SEGMENT &&
        isSupportedSchemeAt(text, index)
      ) {
        let wrapper: SupportedSchemeWrapper | undefined;
        if (openBacktickWidth > 0)
          wrapper = { kind: "backticks", width: openBacktickWidth };
        else {
          if (tagQuote !== undefined)
            wrapper = { kind: "character", closing: tagQuote };
          else if (insideUnquotedAttributeValue)
            wrapper = { kind: "character", closing: ">" };
          else if (
            text[index - 1] === "(" &&
            !isBackslashEscaped(text, index - 1, segmentStart)
          )
            wrapper = { kind: "parenthesis" };
          else if (
            text[index - 1] === "<" &&
            !isBackslashEscaped(text, index - 1, segmentStart)
          )
            wrapper = { kind: "character", closing: ">" };
        }
        starts.push({
          offset: index,
          wrapper,
        });
      }
      index += 1;
    }

    if (starts.length > MAX_SCHEMES_PER_SEGMENT && lastMarker >= 0) return true;
    for (const { offset: start, wrapper } of starts) {
      if (lastMarker < start) continue;
      const candidate = supportedSchemeCandidateEnd(
        text,
        start,
        index,
        wrapper,
      );
      if (
        !candidate.wrapperClosed &&
        lastMarker >= start + MAX_CANDIDATE_LENGTH
      )
        return true;
      if (isCredentialBearingUrl(text.slice(start, candidate.end))) return true;
    }

    if (insideUnquotedAttributeValue) insideUnquotedAttributeValue = false;
    index += 1;
  }
  return false;
};

/**
 * Every candidate in one run, judged by the canonical rule.
 *
 * A candidate starts at a supported scheme wherever that scheme appears in the
 * run -- not only where the run itself starts -- which is what catches a URL
 * embedded after `=`, `,`, `;`, or any other non-delimiter punctuation. The
 * scheme-less SCP and userinfo forms the canonical rule also classifies have no
 * scheme to anchor on, so they are anchored instead on the `@` they all require:
 * the run start is a candidate whenever the run carries userinfo, and so is the
 * offset just past the last `/` or `@` before each further `@`. That offset is
 * where an embedded scheme-less form has to begin -- neither character may
 * appear ahead of the `@` in any of those forms -- so `/user:pw@host/repo.git`
 * and `see/user:pw@host/repo.git` are read as the credential URL the canonical
 * rule reads them to be, and an earlier harmless `@` in `x@y:pw@host/repo.git`
 * cannot hide the later one behind it.
 *
 * Each candidate is handed to `isCredentialBearingUrl` verbatim, with no extra
 * conditions layered on top and no second grammar of this module's own: a
 * supported-scheme URL whose secret sits in a query or fragment rather than its
 * userinfo is rejected here exactly as it is when it appears in a profile. The
 * conservatism that follows is deliberate -- `git:` in the middle of a run that
 * also holds a `?` is judged as the URL the canonical rule reads it to be.
 *
 * Work stays linear in the run and bounded per candidate: candidate starts only
 * ever increase and each is judged at most once, discovery costs one character
 * each, the marker cursor only moves forward across the run, and the canonical
 * rule sees at most one candidate per supported scheme, one per `@`, and one
 * per URL-shaped host label.
 *
 * One scheme-less form needs no `@` at all: the canonical rule reads
 * `host:path?query` and `host:path#fragment` as credential bearing whether or
 * not userinfo precedes the host. Those have neither a scheme nor an `@` to
 * anchor on, so they are anchored on remote-shaped structure around the path
 * colon -- narrow on purpose, because the alternative is reading every colon in
 * prose as a remote. A dotted host label is unambiguous; among single-label
 * hosts, only the conventional local-host name `localhost` is unambiguous
 * enough to recognize without turning compact prose into a remote. So
 * `example.test:repo.git?token=secret` and
 * `localhost:repo.git?token=secret` are candidates, while
 * `Note:something?`, `Version:1.2#notes`, and
 * `Heading:overview/section#part` are not. What the anchor decides is where a
 * candidate starts, never whether it bears a credential -- that stays the
 * canonical rule's answer.
 */
const scanRun = (
  text: string,
  runStart: number,
  runEnd: number,
  hasUserInfo: boolean,
  lastMarker: number,
  lastColon: number,
  lastQueryOrFragment: number,
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

  // `true` stops the whole scan, `false` only settles this candidate; `null`
  // means every later candidate is settled too, because they all start further
  // right than a candidate that already ran out of markers.
  const judge = (start: number): boolean | null => {
    // Userinfo, a query, or a fragment beyond the bounded prefix would decide
    // the canonical verdict on characters this gate refuses to read, so an
    // overlong candidate carrying one is refused rather than cleared.
    if (lastMarker >= start + MAX_CANDIDATE_LENGTH) return true;
    if (firstMarkerFrom(start) >= runEnd) return null;
    const end = Math.min(runEnd, start + MAX_CANDIDATE_LENGTH);
    return isCredentialBearingUrl(text.slice(start, end));
  };

  let lastSchemeLessStart = -1;
  let lastBoundary = runStart - 1;
  let colonSinceBoundary = -1;
  let labelStart = runStart;
  let labelHasDot = false;

  /**
   * One scheme-less candidate, judged at most once. Every scheme-less form
   * spells a literal `:` after at least one character, so a candidate with no
   * colon left ahead of it cannot be one of them; the colon is located during
   * the run scan, so that check costs nothing here and keeps ordinary
   * `@`-bearing prose -- an email address -- off the canonical rule.
   */
  const judgeSchemeLess = (offset: number): boolean | null => {
    // Every scheme-less form opens with at least one character that is not a
    // colon, so leading colons are stepped over rather than allowed to fail a
    // candidate that is credential bearing one character further on -- a run
    // that begins `:user:pw@host/repo.git` reads as its own evasion otherwise.
    // The skipped stretch holds no `/` and no `@`, so no two candidates ever
    // walk the same characters.
    let start = offset;
    while (start < runEnd && text[start] === ":") start += 1;
    if (start === lastSchemeLessStart || lastColon <= start) return false;
    lastSchemeLessStart = start;
    return judge(start);
  };

  /**
   * Whether the candidate starting at `start` can match a scheme-less form that
   * uses the `@` at `at` as its userinfo separator. Both branches are necessary
   * conditions read straight off the canonical rule, so nothing this rejects
   * could have been credential bearing:
   *
   * - the `user:secret@host` forms need a colon between the start and that `@`,
   *   and at least one host character after it that is none of `/`, `@`, `:`;
   * - the query and fragment form needs a `?` or `#` somewhere past the start.
   *
   * `@` is the anchor rather than an approximation of one: the text those forms
   * allow before their separator excludes `@` and `/`, so this `@` is the only
   * one a match from `start` could use. The check keeps repetitive URL-shaped
   * filler -- `a:b@/a:b@/...` -- off the canonical rule, which is what stops a
   * pathological run from costing one bounded slice per `@` in it.
   */
  const canOpenSchemeLessForm = (start: number, at: number): boolean => {
    if (lastQueryOrFragment > start) return true;
    if (colonSinceBoundary <= start) return false;
    const host = at + 1 < runEnd ? text[at + 1]! : "";
    return host !== "" && host !== ":" && !isAuthorityBoundary(host);
  };

  if (hasUserInfo && judgeSchemeLess(runStart) === true) return true;

  for (let index = runStart; index < runEnd; index += 1) {
    const character = text[index]!;
    if (isSupportedSchemeAt(text, index)) {
      const verdict = judge(index);
      if (verdict === true) return true;
      if (verdict === null) return false;
    }
    if (character === AT_SIGN) {
      const start = Math.max(runStart, lastBoundary + 1);
      if (canOpenSchemeLessForm(start, index)) {
        const verdict = judgeSchemeLess(start);
        if (verdict === true) return true;
        if (verdict === null) return false;
      }
    }
    if (character === ".") labelHasDot = true;
    if (character === ":") {
      colonSinceBoundary = index;
      // A label immediately ahead of this colon, with a query or a fragment
      // somewhere past it, is the URL-shaped start of a scheme-less remote that
      // carries no userinfo -- provided the host is unambiguous: either dotted,
      // or the conventional single-label local host. A dotted host begins at
      // `labelStart`. `localhost` may itself be embedded after punctuation that
      // is legal elsewhere in a run, so locate that exact label at the colon and
      // require a non-host character before it.
      const localhostStart = index - "localhost".length;
      const localhostBefore =
        localhostStart > runStart ? text[localhostStart - 1]! : "";
      const isEmbeddedLocalhost =
        localhostStart >= runStart &&
        text.slice(localhostStart, index).toLowerCase() === "localhost" &&
        (localhostStart === runStart || !/[a-z0-9._-]/iu.test(localhostBefore));
      const candidateStart = labelHasDot
        ? labelStart
        : isEmbeddedLocalhost
          ? localhostStart
          : -1;
      if (
        candidateStart >= runStart &&
        lastQueryOrFragment > index &&
        judgeSchemeLess(candidateStart) === true
      )
        return true;
      labelStart = index + 1;
      labelHasDot = false;
    }
    if (isAuthorityBoundary(character)) {
      lastBoundary = index;
      colonSinceBoundary = -1;
      labelStart = index + 1;
      labelHasDot = false;
    }
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
    let lastColon = -1;
    let lastQueryOrFragment = -1;
    while (
      runEnd < text.length &&
      !isDelimiter(text[runEnd]!, splitOnBackslash)
    ) {
      const character = text[runEnd]!;
      if (isRiskMarker(character)) {
        lastMarker = runEnd;
        if (character === AT_SIGN) hasUserInfo = true;
        else lastQueryOrFragment = runEnd;
      }
      if (character === ":") lastColon = runEnd;
      runEnd += 1;
    }
    if (
      scanRun(
        text,
        runStart,
        runEnd,
        hasUserInfo,
        lastMarker,
        lastColon,
        lastQueryOrFragment,
      )
    )
      return true;
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
  return (
    scanSupportedSchemes(text) || scanText(text, true) || scanText(text, false)
  );
};
