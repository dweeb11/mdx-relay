/**
 * One audited RFC 8785 (JCS) canonicalizer and the byte-rule helpers that
 * surround it. This module MUST NOT import any Node built-in — the worker
 * bundle marks Node built-ins `external`, and a `node:crypto` edge here would
 * survive the build then fail at runtime. Hashing lives in `hash.ts` (S3).
 * See ADR 0002.
 */

/**
 * True only for strings that are well-formed Unicode. A lone UTF-16 surrogate
 * has no UTF-8 encoding, so Node substitutes U+FFFD when hashing it and two
 * different lone surrogates would collapse to the same digest. Everything that
 * canonicalizes or hashes text refuses such a string instead.
 */
export const isWellFormedUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xdc00 && code <= 0xdfff) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
      index += 1;
    }
  }
  return true;
};

/**
 * Structural equality over plain JSON data. Used by planning to compare
 * fingerprints and sealed outputs without hashing.
 */
export const deepEquals = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEquals(value, right[index]))
    );
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  )
    return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        deepEquals(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    )
  );
};

/**
 * True when `value` is a plain JSON data property graph: only null, boolean,
 * number, well-formed strings, dense plain arrays, and plain objects with
 * enumerable own data properties. Cycles, accessors, symbols, exotic
 * prototypes, sparse arrays, and lone surrogates fail. Kept separate from
 * `canonicalizeJcs` because profile validation needs a boolean gate before the
 * credential-URL and unsafe-path walks — see ADR 0002 §1.
 */
export const isPlainDataPropertyGraph = (
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet(),
): boolean => {
  if (value === null) return true;
  if (typeof value === "string") return isWellFormedUnicode(value);
  if (typeof value === "boolean" || typeof value === "number") return true;
  if (typeof value !== "object" || ancestors.has(value)) return false;

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (
    (isArray && prototype !== Array.prototype) ||
    (!isArray && prototype !== Object.prototype)
  )
    return false;

  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) => typeof key === "symbol" || !isWellFormedUnicode(key as string),
    )
  )
    return false;
  if (
    isArray &&
    (keys.length !== value.length + 1 ||
      !keys.every(
        (key) =>
          key === "length" ||
          (/^(?:0|[1-9]\d*)$/u.test(key as string) &&
            Number(key) < value.length),
      ))
  )
    return false;

  ancestors.add(value);
  for (const key of keys) {
    if (isArray && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      !isPlainDataPropertyGraph(descriptor.value, ancestors)
    ) {
      ancestors.delete(value);
      return false;
    }
  }
  ancestors.delete(value);
  return true;
};

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalString = (value: string): string => {
  // RFC 8785 requires canonicalization to terminate on invalid Unicode rather
  // than emit an escape for a code unit that has no UTF-8 encoding.
  if (!isWellFormedUnicode(value))
    throw new TypeError("Lone UTF-16 surrogate in JSON string");
  return JSON.stringify(value);
};

/**
 * Own enumerable data properties in their own insertion order. Accessors, own
 * symbol keys and exotic prototypes are refused instead of being read: JCS
 * output has to be a function of JSON data alone, and a getter or a `toJSON`
 * would let the value being canonicalized choose its own manifest.
 */
const jsonDataKeys = (value: object): readonly string[] => {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError("Unsupported JSON object prototype");
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new TypeError("Symbol key in JSON object");
  const keys: string[] = [];
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!("value" in descriptor))
      throw new TypeError("Accessor in JSON object");
    if (descriptor.enumerable) keys.push(key);
    else throw new TypeError("Non-enumerable key in JSON object");
  }
  return keys;
};

/** Canonical array index strings: no leading zeros, no sign, no exponent. */
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/u;

/**
 * The length of a dense plain array whose every element is an own enumerable
 * data property. Arrays are held to exactly the contract objects are held to:
 * an indexed getter, a hidden or symbol property, a hole or a named key is
 * refused rather than read, because an element the array can compute is not
 * JSON data and would let the value choose its own manifest. Nothing here reads
 * an element, so no accessor runs before it has been rejected.
 */
const jsonDataElementCount = (value: readonly unknown[]): number => {
  if (Object.getPrototypeOf(value) !== Array.prototype)
    throw new TypeError("Unsupported JSON array prototype");
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new TypeError("Symbol key in JSON array");
  let elements = 0;
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (key === "length") continue;
    if (!ARRAY_INDEX.test(key) || Number(key) >= value.length)
      throw new TypeError("Non-index key in JSON array");
    if (!("value" in descriptor)) throw new TypeError("Accessor in JSON array");
    if (!descriptor.enumerable)
      throw new TypeError("Non-enumerable key in JSON array");
    elements += 1;
  }
  if (elements !== value.length) throw new TypeError("Hole in JSON array");
  return elements;
};

const canonicalizeJcsWithAncestors = (
  value: unknown,
  ancestors: WeakSet<object>,
): string => {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "string") return canonicalString(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite JSON number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("Unsupported JSON value");
  if (ancestors.has(value)) throw new TypeError("Cyclic JSON value");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const elements = jsonDataElementCount(value);
      const entries: string[] = [];
      for (let index = 0; index < elements; index += 1)
        entries.push(canonicalizeJcsWithAncestors(value[index], ancestors));
      return `[${entries.join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${[...jsonDataKeys(record)]
      .sort(compareCodeUnits)
      .map(
        (key) =>
          `${canonicalString(key)}:${canonicalizeJcsWithAncestors(record[key], ancestors)}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
};

/**
 * RFC 8785 JSON Canonicalization Scheme. Keys sort by UTF-16 code unit, strings
 * and numbers use the ECMAScript serializations JCS defers to, and anything
 * that is not well-formed finite JSON data throws rather than canonicalizing to
 * something an attacker could steer. Cyclic graphs throw `TypeError` via an
 * explicit `WeakSet` check rather than overflowing the stack.
 */
export function canonicalizeJcs(value: unknown): string {
  return canonicalizeJcsWithAncestors(value, new WeakSet());
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("compareCodeUnits", () => {
    it("orders by UTF-16 code unit and returns zero for equal keys", () => {
      expect(compareCodeUnits("A", "a")).toBe(-1);
      expect(compareCodeUnits("a", "A")).toBe(1);
      expect(compareCodeUnits("same", "same")).toBe(0);
    });
  });
}
