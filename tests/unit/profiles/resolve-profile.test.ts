import { describe, expect, it } from "vitest";

import { ISSUE_CODES } from "../../../src/contracts/issues";
import { DPW_MIND_NET_V1 } from "../../../src/profiles/builtins/dpw-mind-net-v1";
import { resolveProfile } from "../../../src/profiles/resolve-profile";

const validBinding = {
  schemaVersion: 1,
  profileId: "dpw-mind-net-v1",
  repositoryRoot: "/Users/example/sites/dpw-mind-net",
  repositoryUrl: "https://example.invalid/dpw-mind-net.git",
} as const;

const expectBlocked = (binding: unknown, code: string) => {
  const result = resolveProfile(DPW_MIND_NET_V1, binding);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toHaveLength(1);
    expect(result.error[0]).toMatchObject({ code, severity: "blocker" });
    expect(JSON.stringify(result.error)).not.toContain("example.invalid");
    expect(JSON.stringify(result.error)).not.toContain("/Users/example");
    expect(result.error[0]).not.toHaveProperty("safePathLabel");
  }
};

describe("profile resolution", () => {
  it("keeps absolute repository data out of the portable profile snapshot", () => {
    const result = resolveProfile(DPW_MIND_NET_V1, validBinding);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.repositoryRoot).toBe(validBinding.repositoryRoot);
    expect(result.value.repositoryUrl).toBe(validBinding.repositoryUrl);
    expect(result.value.portableProfile.id).toBe(validBinding.profileId);
    expect(result.value.portableSnapshot).not.toContain(
      validBinding.repositoryRoot,
    );
    expect(result.value.portableSnapshot).not.toContain(
      validBinding.repositoryUrl,
    );
    expect(result.value.profileSnapshotSha256).toBe(
      "sha256:3ce13ea7fab368516d05e8fdd55880a3a01e672812bfb32118c4c93a06c20ddb",
    );
    expect(result.value.machineBindingFingerprint).toMatch(
      /^sha256:[a-f0-9]{64}$/u,
    );
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it("emits a deterministic fingerprint that changes with the machine binding", () => {
    const first = resolveProfile(DPW_MIND_NET_V1, validBinding);
    const repeated = resolveProfile(
      structuredClone(DPW_MIND_NET_V1),
      structuredClone(validBinding),
    );
    const changed = resolveProfile(DPW_MIND_NET_V1, {
      ...validBinding,
      repositoryRoot: "/Users/example/sites/other-checkout",
    });

    expect(first.ok && repeated.ok && changed.ok).toBe(true);
    if (!first.ok || !repeated.ok || !changed.ok) return;
    expect(repeated.value.machineBindingFingerprint).toBe(
      first.value.machineBindingFingerprint,
    );
    expect(changed.value.machineBindingFingerprint).not.toBe(
      first.value.machineBindingFingerprint,
    );

    const validUnicode = resolveProfile(DPW_MIND_NET_V1, {
      ...validBinding,
      repositoryRoot: "/Users/example/sites/😀",
    });
    expect(validUnicode.ok).toBe(true);
  });

  it("rejects bindings for a different profile", () => {
    expectBlocked(
      { ...validBinding, profileId: "another-profile" },
      ISSUE_CODES.invalidProfile,
    );
  });

  it.each([
    "relative/repository",
    "/Users/example/sites/../secrets",
    "/Users/example/sites/./checkout",
    "C:\\sites\\..\\secrets",
    "//server/share/repository",
  ])("rejects unsafe machine-local repository roots", (repositoryRoot) => {
    expectBlocked({ ...validBinding, repositoryRoot }, ISSUE_CODES.unsafePath);
  });

  it("rejects unknown and executable machine-binding fields", () => {
    expectBlocked(
      { ...validBinding, credential: "not-a-real-secret" },
      ISSUE_CODES.invalidProfile,
    );
    expectBlocked(
      { ...validBinding, resolveRoot: () => validBinding.repositoryRoot },
      ISSUE_CODES.invalidProfile,
    );
    expectBlocked(
      { ...validBinding, [String.fromCharCode(0xd800)]: "invalid-key" },
      ISSUE_CODES.invalidProfile,
    );
    expectBlocked({ ...validBinding, extra: null }, ISSUE_CODES.invalidProfile);
  });

  it("rejects hidden and accessor-backed binding fields without invoking getters", () => {
    const symbolField = structuredClone(validBinding) as Record<
      string,
      unknown
    >;
    Object.defineProperty(symbolField, Symbol("execute"), {
      enumerable: true,
      value: () => undefined,
    });
    expectBlocked(symbolField, ISSUE_CODES.invalidProfile);

    const hiddenField = structuredClone(validBinding) as Record<
      string,
      unknown
    >;
    Object.defineProperty(hiddenField, "execute", {
      enumerable: false,
      value: () => undefined,
    });
    expectBlocked(hiddenField, ISSUE_CODES.invalidProfile);

    let getterCalls = 0;
    const accessorField = structuredClone(validBinding) as Record<
      string,
      unknown
    >;
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
    "https://writer:token@example.invalid/site.git",
    "https://token@example.invalid/site.git",
    "https://example.invalid/site.git?access_token=secret",
    "https://example.invalid/site.git?access_token=%73%65%63%72%65%74",
    "git://token@example.invalid/site.git",
    "ssh://git@example.invalid/site.git#fragment",
    "git@example.invalid:site.git?access_token=secret",
    "git@example.invalid:site.git#fragment",
  ])("rejects credential-bearing binding URLs", (repositoryUrl) => {
    expectBlocked(
      { ...validBinding, repositoryUrl },
      ISSUE_CODES.credentialUrl,
    );
    const serialized = JSON.stringify(
      resolveProfile(DPW_MIND_NET_V1, {
        ...validBinding,
        repositoryUrl,
      }),
    );
    for (const sensitiveValue of [
      "access_token",
      "secret",
      "fragment",
      "site.git",
    ])
      expect(serialized).not.toContain(sensitiveValue);
  });

  it.each([
    "https://example.invalid/dpw-mind-net.git",
    "ssh://git@example.invalid/dpw-mind-net.git",
    "git://example.invalid/dpw-mind-net.git",
    "git@example.invalid:dpw-mind-net.git",
  ])("accepts credential-free repository URL %s", (repositoryUrl) => {
    const result = resolveProfile(DPW_MIND_NET_V1, {
      ...validBinding,
      repositoryUrl,
    });
    expect(result.ok).toBe(true);
  });

  it.each([String.fromCharCode(0xd800), String.fromCharCode(0xdc00)])(
    "rejects lone surrogate %s in every machine-binding string",
    (surrogate) => {
      expectBlocked(
        { ...validBinding, profileId: `profile-${surrogate}` },
        ISSUE_CODES.invalidProfile,
      );
      expectBlocked(
        { ...validBinding, repositoryRoot: `/Users/example/${surrogate}` },
        ISSUE_CODES.invalidProfile,
      );
      expectBlocked(
        {
          ...validBinding,
          repositoryUrl: `https://example.invalid/${surrogate}.git`,
        },
        ISSUE_CODES.invalidProfile,
      );
    },
  );

  it("returns portable-profile validation failures before binding validation", () => {
    const result = resolveProfile({}, validBinding);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error[0]?.code).toBe(ISSUE_CODES.invalidProfile);
  });

  it("fails closed for cyclic and accessor-backed machine bindings", () => {
    const cyclic = structuredClone(validBinding) as Record<string, unknown>;
    cyclic.self = cyclic;
    expectBlocked(cyclic, ISSUE_CODES.invalidProfile);

    const accessorBacked = Object.defineProperty({}, "binding", {
      enumerable: true,
      get: () => {
        throw new Error("access denied");
      },
    });
    expectBlocked(accessorBacked, ISSUE_CODES.invalidProfile);

    const nonPlain = structuredClone(validBinding);
    Object.setPrototypeOf(nonPlain, { inherited: true });
    expectBlocked(nonPlain, ISSUE_CODES.invalidProfile);

    const throwingProxy = new Proxy(structuredClone(validBinding), {
      ownKeys: () => {
        throw new Error("do not inspect");
      },
    });
    expectBlocked(throwingProxy, ISSUE_CODES.invalidProfile);
  });

  it("rejects malformed repository URLs and normalized empty path segments", () => {
    expectBlocked(
      { ...validBinding, repositoryUrl: "" },
      ISSUE_CODES.invalidProfile,
    );
    expectBlocked(
      { ...validBinding, repositoryUrl: "https://[" },
      ISSUE_CODES.invalidProfile,
    );
    expectBlocked(
      { ...validBinding, repositoryRoot: "/Users/example//checkout" },
      ISSUE_CODES.unsafePath,
    );
  });
});
