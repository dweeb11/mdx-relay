import { sha256OfBytes, sha256OfUtf8 } from "../../src/canonical/hash";
import type {
  CanonicalDependencySnapshot,
  ExportPlan,
  GenerationToken,
  TargetSnapshotEntry,
  ValidatedPortableProfileSnapshot,
} from "../../src/contracts/export-plan";
import { mdxRelayOk, type MdxRelayResult } from "../../src/contracts/result";
import type { PlanSourceBytes } from "../../src/planning/build-export-plan";
import type {
  ActiveMarkdownCapture,
  ObsidianHost,
  PreviewModalHandle,
} from "../../src/obsidian/host-adapter";
import type { BuiltPreview } from "../../src/obsidian/preview-command";
import { buildExportPlan } from "../../src/planning/build-export-plan";
import { sealExportPlan } from "../../src/planning/seal-export-plan";
import { DPW_MIND_NET_V1 } from "../../src/profiles/builtins/dpw-mind-net-v1";

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
export const FAKE_NOTE_BYTES = utf8("# Example\n\nBody\n");
export const FAKE_IMAGE_BYTES = utf8("image-source");
const MDX_BYTES = utf8("---\ntitle: Example\n---\n\nBody\n");
const OUTPUT_IMAGE_BYTES = utf8("webp-output");

export const fakeCapture = (
  generationToken: GenerationToken,
): ActiveMarkdownCapture => ({
  generationToken,
  bytes: FAKE_NOTE_BYTES,
  note: {
    vaultRelativePath: "notes/example.md",
    realPath: "/vault/notes/example.md",
    byteLength: FAKE_NOTE_BYTES.byteLength,
    contentSha256: sha256OfBytes(FAKE_NOTE_BYTES),
  },
});

export const buildFakePreview = (
  generationToken: GenerationToken,
  state: "ready" | "no-changes" = "ready",
  repeatImage = false,
): BuiltPreview => {
  const profileSnapshot = JSON.stringify(DPW_MIND_NET_V1);
  const dependencySnapshot = '{"images":["assets/example.png"]}';
  const paths = [
    "content/posts/example.mdx",
    "public/posts/example/img-1.webp",
    ...(repeatImage ? ["public/posts/example/img-2.webp"] : []),
  ];
  const outputs = [
    MDX_BYTES,
    OUTPUT_IMAGE_BYTES,
    ...(repeatImage ? [OUTPUT_IMAGE_BYTES] : []),
  ];
  const targets: readonly TargetSnapshotEntry[] = paths.map(
    (relativePath, index) => ({
      relativePath,
      priorState:
        state === "no-changes"
          ? {
              state: "regularFile" as const,
              contentSha256: sha256OfBytes(outputs[index]!),
            }
          : { state: "absent" as const },
    }),
  );
  const sourceBytes = {
    note: FAKE_NOTE_BYTES,
    images: new Map([["image-1", FAKE_IMAGE_BYTES]]),
  };
  const built = buildExportPlan({
    generationToken,
    profile: DPW_MIND_NET_V1,
    profileSnapshot: profileSnapshot as ValidatedPortableProfileSnapshot,
    profileSnapshotSha256: sha256OfUtf8(profileSnapshot),
    dependencySnapshot: dependencySnapshot as CanonicalDependencySnapshot,
    dependencySnapshotSha256: sha256OfUtf8(dependencySnapshot),
    sourceNote: fakeCapture(generationToken).note,
    sourceImages: [
      {
        sourceId: "image-1",
        vaultRelativePath: "assets/example.png",
        realPath: "/vault/assets/example.png",
        decodedMime: "image/png",
        byteLength: FAKE_IMAGE_BYTES.byteLength,
        contentSha256: sha256OfBytes(FAKE_IMAGE_BYTES),
      },
    ],
    sourceBytes,
    documentSlug: "example",
    generatedMdxBytes: MDX_BYTES,
    transformedImages: [{ sourceId: "image-1", bytes: OUTPUT_IMAGE_BYTES }],
    imageEmbeds: [
      { sourceId: "image-1", assetFileName: "img-1.webp" },
      ...(repeatImage
        ? [{ sourceId: "image-1", assetFileName: "img-2.webp" }]
        : []),
    ],
    targetRootRealPath: "/target/site",
    caseSensitivity: "sensitive",
    priorTargets: targets,
    warnings: [],
    finalCapture: {
      profileSnapshotSha256: sha256OfUtf8(profileSnapshot),
      dependencySnapshotSha256: sha256OfUtf8(dependencySnapshot),
      sourceNote: fakeCapture(generationToken).note,
      sourceImages: [
        {
          sourceId: "image-1",
          byteLength: FAKE_IMAGE_BYTES.byteLength,
          contentSha256: sha256OfBytes(FAKE_IMAGE_BYTES),
        },
      ],
      targetRootRealPath: "/target/site",
      caseSensitivity: "sensitive",
      targets,
    },
    createdAtUtc: "2026-08-08T00:00:00.000Z",
    expiresAtUtc: "2026-08-09T00:00:00.000Z",
  });
  if (!built.ok) throw new Error(built.error[0].code);
  const sealed = sealExportPlan(built.value);
  if (!sealed.ok) throw new Error(sealed.error[0].code);
  return { envelope: sealed.value, generatedMdxBytes: MDX_BYTES };
};

export class FakeObsidianHost implements ObsidianHost {
  readonly captures: GenerationToken[] = [];
  readonly sourceRecaptures: ExportPlan[] = [];
  readonly modalElements: HTMLElement[] = [];
  private captureResults: MdxRelayResult<ActiveMarkdownCapture>[] = [];
  private sourceResult: MdxRelayResult<PlanSourceBytes> = mdxRelayOk({
    note: new Uint8Array(),
    images: new Map(),
  });

  queueCapture(result: MdxRelayResult<ActiveMarkdownCapture>): void {
    this.captureResults.push(result);
  }

  setSourceResult(result: MdxRelayResult<PlanSourceBytes>): void {
    this.sourceResult = result;
  }

  async captureActiveMarkdown(
    generationToken: GenerationToken,
  ): Promise<MdxRelayResult<ActiveMarkdownCapture>> {
    this.captures.push(generationToken);
    const result = this.captureResults.shift();
    if (result === undefined) throw new Error("No fake capture queued.");
    return result;
  }

  async recapturePlanSources(
    plan: ExportPlan,
  ): Promise<MdxRelayResult<PlanSourceBytes>> {
    this.sourceRecaptures.push(plan);
    return this.sourceResult;
  }

  openModal(
    mount: (element: HTMLElement, close: () => void) => void,
    onClose: () => void,
  ): PreviewModalHandle {
    const element = document.createElement("div");
    document.body.append(element);
    this.modalElements.push(element);
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      element.remove();
      onClose();
    };
    mount(element, close);
    return { element, close };
  }

  latestModal(): HTMLElement {
    const modal = this.modalElements.at(-1);
    if (modal === undefined) throw new Error("No modal opened.");
    return modal;
  }
}
