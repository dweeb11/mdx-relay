import type { Plugin } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureMdxRelayPlugin } from "../../../src/obsidian/plugin-composition";

describe("plugin composition", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads settings, adds their surface, and uses the single command seam", async () => {
    const createObjectURL = vi.fn(() => "blob:mdx-relay-worker");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const readBinary = vi.fn(async () => new ArrayBuffer(8));
    const cleanups: Array<() => void> = [];
    const plugin = {
      app: {
        vault: {
          adapter: { readBinary },
        },
      },
      manifest: { dir: ".obsidian/plugins/mdx-relay" },
      loadData: vi.fn(async () => ({
        profileId: "dpw-mind-net-v1",
        targetRoot: "/target/site",
      })),
      saveData: vi.fn(),
      addSettingTab: vi.fn(),
      register: vi.fn((cleanup: () => void) => cleanups.push(cleanup)),
    } as unknown as Plugin;
    const register = vi.fn();

    const deps = await configureMdxRelayPlugin(plugin, register as never);

    expect(plugin.loadData).toHaveBeenCalledOnce();
    expect(plugin.addSettingTab).toHaveBeenCalledOnce();
    expect(readBinary).toHaveBeenCalledWith(
      ".obsidian/plugins/mdx-relay/processing.worker.js",
    );
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(register).toHaveBeenCalledWith(plugin, deps);
    expect(deps.isConfigured()).toBe(true);

    expect(revokeObjectURL).not.toHaveBeenCalled();
    for (const cleanup of cleanups) cleanup();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mdx-relay-worker");
  });
});
