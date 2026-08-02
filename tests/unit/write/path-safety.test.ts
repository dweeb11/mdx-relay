import { describe, expect, it } from "vitest";

import {
  isWritableTargetStat,
  resolveContainedTargetPath,
} from "../../../src/write/target-folder-writer";

describe("resolveContainedTargetPath", () => {
  const root = "/tmp/target-root";

  it("joins normalized relative paths under the root", () => {
    expect(resolveContainedTargetPath(root, "content/posts/example.mdx")).toBe(
      "/tmp/target-root/content/posts/example.mdx",
    );
  });

  it("rejects traversal and absolute relatives", () => {
    for (const unsafe of [
      "../escape.mdx",
      "content/../../escape.mdx",
      "/absolute.mdx",
      "content\\windows.mdx",
      "",
      "content//dup.mdx",
      "content/./here.mdx",
      "content/../posts/x.mdx",
    ]) {
      expect(resolveContainedTargetPath(root, unsafe), unsafe).toBeUndefined();
    }
  });
});

describe("isWritableTargetStat", () => {
  it("allows only absent and regular files as writable priors", () => {
    expect(isWritableTargetStat({ kind: "absent" })).toBe(true);
    expect(isWritableTargetStat({ kind: "regularFile", byteLength: 1 })).toBe(
      true,
    );
    expect(isWritableTargetStat({ kind: "directory", byteLength: 0 })).toBe(
      false,
    );
    expect(isWritableTargetStat({ kind: "symlink", byteLength: 0 })).toBe(
      false,
    );
    expect(isWritableTargetStat({ kind: "other", byteLength: 0 })).toBe(false);
  });
});
