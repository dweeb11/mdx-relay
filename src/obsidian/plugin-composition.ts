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
  const workerResource = plugin.manifest.dir
    ? plugin.app.vault.adapter.getResourcePath(
        `${plugin.manifest.dir}/processing.worker.js`,
      )
    : undefined;
  const deps = createLivePreviewCommandDeps({
    host: new ObsidianHostAdapter(plugin.app),
    settings,
    planStoreDeps: createPlanStoreDeps(),
    createWorker: () => {
      if (workerResource === undefined)
        throw new Error("Worker resource is unavailable.");
      return new Worker(workerResource) as unknown as WorkerLike;
    },
  });
  register(plugin, deps);
  return deps;
}
