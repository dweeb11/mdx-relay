import { Plugin } from "obsidian";

import type { GenerationToken } from "./contracts/export-plan";
import { createIssue, ISSUE_CODES } from "./contracts/issues";
import { mdxRelayErr } from "./contracts/result";
import {
  ObsidianHostAdapter,
  registerPreviewCommand,
} from "./obsidian/host-adapter";
import {
  PreviewCommand,
  type PreviewCommandDeps,
} from "./obsidian/preview-command";

/**
 * T6 installs the capture/preview shell. A configured pipeline supplies these
 * collaborators; until configuration exists, the command fails closed in the
 * modal and cannot create approval or write authority.
 */
export const createUnconfiguredPreviewDeps = (
  host: ObsidianHostAdapter,
): PreviewCommandDeps => ({
  host,
  createGenerationToken: () =>
    `generation-${crypto.randomUUID()}` as GenerationToken,
  buildPreview: async () =>
    mdxRelayErr([createIssue(ISSUE_CODES.invalidProfile)]),
  cancelGeneration: () => undefined,
  recaptureApproval: async () =>
    mdxRelayErr([createIssue(ISSUE_CODES.staleApproval)]),
  recordApproval: async () =>
    mdxRelayErr([createIssue(ISSUE_CODES.approvalMismatch)]),
  applyApprovedWrites: async () => ({
    ok: false,
    report: { completed: [], failed: [], unattempted: [] },
    error: [createIssue(ISSUE_CODES.approvalMismatch)],
  }),
});

export default class MdxRelayPlugin extends Plugin {
  private previewCommand: PreviewCommand | undefined;

  override onload(): void {
    const host = new ObsidianHostAdapter(this.app);
    this.previewCommand = new PreviewCommand(
      createUnconfiguredPreviewDeps(host),
    );
    registerPreviewCommand(this, () => this.previewCommand?.execute());
  }

  override onunload(): void {
    this.previewCommand?.unload();
    this.previewCommand = undefined;
  }
}
