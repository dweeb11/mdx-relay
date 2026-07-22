import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  CanonicalDependencySnapshot,
  GenerationToken,
  Sha256Digest,
  ValidatedPortableProfileSnapshot,
} from "../../../src/contracts/export-plan";
import {
  createIssue,
  ISSUE_CODES,
  toSafePathLabel,
  type SafePathLabel,
} from "../../../src/contracts/issues";
import type {
  WorkerImageInput,
  WorkerProcessRequest,
  WorkerRequest,
  WorkerWireEvent,
} from "../../../src/contracts/worker-protocol";
import {
  ProcessingClient,
  type WorkerLike,
} from "../../../src/worker/processing-client";

const token = "generation-1" as GenerationToken;
const otherToken = "generation-stale" as GenerationToken;
const digest = (value: string): Sha256Digest =>
  `sha256:${value}` as Sha256Digest;
const label = (value: string): SafePathLabel =>
  toSafePathLabel(value) as SafePathLabel;

const sha = (bytes: ArrayBuffer): Sha256Digest =>
  `sha256:${createHash("sha256").update(new Uint8Array(bytes)).digest("hex")}` as Sha256Digest;

class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly posted: {
    message: WorkerRequest;
    transfer: Transferable[] | undefined;
  }[] = [];
  terminated = false;

  postMessage(message: WorkerRequest, transfer?: Transferable[]): void {
    this.posted.push({ message, transfer });
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(event: WorkerWireEvent): void {
    this.onmessage?.({ data: event } as MessageEvent);
  }
  emitError(): void {
    this.onerror?.({});
  }
}

class Scheduler {
  private seq = 1;
  private readonly timers = new Map<
    number,
    { cb: () => void; delay: number }
  >();
  set = (cb: () => void, delay: number): number => {
    const id = this.seq++;
    this.timers.set(id, { cb, delay });
    return id;
  };
  clear = (id: number): void => {
    this.timers.delete(id);
  };
  get size(): number {
    return this.timers.size;
  }
  fireSoonest(): void {
    let soonest: [number, { cb: () => void; delay: number }] | undefined;
    for (const entry of this.timers) {
      if (!soonest || entry[1].delay < soonest[1].delay) soonest = entry;
    }
    if (!soonest) throw new Error("no timer scheduled");
    this.timers.delete(soonest[0]);
    soonest[1].cb();
  }
}

const image = (sourceId: string): WorkerImageInput => ({
  sourceId,
  safePathLabel: label(`assets/${sourceId}.png`),
  contentSha256: digest(sourceId),
  byteLength: 4,
  bytes: Uint8Array.of(1, 2, 3, 4).buffer,
});

const request = (): WorkerProcessRequest => ({
  type: "process-plan",
  generationToken: token,
  planStartedAtMs: 1_000,
  planDeadlineMs: 601_000,
  imageTimeoutMs: 60_000,
  sourceNote: {
    vaultRelativePath: "notes/example.md",
    safePathLabel: label("notes/example.md"),
    byteLength: 5,
    contentSha256: digest("note"),
    bytes: new TextEncoder().encode("# hi\n").buffer,
  },
  profileSnapshot: "{}" as ValidatedPortableProfileSnapshot,
  profileSnapshotSha256: digest("profile"),
  dependencySnapshot: "{}" as CanonicalDependencySnapshot,
  dependencySnapshotSha256: digest("deps"),
  images: [image("a")],
});

const setup = () => {
  const worker = new FakeWorker();
  const scheduler = new Scheduler();
  const client = new ProcessingClient({
    createWorker: () => worker,
    hash: async (bytes) => sha(bytes),
    now: () => 1_000,
    setTimer: scheduler.set,
    clearTimer: scheduler.clear,
  });
  return { worker, scheduler, client };
};

const startedEvent = (generationToken: GenerationToken): WorkerWireEvent => ({
  type: "started",
  generationToken,
  imageCount: 1,
});

const progressEvent = (generationToken: GenerationToken): WorkerWireEvent => ({
  type: "progress",
  generationToken,
  sourceId: "a",
  imageIndex: 0,
  completedImages: 0,
  totalImages: 1,
  elapsedMs: 10,
  remainingPlanBudgetMs: 599_000,
});

const okCompletion = () => {
  const mdxBytes = new TextEncoder().encode("# hi\n").buffer;
  const imageBytes = Uint8Array.of(7, 8, 9).buffer;
  return {
    generatedMdx: {
      contentSha256: sha(mdxBytes),
      byteLength: mdxBytes.byteLength,
      bytes: mdxBytes,
    },
    transformedImages: [
      {
        sourceId: "a",
        decodedMime: "image/webp",
        width: 2,
        height: 2,
        contentSha256: sha(imageBytes),
        byteLength: imageBytes.byteLength,
        bytes: imageBytes,
      },
    ],
    warnings: [createIssue(ISSUE_CODES.summaryMissing)],
  };
};

const completedEvent = (
  result: unknown,
  generationToken = token,
): WorkerWireEvent =>
  ({ type: "completed", generationToken, result }) as WorkerWireEvent;

describe("ProcessingClient", () => {
  it("posts the request transferring the note and image buffers", () => {
    const { worker, client } = setup();
    const req = request();
    void client.process(req);
    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0]!.message).toBe(req);
    expect(worker.posted[0]!.transfer).toEqual([
      req.sourceNote.bytes,
      req.images[0]!.bytes,
    ]);
  });

  it("delivers progress and resolves a verified completion", async () => {
    const { worker, client } = setup();
    const progress: WorkerWireEvent[] = [];
    const done = client.process(request(), (event) => progress.push(event));
    worker.emit(startedEvent(token));
    worker.emit(progressEvent(token));
    worker.emit(completedEvent({ ok: true, value: okCompletion() }));
    const terminal = await done;
    expect(progress.map((event) => event.type)).toEqual([
      "started",
      "progress",
    ]);
    expect(terminal.type).toBe("completed");
    if (terminal.type !== "completed") return;
    expect(terminal.result.ok).toBe(true);
  });

  it("ignores events whose generation token does not match", async () => {
    const { worker, client } = setup();
    const seen: string[] = [];
    const done = client.process(request(), (event) => seen.push(event.type));
    worker.emit(startedEvent(otherToken));
    worker.emit(progressEvent(otherToken));
    worker.emit(
      completedEvent({ ok: true, value: okCompletion() }, otherToken),
    );
    worker.emit(completedEvent({ ok: true, value: okCompletion() }));
    const terminal = await done;
    expect(seen).toEqual([]);
    expect(terminal.type).toBe("completed");
  });

  it("discards late events after the run has settled", async () => {
    const { worker, client } = setup();
    const done = client.process(request());
    worker.emit(completedEvent({ ok: true, value: okCompletion() }));
    await done;
    expect(worker.onmessage).toBeNull();
    // A late event must not throw even though handlers are detached.
    expect(() => worker.emit(progressEvent(token))).not.toThrow();
  });

  it("cancels the active run, posting cancel-generation and terminating", async () => {
    const { worker, client } = setup();
    const done = client.process(request());
    worker.emit(startedEvent(token));
    client.cancel();
    const terminal = await done;
    expect(terminal.type).toBe("cancelled");
    expect(worker.terminated).toBe(true);
    expect(worker.posted.at(-1)!.message).toEqual({
      type: "cancel-generation",
      generationToken: token,
    });
  });

  it("terminates and blocks when the plan budget elapses", async () => {
    const { worker, scheduler, client } = setup();
    const done = client.process(request());
    scheduler.fireSoonest();
    const terminal = await done;
    expect(worker.terminated).toBe(true);
    expect(terminal.type).toBe("blocked");
    if (terminal.type !== "blocked") return;
    expect(terminal.issues[0].code).toBe(ISSUE_CODES.planBudgetExhausted);
  });

  it("terminates and blocks when an image exceeds its timeout", async () => {
    const { worker, scheduler, client } = setup();
    const done = client.process(request());
    worker.emit(progressEvent(token)); // arms the per-image timer for source "a"
    scheduler.fireSoonest(); // image timeout (60s) fires before the plan (600s)
    const terminal = await done;
    expect(worker.terminated).toBe(true);
    expect(terminal.type).toBe("blocked");
    if (terminal.type !== "blocked") return;
    expect(terminal.issues[0].code).toBe(ISSUE_CODES.workerImageTimeout);
    expect(terminal.activeSourceId).toBe("a");
  });

  it("synthesizes WORKER_CRASHED on a worker error", async () => {
    const { worker, client } = setup();
    const done = client.process(request());
    worker.emitError();
    const terminal = await done;
    expect(worker.terminated).toBe(true);
    expect(terminal.type).toBe("blocked");
    if (terminal.type !== "blocked") return;
    expect(terminal.issues[0].code).toBe(ISSUE_CODES.workerCrashed);
  });

  it("rejects a completion whose declared hash does not verify", async () => {
    const { client, worker } = setup();
    const done = client.process(request());
    const completion = okCompletion();
    completion.generatedMdx.contentSha256 = digest("tampered");
    worker.emit(completedEvent({ ok: true, value: completion }));
    const terminal = await done;
    expect(terminal.type).toBe("blocked");
    if (terminal.type !== "blocked") return;
    expect(terminal.issues[0].code).toBe(ISSUE_CODES.malformedWorkerResponse);
  });

  it("rejects a completion whose byte length disagrees with its buffer", async () => {
    const { client, worker } = setup();
    const done = client.process(request());
    const completion = okCompletion();
    completion.generatedMdx.byteLength += 1;
    worker.emit(completedEvent({ ok: true, value: completion }));
    const terminal = await done;
    expect(terminal.type).toBe("blocked");
    if (terminal.type !== "blocked") return;
    expect(terminal.issues[0].code).toBe(ISSUE_CODES.malformedWorkerResponse);
  });

  it("preserves a worker blocker-first error completion", async () => {
    const { client, worker } = setup();
    const done = client.process(request());
    worker.emit(
      completedEvent({
        ok: false,
        error: [createIssue(ISSUE_CODES.imageDecodeFailed)],
      }),
    );
    const terminal = await done;
    expect(terminal.type).toBe("completed");
    if (terminal.type !== "completed") return;
    expect(terminal.result.ok).toBe(false);
    if (terminal.result.ok) return;
    expect(terminal.result.error[0].code).toBe(ISSUE_CODES.imageDecodeFailed);
  });

  it("rejects a completion warning channel that carries a blocker", async () => {
    const { client, worker } = setup();
    const done = client.process(request());
    const completion = okCompletion();
    (completion.warnings as unknown[]) = [createIssue(ISSUE_CODES.invalidMdx)];
    worker.emit(completedEvent({ ok: true, value: completion }));
    const terminal = await done;
    expect(terminal.type).toBe("blocked");
    if (terminal.type !== "blocked") return;
    expect(terminal.issues[0].code).toBe(ISSUE_CODES.malformedWorkerResponse);
  });
});
