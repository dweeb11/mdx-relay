import type { App, PluginManifest } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GenerationToken } from "../../../src/contracts/export-plan";
import { mdxRelayOk } from "../../../src/contracts/result";
import MdxRelayPlugin, {
  registerConfiguredPreviewCommand,
} from "../../../src/main";
import type { PreviewCommandDeps } from "../../../src/obsidian/preview-command";
import {
  buildFakePreview,
  fakeCapture,
  FakeObsidianHost,
  FAKE_IMAGE_BYTES,
  FAKE_NOTE_BYTES,
} from "../../helpers/fake-obsidian-host";

vi.mock("obsidian", () => ({
  Plugin: class {
    addCommand = vi.fn();
    register = vi.fn();
  },
}));

const generationToken = "generation-main" as GenerationToken;

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const configuredDeps = (host: FakeObsidianHost): PreviewCommandDeps => ({
  host,
  createGenerationToken: () => generationToken,
  buildPreview: async () => mdxRelayOk(buildFakePreview(generationToken)),
  cancelGeneration: vi.fn(),
  recaptureApproval: async (plan) =>
    mdxRelayOk({
      sourceBytes: {
        note: FAKE_NOTE_BYTES,
        images: new Map([["image-1", FAKE_IMAGE_BYTES]]),
      },
      fingerprint: plan.approvalFingerprint,
    }),
  recordApproval: async (planId) => mdxRelayOk(planId),
  applyApprovedWrites: async () => ({
    ok: true,
    report: { completed: [], failed: [], unattempted: [] },
  }),
});

describe("plugin preview composition", () => {
  beforeEach(() => document.body.replaceChildren());

  it("registers no preview command when production has no configured pipeline", () => {
    const plugin = new MdxRelayPlugin({} as App, {} as PluginManifest);
    const addCommand = vi.spyOn(plugin, "addCommand");
    const register = vi.spyOn(plugin, "register");

    plugin.onload();
    plugin.onunload();

    expect(addCommand).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it("registers a working configured command and disposes it on unload", async () => {
    const host = new FakeObsidianHost();
    host.queueCapture(mdxRelayOk(fakeCapture(generationToken)));
    let callback: (() => void) | undefined;
    let dispose: (() => void) | undefined;
    const plugin = {
      addCommand: vi.fn(
        (command: { callback: () => void }) =>
          void (callback = command.callback),
      ),
      register: vi.fn((registered: () => void) => void (dispose = registered)),
    };
    const deps = configuredDeps(host);

    registerConfiguredPreviewCommand(plugin as never, deps);
    expect(plugin.addCommand).toHaveBeenCalledWith(
      expect.objectContaining({ id: "preview-export" }),
    );
    expect(plugin.register).toHaveBeenCalledTimes(1);

    callback!();
    await flush();
    expect(host.latestModal().textContent).toContain("Ready");
    expect(host.modalElements).toHaveLength(1);

    dispose!();
    callback!();
    expect(host.modalElements).toHaveLength(1);
    expect(deps.cancelGeneration).toHaveBeenCalledWith(generationToken);
  });
});
