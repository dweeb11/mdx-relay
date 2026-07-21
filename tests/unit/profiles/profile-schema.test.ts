import { describe, expect, it } from "vitest";

import { ISSUE_CODES } from "../../../src/contracts/issues";
import { DPW_MIND_NET_V1 } from "../../../src/profiles/builtins/dpw-mind-net-v1";
import {
  canonicalizeProfileData,
  validatePortableProfile,
} from "../../../src/profiles/portable-profile";

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
    expect(result.value.snapshot).toBe(
      '{"commit":{"message":"Publish {title}"},"document":{"callouts":"blockquote","frontmatterPreset":"dpw-post-v1","preset":"dpw-mind-net-v1","wikilinks":"flatten"},"id":"dpw-mind-net-v1","images":{"component":"PostImage","filenameTemplate":"img-{index}.webp","maxDimension":2000,"webpQuality":85},"name":"DPW Mind Net","output":{"assetRoot":"public/posts","assetUrlTemplate":"/posts/{slug}/{assetFile}","contentRoot":"content/posts"},"repository":{"branch":"main","remote":"origin"},"schemaVersion":1}',
    );
    expect(result.value.profileSnapshotSha256).toBe(
      "sha256:3ce13ea7fab368516d05e8fdd55880a3a01e672812bfb32118c4c93a06c20ddb",
    );
    expect(result.value.snapshot).not.toContain("/Users/");
  });

  it("rejects every unknown key without reflecting it", () => {
    const profile = cloneBuiltin();
    profile.secretScript = "do-not-reflect";
    expectBlocked(profile, ISSUE_CODES.invalidProfile);

    const nested = cloneBuiltin();
    (nested.output as Record<string, unknown>).extra = "do-not-reflect";
    expectBlocked(nested, ISSUE_CODES.invalidProfile);
  });

  it("rejects executable values at any depth", () => {
    const profile = cloneBuiltin();
    (profile.commit as Record<string, unknown>).message = () => "Publish";
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
  ])("rejects unsafe %s paths", (field, unsafePath) => {
    const profile = cloneBuiltin();
    (profile.output as Record<string, unknown>)[field] = unsafePath;
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
    ["filenameTemplate", "img-{slug}.webp"],
    ["message", "Publish {slug}"],
    ["message", "Publish {{title}}"],
  ])("rejects invalid placeholders in %s", (field, template) => {
    const profile = cloneBuiltin();
    const container =
      field === "filenameTemplate"
        ? (profile.images as Record<string, unknown>)
        : field === "message"
          ? (profile.commit as Record<string, unknown>)
          : (profile.output as Record<string, unknown>);
    container[field] = template;
    expectBlocked(profile, ISSUE_CODES.invalidProfile);
  });

  it.each([
    "https://writer:token@example.invalid/site.git",
    "https://token@example.invalid/site.git",
  ])("rejects credential-bearing repository URLs", (repositoryUrl) => {
    const profile = cloneBuiltin();
    (profile.repository as Record<string, unknown>).url = repositoryUrl;
    expectBlocked(profile, ISSUE_CODES.credentialUrl);
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
    Object.setPrototypeOf(nonPlain.repository, { inherited: true });
    expectBlocked(nonPlain, ISSUE_CODES.invalidProfile);

    const throwingProxy = new Proxy(cloneBuiltin(), {
      ownKeys: () => {
        throw new Error("do not inspect");
      },
    });
    expectBlocked(throwingProxy, ISSUE_CODES.invalidProfile);
  });

  it("rejects malformed credential-like URLs without throwing", () => {
    const profile = cloneBuiltin();
    (profile.repository as Record<string, unknown>).url = "https://[";
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
    (template.commit as Record<string, unknown>).message =
      `Publish {title}${String.fromCharCode(0xd800)}`;
    expectBlocked(template, ISSUE_CODES.invalidProfile);
  });

  it("canonicalizes every JSON value shape and rejects non-JSON values", () => {
    expect(canonicalizeProfileData(null)).toBe("null");
    expect(canonicalizeProfileData(true)).toBe("true");
    expect(canonicalizeProfileData("profile")).toBe('"profile"');
    expect(canonicalizeProfileData([1, "two", false])).toBe('[1,"two",false]');
    expect(() => canonicalizeProfileData(Number.NaN)).toThrow(
      "Non-finite JSON number",
    );
    expect(() => canonicalizeProfileData(undefined)).toThrow(
      "Non-JSON profile value",
    );
    expect(() => canonicalizeProfileData({ invalid: undefined })).toThrow(
      "Non-JSON profile value",
    );

    const hidden = Object.defineProperty({}, "hidden", {
      enumerable: false,
      value: "silently dropped",
    });
    expect(() => canonicalizeProfileData(hidden)).toThrow(
      "Non-JSON profile value",
    );

    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "not read";
      },
    });
    expect(() => canonicalizeProfileData(accessor)).toThrow(
      "Non-JSON profile value",
    );
    expect(getterCalls).toBe(0);

    const sparse = Array.from({ length: 2 }) as unknown[];
    sparse[0] = "present";
    delete sparse[1];
    expect(() => canonicalizeProfileData(sparse)).toThrow(
      "Non-JSON profile value",
    );

    const nonPlainArray = ["value"];
    Object.setPrototypeOf(nonPlainArray, null);
    expect(() => canonicalizeProfileData(nonPlainArray)).toThrow(
      "Non-JSON profile value",
    );
  });
});
