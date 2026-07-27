import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  canonicalizeJcs,
  deepEquals,
  isPlainDataPropertyGraph,
  isWellFormedUnicode,
} from "../../../src/canonical";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "../../fixtures/jcs");
const CANONICAL_INDEX_SOURCE = join(HERE, "../../../src/canonical/index.ts");
const CANONICAL_HASH_SOURCE = join(HERE, "../../../src/canonical/hash.ts");

const VECTOR_NAMES = [
  "arrays",
  "french",
  "structures",
  "unicode",
  "values",
  "weird",
] as const;

const toUtf8Hex = (value: string): string =>
  [...new TextEncoder().encode(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

describe("canonicalizeJcs", () => {
  it("matches the official cyberphone/json-canonicalization vectors", () => {
    for (const name of VECTOR_NAMES) {
      const input = JSON.parse(
        readFileSync(join(FIXTURE_ROOT, "input", `${name}.json`), "utf8"),
      ) as unknown;
      const expected = readFileSync(
        join(FIXTURE_ROOT, "output", `${name}.json`),
        "utf8",
      ).replace(/\r?\n$/u, "");
      const expectedHex = readFileSync(
        join(FIXTURE_ROOT, "outhex", `${name}.txt`),
        "utf8",
      )
        .replace(/\s+/gu, "")
        .toLowerCase();

      const actual = canonicalizeJcs(input);
      expect(actual, name).toBe(expected);
      expect(toUtf8Hex(actual), `${name} hex`).toBe(expectedHex);
    }
  });

  it("throws TypeError on cyclic values instead of overflowing the stack", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalizeJcs(cyclic)).toThrow(TypeError);
    expect(() => canonicalizeJcs(cyclic)).toThrow("Cyclic JSON value");

    const list: unknown[] = [1];
    list.push(list);
    expect(() => canonicalizeJcs(list)).toThrow(TypeError);
    expect(() => canonicalizeJcs(list)).toThrow("Cyclic JSON value");

    const nested: Record<string, unknown> = { outer: { inner: 1 } };
    (nested.outer as Record<string, unknown>).back = nested;
    expect(() => canonicalizeJcs(nested)).toThrow(TypeError);
  });

  it("still accepts a DAG with a shared subtree", () => {
    const shared = { z: 1 };
    expect(canonicalizeJcs({ a: shared, b: shared })).toBe(
      '{"a":{"z":1},"b":{"z":1}}',
    );
  });
});

describe("canonical module Node-free layering", () => {
  it("keeps index.ts free of Node built-ins; hashing stays in hash.ts", () => {
    const indexSource = readFileSync(CANONICAL_INDEX_SOURCE, "utf8");
    const hashSource = readFileSync(CANONICAL_HASH_SOURCE, "utf8");

    // ADR 0002 §2: the worker marks Node built-ins external. A node: edge from
    // index.ts survives the build and fails only at runtime in a Web Worker.
    expect(indexSource).not.toMatch(/\bfrom\s+["']node:/u);
    expect(indexSource).not.toMatch(/\bimport\(\s*["']node:/u);
    expect(indexSource).not.toMatch(/\brequire\(\s*["']node:/u);
    expect(indexSource).not.toMatch(/\bfrom\s+["']\.\/hash(?:\.ts)?["']/u);

    expect(hashSource).toMatch(/\bfrom\s+["']node:crypto["']/u);
    expect(hashSource).toMatch(/\bfrom\s+["']\.\/index["']/u);
  });
});

describe("isWellFormedUnicode", () => {
  it("rejects lone UTF-16 surrogates and accepts astral Unicode", () => {
    for (const wellFormed of ["", "plain", "ünïcode", "😀", "a\u{10FFFF}b"])
      expect(isWellFormedUnicode(wellFormed), wellFormed).toBe(true);
    for (const illFormed of [
      "\uD800",
      "\uDC00",
      "a\uD800b",
      "a\uDC00b",
      "\uD800\uD800",
      "\uDC00\uD800",
      "trailing\uD83D",
    ])
      expect(isWellFormedUnicode(illFormed), JSON.stringify(illFormed)).toBe(
        false,
      );
  });
});

describe("deepEquals", () => {
  it("compares plain planning data structurally", () => {
    expect(deepEquals({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] })).toBe(
      true,
    );
    expect(deepEquals({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEquals([1, 2], [2, 1])).toBe(false);
    expect(deepEquals([1], { 0: 1 })).toBe(false);
    expect(deepEquals(null, {})).toBe(false);
    expect(deepEquals({ a: 1 }, null)).toBe(false);
    expect(deepEquals("a", "a")).toBe(true);
    expect(deepEquals([1, 2], [1, 2])).toBe(true);
    expect(deepEquals(true, false)).toBe(false);
  });
});

describe("isPlainDataPropertyGraph", () => {
  it("accepts plain JSON data and refuses hostile graphs", () => {
    expect(isPlainDataPropertyGraph(null)).toBe(true);
    expect(isPlainDataPropertyGraph(true)).toBe(true);
    expect(isPlainDataPropertyGraph(1)).toBe(true);
    expect(isPlainDataPropertyGraph("plain")).toBe(true);
    expect(isPlainDataPropertyGraph({ a: [1, { b: "x" }] })).toBe(true);
    expect(isPlainDataPropertyGraph([])).toBe(true);

    expect(isPlainDataPropertyGraph(undefined)).toBe(false);
    expect(isPlainDataPropertyGraph(() => 1)).toBe(false);
    expect(isPlainDataPropertyGraph(Symbol("x"))).toBe(false);
    expect(isPlainDataPropertyGraph("\uD800")).toBe(false);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(isPlainDataPropertyGraph(cyclic)).toBe(false);

    const exotic = Object.create(null) as Record<string, unknown>;
    exotic.a = 1;
    expect(isPlainDataPropertyGraph(exotic)).toBe(false);

    const badArray = ["value"];
    Object.setPrototypeOf(badArray, null);
    expect(isPlainDataPropertyGraph(badArray)).toBe(false);

    expect(isPlainDataPropertyGraph({ [Symbol("k")]: 1 })).toBe(false);
    expect(isPlainDataPropertyGraph({ ["\uD800"]: 1 })).toBe(false);

    const sparse = Array.from({ length: 2 }) as unknown[];
    sparse[0] = "present";
    delete sparse[1];
    expect(isPlainDataPropertyGraph(sparse)).toBe(false);

    const named: unknown[] & { extra?: number } = [1];
    named.extra = 2;
    expect(isPlainDataPropertyGraph(named)).toBe(false);

    const hidden = Object.defineProperty({}, "hidden", {
      enumerable: false,
      value: 1,
    });
    expect(isPlainDataPropertyGraph(hidden)).toBe(false);

    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => 1,
    });
    expect(isPlainDataPropertyGraph(accessor)).toBe(false);

    const nestedBad = { ok: { bad: "\uDC00" } };
    expect(isPlainDataPropertyGraph(nestedBad)).toBe(false);
  });
});
