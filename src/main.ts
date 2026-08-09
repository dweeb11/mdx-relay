import { Plugin } from "obsidian";

import {
  PreviewCommand,
  type PreviewCommandDeps,
} from "./obsidian/preview-command";

/**
 * The single composition seam for a fully configured preview pipeline.
 * Registration owns command disposal through Obsidian's plugin lifecycle.
 */
export function registerConfiguredPreviewCommand(
  plugin: Pick<Plugin, "addCommand" | "register">,
  deps: PreviewCommandDeps,
): PreviewCommand {
  const command = new PreviewCommand(deps);
  plugin.addCommand({
    id: "preview-export",
    name: "Preview MDX export",
    callback: () => command.execute(),
  });
  plugin.register(() => command.unload());
  return command;
}

export default class MdxRelayPlugin extends Plugin {
  override onload(): void {
    // Hidden until a later wiring slice supplies fully configured dependencies.
  }

  override onunload(): void {
    // Configured commands register their own idempotent lifecycle disposer.
  }
}
