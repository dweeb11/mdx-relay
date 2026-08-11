import { FileSystemAdapter, Modal, TFile, type App } from "obsidian";

import type {
  CanonicalDependencySnapshot,
  ExportPlan,
  GenerationToken,
  Sha256Digest,
  SourceImageMetadata,
  SourceNoteMetadata,
} from "../contracts/export-plan";
import {
  createIssue,
  ISSUE_CODES,
  toSafePathLabel,
  type BlockerIssue,
  type SafePathLabel,
} from "../contracts/issues";
import {
  mdxRelayErr,
  mdxRelayOk,
  type MdxRelayResult,
} from "../contracts/result";
import { canonicalizeJcs } from "../canonical";
import { sha256OfBytes, sha256OfUtf8 } from "../canonical/hash";
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

export interface RequestedImageDependency {
  readonly source: string;
  readonly sourceStartOffset: number;
}

export interface CapturedImageDependency {
  readonly sourceId: string;
  readonly vaultRelativePath: string;
  readonly realPath: string;
  readonly safePathLabel: SafePathLabel;
  readonly byteLength: number;
  readonly contentSha256: Sha256Digest;
  readonly bytes: Uint8Array;
}

export interface CapturedImageOccurrence {
  readonly sourceId: string;
  readonly embedSource: string;
  readonly embedSourceStartOffset: number;
}

export interface DependencyCapture {
  readonly snapshot: CanonicalDependencySnapshot;
  readonly snapshotSha256: Sha256Digest;
  readonly images: readonly CapturedImageDependency[];
  readonly occurrences: readonly CapturedImageOccurrence[];
}

export interface ObsidianPipelineHost extends ObsidianHost {
  captureImageDependencies(
    noteVaultRelativePath: string,
    references: readonly RequestedImageDependency[],
  ): Promise<MdxRelayResult<DependencyCapture>>;
  recaptureSources(
    note: SourceNoteMetadata,
    images: readonly Pick<
      SourceImageMetadata,
      "sourceId" | "vaultRelativePath"
    >[],
  ): Promise<MdxRelayResult<PlanSourceBytes>>;
}

const captureBlocker = (issue: BlockerIssue): MdxRelayResult<never> =>
  mdxRelayErr([issue]);

const withDetail = (
  code:
    | typeof ISSUE_CODES.unresolvableImage
    | typeof ISSUE_CODES.unsupportedImage
    | typeof ISSUE_CODES.unsafePath,
  detail: string,
): BlockerIssue => createIssue(code, { detail }) as BlockerIssue;

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
export class ObsidianHostAdapter implements ObsidianPipelineHost {
  constructor(private readonly app: App) {}

  async captureActiveMarkdown(
    generationToken: GenerationToken,
  ): Promise<MdxRelayResult<ActiveMarkdownCapture>> {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md")
      return captureBlocker(createIssue(ISSUE_CODES.noActiveMarkdown));
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
      return captureBlocker(createIssue(ISSUE_CODES.sourceCaptureFailed));
    }
  }

  async recapturePlanSources(
    plan: ExportPlan,
  ): Promise<MdxRelayResult<PlanSourceBytes>> {
    return this.recaptureSources(plan.sourceNote, plan.sourceImages);
  }

  async recaptureSources(
    noteMetadata: SourceNoteMetadata,
    imageMetadata: readonly Pick<
      SourceImageMetadata,
      "sourceId" | "vaultRelativePath"
    >[],
  ): Promise<MdxRelayResult<PlanSourceBytes>> {
    try {
      const noteFile = this.app.vault.getAbstractFileByPath(
        noteMetadata.vaultRelativePath,
      );
      if (!(noteFile instanceof TFile))
        return captureBlocker(createIssue(ISSUE_CODES.sourceCaptureFailed));
      const note = new Uint8Array(await this.app.vault.readBinary(noteFile));
      const images = new Map<string, Uint8Array>();
      for (const image of imageMetadata) {
        const file = this.app.vault.getAbstractFileByPath(
          image.vaultRelativePath,
        );
        if (!(file instanceof TFile))
          return captureBlocker(
            withDetail(ISSUE_CODES.unresolvableImage, image.vaultRelativePath),
          );
        images.set(
          image.sourceId,
          new Uint8Array(await this.app.vault.readBinary(file)),
        );
      }
      return mdxRelayOk({ note, images });
    } catch {
      return captureBlocker(createIssue(ISSUE_CODES.sourceCaptureFailed));
    }
  }

  async captureImageDependencies(
    noteVaultRelativePath: string,
    references: readonly RequestedImageDependency[],
  ): Promise<MdxRelayResult<DependencyCapture>> {
    try {
      const byPath = new Map<string, CapturedImageDependency>();
      const occurrences: CapturedImageOccurrence[] = [];
      for (const reference of references) {
        const file = this.app.metadataCache.getFirstLinkpathDest(
          reference.source,
          noteVaultRelativePath,
        );
        if (!(file instanceof TFile))
          return captureBlocker(
            withDetail(ISSUE_CODES.unresolvableImage, reference.source),
          );
        if (!/^(?:jpe?g|png|webp)$/iu.test(file.extension))
          return captureBlocker(
            withDetail(ISSUE_CODES.unsupportedImage, reference.source),
          );
        let captured = byPath.get(file.path);
        if (captured === undefined) {
          const bytes = new Uint8Array(await this.app.vault.readBinary(file));
          const safePathLabel = toSafePathLabel(file.path);
          if (safePathLabel === undefined)
            return captureBlocker(
              withDetail(ISSUE_CODES.unsafePath, reference.source),
            );
          captured = Object.freeze({
            sourceId: `image-${byPath.size + 1}`,
            vaultRelativePath: file.path,
            realPath:
              this.app.vault.adapter instanceof FileSystemAdapter
                ? this.app.vault.adapter.getFullPath(file.path)
                : file.path,
            safePathLabel,
            byteLength: bytes.byteLength,
            contentSha256: sha256OfBytes(bytes),
            bytes,
          });
          byPath.set(file.path, captured);
        }
        occurrences.push(
          Object.freeze({
            sourceId: captured.sourceId,
            embedSource: reference.source,
            embedSourceStartOffset: reference.sourceStartOffset,
          }),
        );
      }
      const images = Object.freeze([...byPath.values()]);
      const snapshot = canonicalizeJcs({
        schemaVersion: 1,
        noteVaultRelativePath,
        images: images.map((image) => ({
          sourceId: image.sourceId,
          vaultRelativePath: image.vaultRelativePath,
          byteLength: image.byteLength,
          contentSha256: image.contentSha256,
        })),
        occurrences,
      }) as CanonicalDependencySnapshot;
      return mdxRelayOk({
        snapshot,
        snapshotSha256: sha256OfUtf8(snapshot),
        images,
        occurrences: Object.freeze(occurrences),
      });
    } catch {
      return captureBlocker(createIssue(ISSUE_CODES.sourceCaptureFailed));
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
