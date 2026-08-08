import { FileSystemAdapter, Modal, TFile, type App } from "obsidian";

import type {
  ExportPlan,
  GenerationToken,
  Sha256Digest,
  SourceNoteMetadata,
} from "../contracts/export-plan";
import {
  createIssue,
  ISSUE_CODES,
  type BlockerIssue,
} from "../contracts/issues";
import {
  mdxRelayErr,
  mdxRelayOk,
  type MdxRelayResult,
} from "../contracts/result";
import { sha256OfBytes } from "../canonical/hash";
import type { PlanSourceBytes } from "../planning/build-export-plan";

export interface ActiveMarkdownCapture {
  readonly generationToken: GenerationToken;
  readonly note: SourceNoteMetadata;
  readonly bytes: Uint8Array;
}

export interface PreviewModalHandle {
  readonly element: HTMLElement;
  close(): void;
}

export interface ObsidianHost {
  captureActiveMarkdown(
    generationToken: GenerationToken,
  ): Promise<MdxRelayResult<ActiveMarkdownCapture>>;
  recapturePlanSources(
    plan: ExportPlan,
  ): Promise<MdxRelayResult<PlanSourceBytes>>;
  openModal(
    mount: (element: HTMLElement, close: () => void) => void,
    onClose: () => void,
  ): PreviewModalHandle;
}

const captureFailure = (): MdxRelayResult<never> =>
  mdxRelayErr([createIssue(ISSUE_CODES.staleDuringPlanning) as BlockerIssue]);

class AdapterModal extends Modal {
  private closed = false;

  constructor(
    app: App,
    private readonly mountShell: (
      element: HTMLElement,
      close: () => void,
    ) => void,
    private readonly notifyClose: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.mountShell(this.contentEl, () => this.close());
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.closed) {
      this.closed = true;
      this.notifyClose();
    }
  }
}

/**
 * The sole Obsidian API boundary used by preview orchestration and UI.
 * Captures use binary reads so fingerprints describe the exact source bytes.
 */
export class ObsidianHostAdapter implements ObsidianHost {
  constructor(private readonly app: App) {}

  async captureActiveMarkdown(
    generationToken: GenerationToken,
  ): Promise<MdxRelayResult<ActiveMarkdownCapture>> {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md")
      return captureFailure();
    try {
      const bytes = new Uint8Array(await this.app.vault.readBinary(file));
      const realPath =
        this.app.vault.adapter instanceof FileSystemAdapter
          ? this.app.vault.adapter.getFullPath(file.path)
          : file.path;
      return mdxRelayOk({
        generationToken,
        bytes,
        note: {
          vaultRelativePath: file.path,
          realPath,
          byteLength: bytes.byteLength,
          contentSha256: sha256OfBytes(bytes),
        },
      });
    } catch {
      return captureFailure();
    }
  }

  async recapturePlanSources(
    plan: ExportPlan,
  ): Promise<MdxRelayResult<PlanSourceBytes>> {
    try {
      const noteFile = this.app.vault.getAbstractFileByPath(
        plan.sourceNote.vaultRelativePath,
      );
      if (!(noteFile instanceof TFile)) return captureFailure();
      const note = new Uint8Array(await this.app.vault.readBinary(noteFile));
      const images = new Map<string, Uint8Array>();
      for (const image of plan.sourceImages) {
        const file = this.app.vault.getAbstractFileByPath(
          image.vaultRelativePath,
        );
        if (!(file instanceof TFile)) return captureFailure();
        images.set(
          image.sourceId,
          new Uint8Array(await this.app.vault.readBinary(file)),
        );
      }
      return mdxRelayOk({ note, images });
    } catch {
      return captureFailure();
    }
  }

  openModal(
    mount: (element: HTMLElement, close: () => void) => void,
    onClose: () => void,
  ): PreviewModalHandle {
    const modal = new AdapterModal(this.app, mount, onClose);
    modal.open();
    return {
      element: modal.contentEl,
      close: () => modal.close(),
    };
  }
}

export type HostHash = (bytes: Uint8Array) => Sha256Digest;
