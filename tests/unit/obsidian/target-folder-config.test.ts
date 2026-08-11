import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  classifyTargetFolderConfig,
  probeTargetFolderConfig,
  targetFolderConfigMessage,
} from "../../../src/obsidian/target-folder-config";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "mdx-relay-target-config-"));
  roots.push(root);
  return root;
};

describe("target folder config validation", () => {
  it("rejects empty, tilde, relative, and unsafe shapes", () => {
    expect(classifyTargetFolderConfig("")).toEqual({
      ok: false,
      problem: "empty",
    });
    expect(classifyTargetFolderConfig("~/projects/site")).toEqual({
      ok: false,
      problem: "tilde",
    });
    expect(classifyTargetFolderConfig("projects/site")).toEqual({
      ok: false,
      problem: "relative",
    });
    expect(classifyTargetFolderConfig("/projects/../site")).toEqual({
      ok: false,
      problem: "unsafe",
    });
    expect(classifyTargetFolderConfig("/absolute/path/to/site")).toEqual({
      ok: true,
    });
  });

  it("probes missing, file, symlink, and directory roots", async () => {
    const root = await temporaryRoot();
    const missing = join(root, "missing");
    const filePath = join(root, "file");
    const linked = join(root, "link");
    await writeFile(filePath, "not a directory");
    await symlink(root, linked);

    expect(await probeTargetFolderConfig(missing)).toEqual({
      ok: false,
      problem: "missing",
    });
    expect(await probeTargetFolderConfig(filePath)).toEqual({
      ok: false,
      problem: "not-directory",
    });
    expect(await probeTargetFolderConfig(linked)).toEqual({
      ok: false,
      problem: "symlink",
    });
    expect(await probeTargetFolderConfig(root)).toEqual({ ok: true });
  });

  it("maps problems to settings copy", () => {
    expect(
      targetFolderConfigMessage({ ok: false, problem: "tilde" }),
    ).toContain("~ is not expanded");
    expect(targetFolderConfigMessage({ ok: false, problem: "missing" })).toBe(
      "Target folder does not exist.",
    );
    expect(
      targetFolderConfigMessage({ ok: false, problem: "inaccessible" }),
    ).toBe("Target folder is inaccessible.");
    expect(targetFolderConfigMessage({ ok: true })).toBeUndefined();
  });
});
