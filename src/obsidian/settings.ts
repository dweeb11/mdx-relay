import { PluginSettingTab, Setting, type App, type Plugin } from "obsidian";

import { DPW_MIND_NET_V1 } from "../profiles/builtins/dpw-mind-net-v1";

export interface MdxRelaySettings {
  readonly profileId: typeof DPW_MIND_NET_V1.id;
  readonly targetRoot: string;
}

export interface SettingsPersistence {
  loadData(): Promise<unknown>;
  saveData(data: MdxRelaySettings): Promise<void>;
}

export const DEFAULT_MDX_RELAY_SETTINGS: MdxRelaySettings = Object.freeze({
  profileId: DPW_MIND_NET_V1.id,
  targetRoot: "",
});

const parseSettings = (value: unknown): MdxRelaySettings => {
  if (
    value !== null &&
    typeof value === "object" &&
    "profileId" in value &&
    value.profileId === DPW_MIND_NET_V1.id &&
    "targetRoot" in value &&
    typeof value.targetRoot === "string"
  )
    return Object.freeze({
      profileId: DPW_MIND_NET_V1.id,
      targetRoot: value.targetRoot,
    });
  return DEFAULT_MDX_RELAY_SETTINGS;
};

export class LiveSettings {
  private value: MdxRelaySettings = DEFAULT_MDX_RELAY_SETTINGS;

  constructor(private readonly persistence: SettingsPersistence) {}

  async load(): Promise<void> {
    this.value = parseSettings(await this.persistence.loadData());
  }

  current(): MdxRelaySettings {
    return this.value;
  }

  async update(next: MdxRelaySettings): Promise<void> {
    const value = Object.freeze({ ...next });
    await this.persistence.saveData(value);
    this.value = value;
  }
}

export class MdxRelaySettingTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: Plugin,
    private readonly settings: LiveSettings,
  ) {
    super(app, plugin);
  }

  override display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName("Profile")
      .setDesc("Portable conversion profile")
      .addDropdown((dropdown) => {
        dropdown
          .addOption(DPW_MIND_NET_V1.id, DPW_MIND_NET_V1.name)
          .setValue(this.settings.current().profileId)
          .onChange((profileId) =>
            this.settings.update({
              profileId: profileId as typeof DPW_MIND_NET_V1.id,
              targetRoot: this.settings.current().targetRoot,
            }),
          );
      });
    new Setting(this.containerEl)
      .setName("Target folder")
      .setDesc("Absolute local folder that receives approved files")
      .addText((text) => {
        text
          .setPlaceholder("/absolute/path/to/site")
          .setValue(this.settings.current().targetRoot)
          .onChange((targetRoot) =>
            this.settings.update({
              profileId: this.settings.current().profileId,
              targetRoot,
            }),
          );
      });
  }
}
