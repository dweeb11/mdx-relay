import type { Plugin } from "obsidian";

import type {
  ConfiguredPreviewCommandDeps,
  registerConfiguredPreviewCommand,
} from "../main";
import { createPlanStoreDeps } from "../planning/plan-store";
import type { WorkerLike } from "../worker/processing-client";
import { ObsidianHostAdapter } from "./host-adapter";
import { createLivePreviewCommandDeps } from "./preview-pipeline";
import { LiveSettings, MdxRelaySettingTab } from "./settings";

type RegisterPreviewCommand = typeof registerConfiguredPreviewCommand;

export async function configureMdxRelayPlugin(
  plugin: Plugin,
  register: RegisterPreviewCommand,
): Promise<ConfiguredPreviewCommandDeps> {
  const settings = new LiveSettings(plugin);
  await settings.load();
  plugin.addSettingTab(new MdxRelaySettingTab(plugin.app, plugin, settings));
  // Obsidian serves vault resources from a per-vault app:// host while the
  // renderer runs on app://obsidian.md, and the Worker constructor rejects a
  // cross-origin script URL. Loading the bundle through the vault adapter and
  // spawning from a same-origin blob URL is the only path that constructs.
  let workerUrl: string | undefined;
  if (plugin.manifest.dir) {
    const bundle = await plugin.app.vault.adapter.readBinary(
      `${plugin.manifest.dir}/processing.worker.js`,
    );
    const url = URL.createObjectURL(
      new Blob([bundle], { type: "text/javascript" }),
    );
    plugin.register(() => URL.revokeObjectURL(url));
    workerUrl = url;
  }
  const deps = createLivePreviewCommandDeps({
    host: new ObsidianHostAdapter(plugin.app),
    settings,
    planStoreDeps: createPlanStoreDeps(),
    createWorker: () => {
      if (workerUrl === undefined)
        throw new Error("Worker resource is unavailable.");
      return new Worker(workerUrl) as unknown as WorkerLike;
    },
  });
  register(plugin, deps);
  return deps;
}
