import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  PluginSettingTab: class {
    containerEl: HTMLElement & { empty(): void };
    constructor() {
      const element = document.createElement("div") as HTMLElement & {
        empty(): void;
      };
      element.empty = () => element.replaceChildren();
      this.containerEl = element;
    }
  },
  Setting: class {
    constructor(private readonly container: HTMLElement) {}
    setName(): this {
      return this;
    }
    setDesc(): this {
      return this;
    }
    addDropdown(
      configure: (dropdown: {
        addOption(value: string, label: string): unknown;
        setValue(value: string): unknown;
        onChange(callback: (value: string) => unknown): unknown;
      }) => void,
    ): this {
      const select = document.createElement("select");
      const dropdown = {
        addOption: (value: string, label: string) => {
          select.add(new Option(label, value));
          return dropdown;
        },
        setValue: (value: string) => {
          select.value = value;
          return dropdown;
        },
        onChange: (callback: (value: string) => unknown) => {
          select.addEventListener("change", () => callback(select.value));
          return dropdown;
        },
      };
      configure(dropdown);
      this.container.append(select);
      return this;
    }
    addText(
      configure: (text: {
        setPlaceholder(value: string): unknown;
        setValue(value: string): unknown;
        onChange(callback: (value: string) => unknown): unknown;
      }) => void,
    ): this {
      const input = document.createElement("input");
      const text = {
        setPlaceholder: (value: string) => {
          input.placeholder = value;
          return text;
        },
        setValue: (value: string) => {
          input.value = value;
          return text;
        },
        onChange: (callback: (value: string) => unknown) => {
          input.addEventListener("change", () => callback(input.value));
          return text;
        },
      };
      configure(text);
      this.container.append(input);
      return this;
    }
  },
}));

import { DPW_MIND_NET_V1 } from "../../../src/profiles/builtins/dpw-mind-net-v1";
import {
  DEFAULT_MDX_RELAY_SETTINGS,
  LiveSettings,
  MdxRelaySettingTab,
} from "../../../src/obsidian/settings";

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

describe("MDX Relay settings", () => {
  beforeEach(() => document.body.replaceChildren());

  it("loads only the persisted settings shape", async () => {
    const valid = new LiveSettings({
      loadData: async () => ({
        profileId: DPW_MIND_NET_V1.id,
        targetRoot: "/target/one",
      }),
      saveData: vi.fn(),
    });
    await valid.load();
    expect(valid.current()).toEqual({
      profileId: DPW_MIND_NET_V1.id,
      targetRoot: "/target/one",
    });

    const invalid = new LiveSettings({
      loadData: async () => ({ profileId: "unknown", targetRoot: 1 }),
      saveData: vi.fn(),
    });
    await invalid.load();
    expect(invalid.current()).toBe(DEFAULT_MDX_RELAY_SETTINGS);
  });

  it("persists target changes and exposes them immediately after save", async () => {
    const saveData = vi.fn(async () => undefined);
    const settings = new LiveSettings({
      loadData: async () => ({
        profileId: DPW_MIND_NET_V1.id,
        targetRoot: "/target/one",
      }),
      saveData,
    });
    await settings.load();
    const tab = new MdxRelaySettingTab(
      {} as never,
      {} as never,
      settings,
    ) as MdxRelaySettingTab & { containerEl: HTMLElement };
    tab.display();
    await flush();
    const input = tab.containerEl.querySelector("input")!;
    const select = tab.containerEl.querySelector("select")!;
    const feedback = tab.containerEl.querySelector(
      ".mdx-relay-target-folder-feedback",
    ) as HTMLElement;
    expect(input.value).toBe("/target/one");
    expect(select.value).toBe(DPW_MIND_NET_V1.id);
    expect(feedback.dataset.valid).toBe("false");
    expect(feedback.textContent).toBe("Target folder does not exist.");

    input.value = "/target/two";
    input.dispatchEvent(new Event("change"));
    await flush();

    expect(saveData).toHaveBeenCalledWith({
      profileId: DPW_MIND_NET_V1.id,
      targetRoot: "/target/two",
    });
    expect(settings.current().targetRoot).toBe("/target/two");
  });

  it("flags tilde and relative target folders inline", async () => {
    const settings = new LiveSettings({
      loadData: async () => ({
        profileId: DPW_MIND_NET_V1.id,
        targetRoot: "~/projects/site",
      }),
      saveData: vi.fn(async () => undefined),
    });
    await settings.load();
    const tab = new MdxRelaySettingTab(
      {} as never,
      {} as never,
      settings,
    ) as MdxRelaySettingTab & { containerEl: HTMLElement };
    tab.display();
    await flush();
    const feedback = tab.containerEl.querySelector(
      ".mdx-relay-target-folder-feedback",
    ) as HTMLElement;
    expect(feedback.dataset.valid).toBe("false");
    expect(feedback.textContent).toContain("~ is not expanded");

    const input = tab.containerEl.querySelector("input")!;
    input.value = "relative/path";
    input.dispatchEvent(new Event("change"));
    await flush();
    expect(feedback.textContent).toBe(
      "Target folder must be an absolute path.",
    );
  });

  it("publishes the live value before persistence completes", async () => {
    let finishSave: () => void = () => undefined;
    const saveData = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const settings = new LiveSettings({
      loadData: async () => ({
        profileId: DPW_MIND_NET_V1.id,
        targetRoot: "/target/one",
      }),
      saveData,
    });
    await settings.load();

    const updating = settings.update({
      profileId: DPW_MIND_NET_V1.id,
      targetRoot: "/target/two",
    });
    expect(settings.current().targetRoot).toBe("/target/two");
    finishSave();
    await updating;
  });
});
