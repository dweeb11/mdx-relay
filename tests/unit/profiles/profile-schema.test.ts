import { describe, expect, it } from "vitest";

import { canonicalizeJcs } from "../../../src/canonical";
import { ISSUE_CODES } from "../../../src/contracts/issues";
import { DPW_MIND_NET_V1 } from "../../../src/profiles/builtins/dpw-mind-net-v1";
import { parsePortableProfile } from "../../../src/profiles/parse-portable-profile";
import { validatePortableProfile } from "../../../src/profiles/portable-profile";

const expectBlocked = (value: unknown, code: string) => {
  const result = validatePortableProfile(value);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toHaveLength(1);
    expect(result.error[0]).toMatchObject({
      code,
      severity: "blocker",
      stage: "profile",
    });
    expect(result.error[0].displayDetails).toEqual({
      summary:
        code === ISSUE_CODES.unsafePath
          ? "The configured path is unsafe."
          : code === ISSUE_CODES.credentialUrl
            ? "A repository URL contains embedded credentials."
            : "The selected export profile is invalid.",
    });
    expect(result.error[0]).not.toHaveProperty("safePathLabel");
  }
};

const cloneBuiltin = (): Record<string, unknown> =>
  structuredClone(DPW_MIND_NET_V1) as unknown as Record<string, unknown>;

describe("portable profile schema", () => {
  it("accepts the declarative built-in and emits a canonical portable snapshot", () => {
    const result = validatePortableProfile(DPW_MIND_NET_V1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.profile).toEqual(DPW_MIND_NET_V1);
    expect(Object.isFrozen(result.value.profile)).toBe(true);
    for (const rules of [
      result.value.profile.output,
      result.value.profile.document,
      result.value.profile.images,
    ])
      expect(Object.isFrozen(rules)).toBe(true);
    expect(() => {
      (result.value.profile.output as { contentRoot: string }).contentRoot =
        "content/mutated";
    }).toThrow(TypeError);
    expect(result.value.profile.output.contentRoot).toBe("content/posts");
    expect(result.value.snapshot).toBe(
      '{"document":{"callouts":"blockquote","frontmatterPreset":"dpw-post-v1","preset":"dpw-mind-net-v1","wikilinks":"flatten"},"id":"dpw-mind-net-v1","images":{"component":"PostImage","filenameTemplate":"img-{index}.webp","maxDimension":2000,"webpQuality":85},"name":"DPW Mind Net","output":{"assetRoot":"public/posts","assetUrlTemplate":"/posts/{slug}/{assetFile}","contentRoot":"content/posts"},"schemaVersion":1}',
    );
    expect(result.value.profileSnapshotSha256).toBe(
      "sha256:d670b5126b81db6ef41b749b528470aaf9215d6d132f2a131fb304854b2c4191",
    );
    expect(result.value.snapshot).not.toContain("/Users/");
    expect(result.value.profile).not.toHaveProperty("repository");
    expect(result.value.profile).not.toHaveProperty("commit");
  });

  it("parsePortableProfile rejects lone surrogates without the sealing path", () => {
    // validatePortableProfile rejects these via the plain-data graph check
    // before schema parsing; the worker calls parsePortableProfile directly
    // after JSON.parse, so the schema parser must fail closed on its own.
    for (const name of [
      `broken-high-${String.fromCharCode(0xd800)}`,
      `broken-low-${String.fromCharCode(0xdc00)}`,
    ]) {
      const profile = cloneBuiltin();
      profile.name = name;
      expect(parsePortableProfile(profile)).toBeUndefined();
    }
  });

  it("rejects every unknown key without reflecting it", () => {
    const profile = cloneBuiltin();
    profile.secretScript = "do-not-reflect";
    expectBlocked(profile, ISSUE_CODES.invalidProfile);

    const nested = cloneBuiltin();
    (nested.output as Record<string, unknown>).extra = "do-not-reflect";
    expectBlocked(nested, ISSUE_CODES.invalidProfile);

    const nullField = cloneBuiltin();
    nullField.extra = null;
    expectBlocked(nullField, ISSUE_CODES.invalidProfile);
  });

  it("rejects executable values at any depth", () => {
    const profile = cloneBuiltin();
    (profile.output as Record<string, unknown>).contentRoot = () =>
      "content/posts";
    expectBlocked(profile, ISSUE_CODES.invalidProfile);

    const nested = cloneBuiltin();
    (nested.images as Record<string, unknown>).codec = {
      run: () => undefined,
    };
    expectBlocked(nested, ISSUE_CODES.invalidProfile);
  });

  it("rejects hidden and accessor-backed executable fields without invoking getters", () => {
    const symbolField = cloneBuiltin();
    Object.defineProperty(symbolField, Symbol("execute"), {
      enumerable: true,
      value: () => undefined,
    });
    expectBlocked(symbolField, ISSUE_CODES.invalidProfile);

    const hiddenField = cloneBuiltin();
    Object.defineProperty(hiddenField, "execute", {
      enumerable: false,
      value: () => undefined,
    });
    expectBlocked(hiddenField, ISSUE_CODES.invalidProfile);

    let getterCalls = 0;
    const accessorField = cloneBuiltin();
    Object.defineProperty(accessorField, "execute", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return () => undefined;
      },
    });
    expectBlocked(accessorField, ISSUE_CODES.invalidProfile);
    expect(getterCalls).toBe(0);
  });

  it.each([
    ["contentRoot", "../content/posts"],
    ["assetRoot", "public/../private"],
    ["assetRoot", "/var/www/assets"],
    ["contentRoot", "content\\posts"],
    ["contentRoot", "content/posts:secret"],
    ["assetRoot", "public/posts|bad"],
  ])("rejects unsafe %s paths", (field, unsafePath) => {
    const profile = cloneBuiltin();
    (profile.output as Record<string, unknown>)[field] = unsafePath;
    expectBlocked(profile, ISSUE_CODES.unsafePath);
  });

  it.each([
    ["assetUrlTemplate", "/posts/{slug}/bad|segment/{assetFile}"],
    ["assetUrlTemplate", "/posts/%2e%2e/{slug}/{assetFile}"],
    ["assetUrlTemplate", "/posts/%2Fprivate/{slug}/{assetFile}"],
    ["filenameTemplate", "img:{index}.webp"],
  ])("rejects unsafe portable characters in %s", (field, unsafePath) => {
    const profile = cloneBuiltin();
    const container =
      field === "filenameTemplate"
        ? (profile.images as Record<string, unknown>)
        : (profile.output as Record<string, unknown>);
    container[field] = unsafePath;
    expectBlocked(profile, ISSUE_CODES.unsafePath);
  });

  it.each([
    ["contentRoot", "content/.git/posts"],
    ["assetRoot", "public/.GIT/posts"],
    ["assetUrlTemplate", "/posts/.Git/{slug}/{assetFile}"],
  ])("rejects case-insensitive .git segments in %s", (field, unsafePath) => {
    const profile = cloneBuiltin();
    (profile.output as Record<string, unknown>)[field] = unsafePath;
    expectBlocked(profile, ISSUE_CODES.unsafePath);
  });

  it.each([
    ["assetUrlTemplate", "/posts/{slug}/{unknown}"],
    ["assetUrlTemplate", "/posts/{title}/{assetFile}"],
    ["assetUrlTemplate", "/posts/{slug/{assetFile}"],
    ["assetUrlTemplate", "/posts/{slug}}/{assetFile}"],
    ["filenameTemplate", "img-{slug}.webp"],
  ])("rejects invalid placeholders in %s", (field, template) => {
    const profile = cloneBuiltin();
    const container =
      field === "filenameTemplate"
        ? (profile.images as Record<string, unknown>)
        : (profile.output as Record<string, unknown>);
    container[field] = template;
    expectBlocked(profile, ISSUE_CODES.invalidProfile);
  });

  it("rejects non-string placeholder templates", () => {
    const assetTemplate = cloneBuiltin();
    (assetTemplate.output as Record<string, unknown>).assetUrlTemplate = 12;
    expectBlocked(assetTemplate, ISSUE_CODES.invalidProfile);

    const filenameTemplate = cloneBuiltin();
    (filenameTemplate.images as Record<string, unknown>).filenameTemplate = {
      index: 1,
    };
    expectBlocked(filenameTemplate, ISSUE_CODES.invalidProfile);
  });

  it("treats scheme URLs without a credential userinfo segment as non-credential", () => {
    const profile = cloneBuiltin();
    profile.name = "git:@example.invalid/site";
    expect(validatePortableProfile(profile).ok).toBe(true);
  });

  it.each([
    "https://writer:token@example.invalid/site.git",
    "https://token@example.invalid/site.git",
    "https://example.invalid/site.git?access_token=secret",
    "https://example.invalid/site.git?access_token=%73%65%63%72%65%74",
    "git://token@example.invalid/site.git",
    "git@example.invalid:site.git#fragment",
    String.raw`https:\\writer:token@example.invalid\\site.git`,
    "writer:token@example.invalid/site.git",
    "writer:token@example.invalid:site.git",
  ])("rejects credential-bearing strings anywhere in the profile", (url) => {
    const profile = cloneBuiltin();
    profile.name = url;
    expectBlocked(profile, ISSUE_CODES.credentialUrl);
  });

  it("rejects removed Git-shaped profile blocks", () => {
    const withRepository = cloneBuiltin();
    withRepository.repository = { branch: "main", remote: "origin" };
    expectBlocked(withRepository, ISSUE_CODES.invalidProfile);

    const withCommit = cloneBuiltin();
    withCommit.commit = { message: "Publish {title}" };
    expectBlocked(withCommit, ISSUE_CODES.invalidProfile);
  });

  it("fails closed for cyclic and accessor-backed profile data", () => {
    const cyclic = cloneBuiltin();
    cyclic.self = cyclic;
    expectBlocked(cyclic, ISSUE_CODES.invalidProfile);

    const accessorBacked = Object.defineProperty({}, "profile", {
      enumerable: true,
      get: () => {
        throw new Error("access denied");
      },
    });
    expectBlocked(accessorBacked, ISSUE_CODES.invalidProfile);
    expectBlocked({}, ISSUE_CODES.invalidProfile);

    const nonPlain = cloneBuiltin();
    Object.setPrototypeOf(nonPlain.output, { inherited: true });
    expectBlocked(nonPlain, ISSUE_CODES.invalidProfile);

    const throwingProxy = new Proxy(cloneBuiltin(), {
      ownKeys: () => {
        throw new Error("do not inspect");
      },
    });
    expectBlocked(throwingProxy, ISSUE_CODES.invalidProfile);
  });

  it("rejects malformed credential-like URLs without throwing", () => {
    for (const url of [
      "https://writer:token@[::1]/site.git",
      String.raw`https:\\writer:token@example.invalid\\site.git`,
    ]) {
      const profile = cloneBuiltin();
      profile.name = url;
      expectBlocked(profile, ISSUE_CODES.credentialUrl);
    }
  });

  it.each(["PostImage", "PostImage.Nested", "PostImage.Nested.Member"])(
    "accepts JSX component name %s",
    (component) => {
      const profile = cloneBuiltin();
      (profile.images as Record<string, unknown>).component = component;
      expect(validatePortableProfile(profile).ok).toBe(true);
    },
  );

  it.each([
    "PostImage.",
    "PostImage..Nested",
    "PostImage.123",
    "PostImage.9Nested",
  ])("rejects invalid JSX member segments in %s", (component) => {
    const profile = cloneBuiltin();
    (profile.images as Record<string, unknown>).component = component;
    expectBlocked(profile, ISSUE_CODES.invalidProfile);
  });

  it("validates Unicode boundaries in names and templates", () => {
    const validUnicode = cloneBuiltin();
    validUnicode.name = "Portable 😀 Profile";
    expect(validatePortableProfile(validUnicode).ok).toBe(true);

    for (const name of [
      `broken-high-${String.fromCharCode(0xd800)}`,
      `broken-low-${String.fromCharCode(0xdc00)}`,
    ]) {
      const profile = cloneBuiltin();
      profile.name = name;
      expectBlocked(profile, ISSUE_CODES.invalidProfile);
    }

    const template = cloneBuiltin();
    (template.images as Record<string, unknown>).filenameTemplate =
      `img-{index}${String.fromCharCode(0xd800)}.webp`;
    expectBlocked(template, ISSUE_CODES.invalidProfile);
  });

  it.each([String.fromCharCode(0xd800), String.fromCharCode(0xdc00)])(
    "rejects lone surrogate %s recursively in portable fields",
    (surrogate) => {
      const profile = cloneBuiltin();
      (profile.output as Record<string, unknown>).contentRoot =
        `content/${surrogate}`;
      expectBlocked(profile, ISSUE_CODES.invalidProfile);
    },
  );

  it("canonicalizes every JSON value shape and rejects non-JSON values", () => {
    expect(canonicalizeJcs(null)).toBe("null");
    expect(canonicalizeJcs(true)).toBe("true");
    expect(canonicalizeJcs("profile")).toBe('"profile"');
    expect(canonicalizeJcs([1, "two", false])).toBe('[1,"two",false]');
    for (const surrogate of [
      String.fromCharCode(0xd800),
      String.fromCharCode(0xdc00),
    ]) {
      expect(() => canonicalizeJcs({ value: surrogate })).toThrow(TypeError);
    }
    expect(() =>
      canonicalizeJcs({ [String.fromCharCode(0xd800)]: "value" }),
    ).toThrow(TypeError);
    expect(() => canonicalizeJcs(Number.NaN)).toThrow("Non-finite JSON number");
    expect(() => canonicalizeJcs(undefined)).toThrow(TypeError);
    expect(() => canonicalizeJcs({ invalid: undefined })).toThrow(TypeError);

    const hidden = Object.defineProperty({}, "hidden", {
      enumerable: false,
      value: "silently dropped",
    });
    expect(() => canonicalizeJcs(hidden)).toThrow(TypeError);

    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "not read";
      },
    });
    expect(() => canonicalizeJcs(accessor)).toThrow(TypeError);
    expect(getterCalls).toBe(0);

    const sparse = Array.from({ length: 2 }) as unknown[];
    sparse[0] = "present";
    delete sparse[1];
    expect(() => canonicalizeJcs(sparse)).toThrow(TypeError);

    const nonPlainArray = ["value"];
    Object.setPrototypeOf(nonPlainArray, null);
    expect(() => canonicalizeJcs(nonPlainArray)).toThrow(TypeError);
  });
});
