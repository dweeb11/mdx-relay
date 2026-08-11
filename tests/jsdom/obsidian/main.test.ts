import type { App, PluginManifest } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GenerationToken } from "../../../src/contracts/export-plan";
import { mdxRelayOk } from "../../../src/contracts/result";
import MdxRelayPlugin, {
  registerConfiguredPreviewCommand,
  type ConfiguredPreviewCommandDeps,
} from "../../../src/main";
import {
  buildFakePreview,
  fakeCapture,
  FakeObsidianHost,
  FAKE_IMAGE_BYTES,
  FAKE_NOTE_BYTES,
} from "../../helpers/fake-obsidian-host";

const configureMdxRelayPlugin = vi.hoisted(() => vi.fn());

vi.mock("obsidian", () => ({
  Plugin: class {
    addCommand = vi.fn();
    register = vi.fn();
  },
}));
vi.mock("../../../src/obsidian/plugin-composition", () => ({
  configureMdxRelayPlugin,
}));

const generationToken = "generation-main" as GenerationToken;

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const configuredDeps = (
  host: FakeObsidianHost,
): ConfiguredPreviewCommandDeps => ({
  host,
  isConfigured: () => true,
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
  beforeEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it("delegates onload composition without constructing the pipeline", async () => {
    const plugin = new MdxRelayPlugin({} as App, {} as PluginManifest);
    const addCommand = vi.spyOn(plugin, "addCommand");
    const register = vi.spyOn(plugin, "register");

    await plugin.onload();
    plugin.onunload();

    expect(configureMdxRelayPlugin).toHaveBeenCalledWith(
      plugin,
      registerConfiguredPreviewCommand,
    );
    expect(addCommand).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it("registers a working configured command and disposes it on unload", async () => {
    const host = new FakeObsidianHost();
    host.queueCapture(mdxRelayOk(fakeCapture(generationToken)));
    let checkCallback: ((checking: boolean) => boolean | void) | undefined;
    let dispose: (() => void) | undefined;
    const plugin = {
      addCommand: vi.fn(
        (command: { checkCallback: (checking: boolean) => boolean | void }) =>
          void (checkCallback = command.checkCallback),
      ),
      register: vi.fn((registered: () => void) => void (dispose = registered)),
    };
    const deps = configuredDeps(host);

    registerConfiguredPreviewCommand(plugin as never, deps);
    expect(plugin.addCommand).toHaveBeenCalledWith(
      expect.objectContaining({ id: "preview-export" }),
    );
    expect(plugin.register).toHaveBeenCalledTimes(1);

    expect(checkCallback!(true)).toBe(true);
    checkCallback!(false);
    await flush();
    expect(host.latestModal().textContent).toContain("Ready");
    expect(host.modalElements).toHaveLength(1);

    dispose!();
    checkCallback!(false);
    expect(host.modalElements).toHaveLength(1);
    expect(deps.cancelGeneration).toHaveBeenCalledWith(generationToken);
  });

  it("uses current configuration for command visibility and execution", () => {
    const host = new FakeObsidianHost();
    host.queueCapture(mdxRelayOk(fakeCapture(generationToken)));
    let configured = false;
    let checkCallback: ((checking: boolean) => boolean | void) | undefined;
    const plugin = {
      addCommand: vi.fn(
        (command: { checkCallback: (checking: boolean) => boolean | void }) =>
          void (checkCallback = command.checkCallback),
      ),
      register: vi.fn(),
    };
    const deps = {
      ...configuredDeps(host),
      isConfigured: () => configured,
    };
    registerConfiguredPreviewCommand(plugin as never, deps);

    expect(checkCallback!(true)).toBe(false);
    expect(checkCallback!(false)).toBe(false);
    expect(host.modalElements).toHaveLength(0);

    configured = true;
    expect(checkCallback!(true)).toBe(true);
    checkCallback!(false);
    expect(host.modalElements).toHaveLength(1);
  });
});
