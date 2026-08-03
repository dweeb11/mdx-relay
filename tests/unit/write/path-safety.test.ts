import { describe, expect, it } from "vitest";

import { writeAllBytes } from "../../../src/write/node-target-folder-fs";
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
    expect(isWritableTargetStat({ kind: "regularFile" })).toBe(true);
    expect(isWritableTargetStat({ kind: "directory" })).toBe(false);
    expect(isWritableTargetStat({ kind: "symlink" })).toBe(false);
    expect(isWritableTargetStat({ kind: "other" })).toBe(false);
  });
});

describe("writeAllBytes", () => {
  const bytes = Uint8Array.of(1, 2, 3, 4, 5);

  it("loops until every sealed byte is accepted", async () => {
    const chunks: number[] = [];
    // A filesystem that persists one byte per call still yields the whole
    // buffer; a single unchecked write would have truncated it to one byte.
    await writeAllBytes(
      {
        write: (buffer, offset) => {
          chunks.push(buffer[offset]!);
          return Promise.resolve({ bytesWritten: 1 });
        },
      },
      bytes,
    );
    expect(Uint8Array.from(chunks)).toEqual(bytes);
  });

  it("advances the offset and remaining length after a short write", async () => {
    const seen: [number, number][] = [];
    await writeAllBytes(
      {
        write: (_buffer, offset, length) => {
          seen.push([offset, length]);
          return Promise.resolve({ bytesWritten: 2 });
        },
      },
      bytes,
    );
    expect(seen).toEqual([
      [0, 5],
      [2, 3],
      [4, 1],
    ]);
  });

  it("fails instead of looping when a write makes no progress", async () => {
    await expect(
      writeAllBytes(
        { write: () => Promise.resolve({ bytesWritten: 0 }) },
        bytes,
      ),
    ).rejects.toThrow(/stalled/u);
  });
});
