import type { Plugin } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { configureMdxRelayPlugin } from "../../../src/obsidian/plugin-composition";

describe("plugin composition", () => {
  it("loads settings, adds their surface, and uses the single command seam", async () => {
    const getResourcePath = vi.fn((path: string) => `app://local/${path}`);
    const plugin = {
      app: {
        vault: {
          adapter: { getResourcePath },
        },
      },
      manifest: { dir: ".obsidian/plugins/mdx-relay" },
      loadData: vi.fn(async () => ({
        profileId: "dpw-mind-net-v1",
        targetRoot: "/target/site",
      })),
      saveData: vi.fn(),
      addSettingTab: vi.fn(),
    } as unknown as Plugin;
    const register = vi.fn();

    const deps = await configureMdxRelayPlugin(plugin, register as never);

    expect(plugin.loadData).toHaveBeenCalledOnce();
    expect(plugin.addSettingTab).toHaveBeenCalledOnce();
    expect(getResourcePath).toHaveBeenCalledWith(
      ".obsidian/plugins/mdx-relay/processing.worker.js",
    );
    expect(register).toHaveBeenCalledWith(plugin, deps);
    expect(deps.isConfigured()).toBe(true);
  });
});
