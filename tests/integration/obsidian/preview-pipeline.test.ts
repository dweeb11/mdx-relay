import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { App, TFile } from "obsidian";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { sha256OfBytes } from "../../../src/canonical/hash";
import type { GenerationToken } from "../../../src/contracts/export-plan";
import { ISSUE_CODES } from "../../../src/contracts/issues";
import type { WorkerRequest } from "../../../src/contracts/worker-protocol";
import { readImageHeader } from "../../../src/images/image-metadata";
import {
  createPortableWebpCodec,
  type PortableCodecWasm,
} from "../../../src/images/portable-webp-codec";
import { transformMarkdown } from "../../../src/markdown/transform";
import { ObsidianHostAdapter } from "../../../src/obsidian/host-adapter";
import { createLivePreviewCommandDeps } from "../../../src/obsidian/preview-pipeline";
import {
  LiveSettings,
  type MdxRelaySettings,
} from "../../../src/obsidian/settings";
import { createPlanStoreDeps } from "../../../src/planning/plan-store";
import type { ProcessPlanDeps } from "../../../src/worker/process-plan";
import type { WorkerLike } from "../../../src/worker/processing-client";
import { imageFixture, loadCodecWasm } from "../../helpers/codec-wasm";
import { InProcessWorker } from "../../helpers/export-plan";
import {
  FileSystemAdapter as RuntimeFileSystemAdapter,
  TFile as RuntimeTFile,
} from "../../helpers/obsidian-runtime-stub";

const NOW = Date.parse("2026-08-09T01:00:00.000Z");
const roots: string[] = [];
let wasm: PortableCodecWasm;

beforeAll(async () => {
  wasm = await loadCodecWasm();
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

const temporaryRoot = async (name: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), `mdx-relay-${name}-`));
  roots.push(root);
  return realpath(root);
};

interface MutableVault {
  readonly note: TFile;
  readonly image: TFile;
  readonly bytes: Map<string, Uint8Array>;
  readonly app: App;
}

const mutableVault = async (): Promise<MutableVault> => {
  const note = new RuntimeTFile("notes/public-example.md") as unknown as TFile;
  const image = new RuntimeTFile("assets/gradient.png") as unknown as TFile;
  const source = await readFile(
    new URL("../../fixtures/public-baseline/source-note.md", import.meta.url),
    "utf8",
  );
  const bytes = new Map<string, Uint8Array>([
    [
      note.path,
      new TextEncoder().encode(
        source.replace("sample-image.PNG", "gradient.png"),
      ),
    ],
    [image.path, new Uint8Array(await imageFixture("gradient.png"))],
  ]);
  const files = new Map([
    [note.path, note],
    [image.path, image],
  ]);
  const adapter = new RuntimeFileSystemAdapter("/vault");
  const app = {
    workspace: { getActiveFile: () => note },
    vault: {
      adapter,
      readBinary: async (file: TFile) => {
        const value = bytes.get(file.path);
        if (value === undefined) throw new Error("missing fixture");
        return new Uint8Array(value).buffer;
      },
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
    },
    metadataCache: {
      getFirstLinkpathDest: (sourcePath: string) =>
        sourcePath === "gradient.png" ? image : null,
    },
  } as unknown as App;
  return { note, image, bytes, app };
};

const liveSettings = async (targetRoot: string): Promise<LiveSettings> => {
  let persisted: MdxRelaySettings = {
    profileId: "dpw-mind-net-v1",
    targetRoot,
  };
  const settings = new LiveSettings({
    loadData: async () => persisted,
    saveData: async (value) => {
      persisted = value;
    },
  });
  await settings.load();
  return settings;
};

const workerDeps = (): Omit<ProcessPlanDeps, "post"> => ({
  codec: createPortableWebpCodec(wasm),
  readImageHeader,
  hash: async (bytes) => sha256OfBytes(new Uint8Array(bytes)),
  transformMarkdown,
  now: () => NOW,
});

class ControlledWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  private readonly worker = new InProcessWorker(workerDeps());
  private pending: WorkerRequest | undefined;

  postMessage(message: WorkerRequest, transfer?: Transferable[]): void {
    if (message.type === "cancel-generation") return;
    this.pending = structuredClone(
      message,
      transfer === undefined ? undefined : { transfer },
    );
  }

  release(): void {
    const pending = this.pending;
    if (pending === undefined) throw new Error("no pending worker request");
    this.worker.onmessage = (event) => this.onmessage?.(event);
    this.worker.onerror = (event) => this.onerror?.(event);
    this.worker.onmessageerror = (event) => this.onmessageerror?.(event);
    this.worker.postMessage(pending);
  }

  terminate(): void {
    this.worker.terminate();
  }
}

const pipeline = async (
  vault: MutableVault,
  settings: LiveSettings,
  storeRoot: string,
  createWorker: () => WorkerLike = () => new InProcessWorker(workerDeps()),
) =>
  createLivePreviewCommandDeps({
    host: new ObsidianHostAdapter(vault.app),
    settings,
    planStoreDeps: {
      ...createPlanStoreDeps(storeRoot),
      now: () => new Date(NOW).toISOString(),
    },
    createWorker,
    caseSensitivity: "sensitive",
    now: () => NOW,
  });

const capture = async (
  deps: ReturnType<typeof createLivePreviewCommandDeps>,
  token: string,
) => {
  const result = await deps.host.captureActiveMarkdown(
    token as GenerationToken,
  );
  if (!result.ok) throw new Error(result.error[0].code);
  return result.value;
};

describe("configured preview pipeline", () => {
  it("exposes the command only for the current valid binding", async () => {
    const vault = await mutableVault();
    const targetRoot = await temporaryRoot("visibility-target");
    const storeRoot = await temporaryRoot("visibility-store");
    const settings = await liveSettings("");
    const deps = await pipeline(vault, settings, storeRoot);

    expect(deps.isConfigured()).toBe(false);
    await settings.update({
      profileId: "dpw-mind-net-v1",
      targetRoot,
    });
    expect(deps.isConfigured()).toBe(true);
  });

  it("reads the current target folder for each preview", async () => {
    const vault = await mutableVault();
    const firstRoot = await temporaryRoot("live-one");
    const secondRoot = await temporaryRoot("live-two");
    const storeRoot = await temporaryRoot("live-store");
    const settings = await liveSettings(firstRoot);
    const deps = await pipeline(vault, settings, storeRoot);

    const first = await deps.buildPreview(
      await capture(deps, "generation-one"),
      () => undefined,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(
      first.value.envelope.plan.targetFolderSnapshot.targetRootRealPath,
    ).toBe(firstRoot);

    await settings.update({
      profileId: "dpw-mind-net-v1",
      targetRoot: secondRoot,
    });
    const second = await deps.buildPreview(
      await capture(deps, "generation-two"),
      () => undefined,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(
      second.value.envelope.plan.targetFolderSnapshot.targetRootRealPath,
    ).toBe(secondRoot);
  }, 15_000);

  it("fails approval closed when settings change after preview", async () => {
    const vault = await mutableVault();
    const sealedRoot = await temporaryRoot("sealed-target");
    const changedRoot = await temporaryRoot("changed-target");
    const storeRoot = await temporaryRoot("approval-store");
    const settings = await liveSettings(sealedRoot);
    const deps = await pipeline(vault, settings, storeRoot);
    const built = await deps.buildPreview(
      await capture(deps, "generation-approval"),
      () => undefined,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const { envelope } = built.value;
    expect(envelope.sourceBytesVerified).toBe(true);
    if (envelope.state === "ready" && !envelope.sourceBytesVerified)
      throw new Error("expected source-bound ready plan");

    await settings.update({
      profileId: "dpw-mind-net-v1",
      targetRoot: changedRoot,
    });
    const recaptured = await deps.recaptureApproval(envelope.plan);
    expect(recaptured.ok).toBe(true);
    if (!recaptured.ok) return;
    expect(
      recaptured.value.fingerprint.targetFolderSnapshot.targetRootRealPath,
    ).toBe(changedRoot);
    expect(
      await deps.recordApproval(envelope.planId, recaptured.value.sourceBytes),
    ).toMatchObject({ ok: true });
    const result = await deps.applyApprovedWrites({
      plan: envelope.plan,
      blobBytes: envelope.blobBytes,
      configuredTargetRoot:
        envelope.plan.targetFolderSnapshot.targetRootRealPath,
      approval: { planId: envelope.planId },
      approvalTransition: {
        generationToken: envelope.plan.generationToken,
        planId: envelope.planId,
      },
      currentApprovalFingerprint: recaptured.value.fingerprint,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0].code).toBe(ISSUE_CODES.approvalMismatch);
    expect(await readdir(sealedRoot)).toEqual([]);
    expect(await readdir(changedRoot)).toEqual([]);
  }, 15_000);

  it("rereads the real adapter after worker processing", async () => {
    const vault = await mutableVault();
    const targetRoot = await temporaryRoot("reread-target");
    const storeRoot = await temporaryRoot("reread-store");
    const settings = await liveSettings(targetRoot);
    let controlled: ControlledWorker | undefined;
    let markWorkerCreated: () => void = () => undefined;
    const workerCreated = new Promise<void>((resolve) => {
      markWorkerCreated = resolve;
    });
    const deps = await pipeline(vault, settings, storeRoot, () => {
      controlled = new ControlledWorker();
      markWorkerCreated();
      return controlled;
    });
    const initial = await capture(deps, "generation-reread");
    const building = deps.buildPreview(initial, () => undefined);
    await workerCreated;
    const prior = vault.bytes.get(vault.note.path)!;
    vault.bytes.set(
      vault.note.path,
      new TextEncoder().encode(
        `${new TextDecoder().decode(prior)}\nchanged while worker ran`,
      ),
    );
    controlled!.release();
    const result = await building;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0].code).toBe(ISSUE_CODES.staleDuringPlanning);
  }, 15_000);

  it("names a missing target folder instead of reporting staleness", async () => {
    const vault = await mutableVault();
    const missingRoot = join(
      await temporaryRoot("missing-parent"),
      "does-not-exist",
    );
    const storeRoot = await temporaryRoot("missing-store");
    const settings = await liveSettings(missingRoot);
    const deps = await pipeline(vault, settings, storeRoot);
    const result = await deps.buildPreview(
      await capture(deps, "generation-missing-root"),
      () => undefined,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0].code).toBe(ISSUE_CODES.targetRootMissing);
    expect(result.error[0].displayDetails.detail).toBe(missingRoot);
  }, 15_000);

  it("names a non-directory target folder instead of reporting staleness", async () => {
    const vault = await mutableVault();
    const parent = await temporaryRoot("file-root-parent");
    const fileRoot = join(parent, "not-a-directory");
    await writeFile(fileRoot, "file");
    const storeRoot = await temporaryRoot("file-root-store");
    const settings = await liveSettings(fileRoot);
    const deps = await pipeline(vault, settings, storeRoot);
    const result = await deps.buildPreview(
      await capture(deps, "generation-file-root"),
      () => undefined,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0].code).toBe(ISSUE_CODES.targetRootNotDirectory);
    expect(result.error[0].displayDetails.detail).toBe(fileRoot);
  }, 15_000);

  it("names a file-ancestor target root as not-directory instead of inaccessible", async () => {
    const vault = await mutableVault();
    const parent = await temporaryRoot("file-ancestor-parent");
    const fileAncestor = join(parent, "somefile");
    await writeFile(fileAncestor, "file");
    const fileAncestorRoot = join(fileAncestor, "child");
    const storeRoot = await temporaryRoot("file-ancestor-store");
    const settings = await liveSettings(fileAncestorRoot);
    const deps = await pipeline(vault, settings, storeRoot);
    const result = await deps.buildPreview(
      await capture(deps, "generation-file-ancestor-root"),
      () => undefined,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0].code).toBe(ISSUE_CODES.targetRootNotDirectory);
    expect(result.error[0].displayDetails.detail).toBe(fileAncestorRoot);
  }, 15_000);

  it("names a symlink target folder instead of reporting staleness", async () => {
    const vault = await mutableVault();
    const realRoot = await temporaryRoot("symlink-real");
    const parent = await temporaryRoot("symlink-parent");
    const linkedRoot = join(parent, "linked-root");
    await symlink(realRoot, linkedRoot);
    const storeRoot = await temporaryRoot("symlink-store");
    const settings = await liveSettings(linkedRoot);
    const deps = await pipeline(vault, settings, storeRoot);
    const result = await deps.buildPreview(
      await capture(deps, "generation-symlink-root"),
      () => undefined,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0].code).toBe(ISSUE_CODES.targetRootSymlink);
    expect(result.error[0].displayDetails.detail).toBe(linkedRoot);
  }, 15_000);

  it("names an unresolvable image embed instead of reporting staleness", async () => {
    const vault = await mutableVault();
    const targetRoot = await temporaryRoot("image-target");
    const storeRoot = await temporaryRoot("image-store");
    const settings = await liveSettings(targetRoot);
    const prior = vault.bytes.get(vault.note.path)!;
    vault.bytes.set(
      vault.note.path,
      new TextEncoder().encode(
        new TextDecoder()
          .decode(prior)
          .replace("gradient.png", "missing-image.png"),
      ),
    );
    const deps = await pipeline(vault, settings, storeRoot);
    const result = await deps.buildPreview(
      await capture(deps, "generation-missing-image"),
      () => undefined,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0].code).toBe(ISSUE_CODES.unresolvableImage);
    expect(result.error[0].displayDetails.detail).toBe("missing-image.png");
  }, 15_000);
});
