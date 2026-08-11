/** Minimal runtime used only when Vitest imports the production plugin entry. */
export class Plugin {
  app: unknown;
  manifest: unknown;

  constructor(app?: unknown, manifest?: unknown) {
    this.app = app;
    this.manifest = manifest;
  }

  addCommand(command: unknown): void {
    void command;
  }

  register(callback: () => unknown): void {
    void callback;
  }
}

export class TFile {
  readonly extension: string;

  constructor(readonly path: string) {
    this.extension = path.split(".").at(-1) ?? "";
  }
}

export class FileSystemAdapter {
  constructor(private readonly root = "/vault") {}

  getFullPath(path: string): string {
    return `${this.root}/${path}`;
  }
}

export class Modal {
  readonly contentEl = document.createElement("div") as HTMLElement & {
    empty(): void;
  };

  constructor(app?: unknown) {
    void app;
    this.contentEl.empty = () => this.contentEl.replaceChildren();
  }

  open(): void {
    (this as { onOpen?: () => void }).onOpen?.();
  }

  close(): void {
    (this as { onClose?: () => void }).onClose?.();
  }
}

export class PluginSettingTab {
  containerEl!: HTMLElement & { empty(): void };

  constructor(app?: unknown, plugin?: unknown) {
    void app;
    void plugin;
  }
}

export class Setting {
  constructor(container?: unknown) {
    void container;
  }

  setName(name: string): this {
    void name;
    return this;
  }

  setDesc(description: string): this {
    void description;
    return this;
  }

  addDropdown(configure: (dropdown: unknown) => void): this {
    void configure;
    return this;
  }

  addText(configure: (text: unknown) => void): this {
    void configure;
    return this;
  }
}
