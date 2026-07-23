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
  onmessageerror: ((event: unknown) => void) | null = null;
  readonly posted: {
    message: WorkerRequest;
    transfer: Transferable[] | undefined;
  }[] = [];
  terminateCount = 0;

  get terminated(): boolean {
    return this.terminateCount > 0;
  }

  postMessage(message: WorkerRequest, transfer?: Transferable[]): void {
    // Run the genuine structured-clone algorithm so duplicate and detached
    // transferables fail exactly as a real Worker.postMessage would.
    structuredClone(message, transfer ? { transfer } : undefined);
    this.posted.push({ message, transfer });
  }
  terminate(): void {
    this.terminateCount += 1;
  }
  /** Wire data is untrusted, so probes may emit anything a worker could post. */
  emit(event: unknown): void {
    this.onmessage?.({ data: event } as MessageEvent);
  }
  emitError(): void {
    this.onerror?.({});
  }
  emitMessageError(): void {
    this.onmessageerror?.({});
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
  private soonest(): [number, { cb: () => void; delay: number }] {
    let soonest: [number, { cb: () => void; delay: number }] | undefined;
    for (const entry of this.timers) {
      if (!soonest || entry[1].delay < soonest[1].delay) soonest = entry;
    }
    if (!soonest) throw new Error("no timer scheduled");
    return soonest;
  }
  fireSoonest(): void {
    const [id, timer] = this.soonest();
    this.timers.delete(id);
    timer.cb();
  }
  /** The callback without dequeuing it, for already-dispatched timer races. */
  peekSoonest(): () => void {
    return this.soonest()[1].cb;
  }
}

const image = (sourceId: string): WorkerImageInput => ({
  sourceId,
  safePathLabel: label(`assets/${sourceId}.png`),
  contentSha256: digest(sourceId),
  byteLength: 4,
  bytes: Uint8Array.of(1, 2, 3, 4).buffer,
});

const request = (
  overrides: Partial<WorkerProcessRequest> = {},
): WorkerProcessRequest => ({
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
  ...overrides,
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

/**
 * A per-run worker owns an embedded WASM bundle, so every terminal path must
 * release it. Regression cover for the reviewed head, which terminated only on
 * cancel/crash/timeout and leaked the worker on ordinary success.
 */
describe("ProcessingClient terminal cleanup", () => {
  const drive = async (
    name: string,
  ): Promise<ReturnType<typeof setup> & { type: string }> => {
    const harness = setup();
    const { worker, scheduler, client } = harness;
    const done = client.process(request());
    if (name === "completed") {
      worker.emit(completedEvent({ ok: true, value: okCompletion() }));
    } else if (name === "worker-blocked") {
      worker.emit({
        type: "blocked",
        generationToken: token,
        issues: [createIssue(ISSUE_CODES.imageDecodeFailed)],
      });
    } else if (name === "worker-cancelled") {
      worker.emit({ type: "cancelled", generationToken: token });
    } else if (name === "malformed") {
      worker.emit(completedEvent({ ok: true, value: { nonsense: true } }));
    } else if (name === "crash") {
      worker.emitError();
    } else if (name === "cancel") {
      client.cancel();
    } else if (name === "plan-timeout") {
      scheduler.fireSoonest();
    } else if (name === "image-timeout") {
      worker.emit(progressEvent(token));
      scheduler.fireSoonest();
    } else if (name === "messageerror") {
      worker.emitMessageError();
    }
    const terminal = await done;
    return { ...harness, type: terminal.type };
  };

  const terminalPaths = [
    "completed",
    "worker-blocked",
    "worker-cancelled",
    "malformed",
    "crash",
    "cancel",
    "plan-timeout",
    "image-timeout",
    "messageerror",
  ] as const;

  it.each(terminalPaths)(
    "clears timers and handlers and terminates exactly once: %s",
    async (name) => {
      const { worker, scheduler } = await drive(name);
      expect(worker.terminateCount, "terminate calls").toBe(1);
      expect(scheduler.size, "live timers").toBe(0);
      expect(worker.onmessage).toBeNull();
      expect(worker.onerror).toBeNull();
      expect(worker.onmessageerror).toBeNull();
    },
  );

  it("does not double-settle or double-terminate when cancel races a completion", async () => {
    const { worker, client, scheduler } = setup();
    const done = client.process(request());
    // The completion decode is async; cancel lands while it is still pending.
    worker.emit(completedEvent({ ok: true, value: okCompletion() }));
    client.cancel();
    const terminal = await done;
    expect(terminal.type).toBe("cancelled");
    expect(worker.terminateCount).toBe(1);
    expect(scheduler.size).toBe(0);
  });

  it("ignores a crash and a cancel that arrive after the run settled", async () => {
    const { worker, client } = setup();
    const done = client.process(request());
    worker.emit(completedEvent({ ok: true, value: okCompletion() }));
    await done;
    expect(worker.terminateCount).toBe(1);
    worker.emitError();
    client.cancel();
    worker.emitMessageError();
    expect(worker.terminateCount).toBe(1);
  });

  it("terminates once when a stale timer callback fires after settling", async () => {
    const { worker, client, scheduler } = setup();
    const done = client.process(request());
    const planTimer = scheduler.peekSoonest();
    worker.emit(completedEvent({ ok: true, value: okCompletion() }));
    await done;
    expect(worker.terminateCount).toBe(1);
    // Simulate a timer that had already been dispatched before clearTimer ran.
    planTimer();
    expect(worker.terminateCount).toBe(1);
  });
});

const detached = (): ArrayBuffer => {
  const buffer = Uint8Array.of(1, 2, 3, 4).buffer;
  structuredClone(buffer, { transfer: [buffer] });
  return buffer;
};

/**
 * `process()` documents that it never rejects. Building the transfer list
 * straight from the request produced duplicate entries whenever inputs aliased
 * one ArrayBuffer, and structured clone rejects a duplicated transferable with
 * DataCloneError -- surfacing as a rejected promise instead of a terminal event.
 */
describe("ProcessingClient transfer list", () => {
  const aliasedRequest = (
    build: (
      base: WorkerProcessRequest,
      shared: ArrayBuffer,
    ) => WorkerProcessRequest,
  ): WorkerProcessRequest => {
    const base = request();
    return build(base, Uint8Array.of(1, 2, 3, 4).buffer);
  };

  it("deduplicates a buffer shared by the source note and an image", async () => {
    const { worker, client } = setup();
    const req = aliasedRequest((base, shared) => ({
      ...base,
      sourceNote: { ...base.sourceNote, bytes: shared },
      images: [{ ...base.images[0]!, bytes: shared }],
    }));
    const done = client.process(req);
    expect(worker.posted).toHaveLength(1);
    const transfer = worker.posted[0]!.transfer!;
    expect(transfer).toHaveLength(1);
    expect(new Set(transfer).size).toBe(transfer.length);
    worker.emit(completedEvent({ ok: true, value: okCompletion() }));
    expect((await done).type).toBe("completed");
  });

  it("deduplicates a buffer shared by two images", async () => {
    const { worker, client } = setup();
    const req = aliasedRequest((base, shared) => ({
      ...base,
      images: [
        { ...base.images[0]!, sourceId: "a", bytes: shared },
        { ...base.images[0]!, sourceId: "b", bytes: shared },
      ],
    }));
    void client.process(req);
    const transfer = worker.posted[0]!.transfer!;
    // The note buffer plus the single shared image buffer.
    expect(transfer).toHaveLength(2);
    expect(new Set(transfer).size).toBe(transfer.length);
  });

  it("keeps distinct buffers in the transfer list", () => {
    const { worker, client } = setup();
    const req = request();
    void client.process(req);
    expect(worker.posted[0]!.transfer).toEqual([
      req.sourceNote.bytes,
      req.images[0]!.bytes,
    ]);
  });

  it("returns one redacted terminal blocker when postMessage fails", async () => {
    const { worker, client, scheduler } = setup();
    const base = request();
    const req: WorkerProcessRequest = {
      ...base,
      images: [{ ...base.images[0]!, bytes: detached() }],
    };
    const terminal = await client.process(req);
    expect(terminal.type).toBe("blocked");
    if (terminal.type !== "blocked") return;
    expect(terminal.issues).toHaveLength(1);
    expect(terminal.issues[0].code).toBe(ISSUE_CODES.workerCrashed);
    expect(terminal.issues[0].displayDetails).toEqual({
      summary: terminal.issues[0].displayDetails.summary,
    });
    // Fail-closed cleanup: nothing queued, no timers, worker released once.
    expect(worker.posted).toHaveLength(0);
    expect(worker.terminateCount).toBe(1);
    expect(scheduler.size).toBe(0);
    expect(worker.onmessage).toBeNull();
  });

  it("never rejects even when the source note buffer is already detached", async () => {
    const { client } = setup();
    const base = request();
    const req: WorkerProcessRequest = {
      ...base,
      sourceNote: { ...base.sourceNote, bytes: detached() },
    };
    const promise = client.process(req);
    await expect(promise).resolves.toMatchObject({ type: "blocked" });
  });
});

/**
 * The 60s budget is per *image*, bounded by the 10-minute plan budget. The
 * worker emits `started` before the Markdown transform and emits each image's
 * `progress` immediately before that image's decode/encode (locked by
 * process-plan's interleaving tests), so `progress` is the only wire signal
 * that marks image-work start. Arming on `started` charged Markdown time -- and
 * on an image-free note, no image work at all -- to the per-image budget.
 */
describe("ProcessingClient per-image budget", () => {
  it("does not arm the per-image timer on started", () => {
    const { worker, scheduler, client } = setup();
    void client.process(request());
    expect(scheduler.size).toBe(1); // the plan budget timer only
    worker.emit(startedEvent(token));
    expect(scheduler.size).toBe(1);
  });

  it("arms the per-image timer only once image work begins", () => {
    const { worker, scheduler, client } = setup();
    void client.process(request());
    worker.emit(startedEvent(token));
    worker.emit(progressEvent(token));
    expect(scheduler.size).toBe(2); // plan budget + this image
  });

  it("never charges an image-free note to the per-image budget", async () => {
    const { worker, scheduler, client } = setup();
    const done = client.process(request({ images: [] }));
    worker.emit({ type: "started", generationToken: token, imageCount: 0 });
    expect(scheduler.size).toBe(1);
    scheduler.fireSoonest();
    const terminal = await done;
    expect(terminal.type).toBe("blocked");
    if (terminal.type !== "blocked") return;
    // The plan budget is the only clock that can expire before any image work.
    expect(terminal.issues[0].code).toBe(ISSUE_CODES.planBudgetExhausted);
  });

  it("gives the first image a full budget after a slow markdown transform", async () => {
    const worker = new FakeWorker();
    const scheduler = new Scheduler();
    let clock = 1_000;
    const client = new ProcessingClient({
      createWorker: () => worker,
      hash: async (bytes) => sha(bytes),
      now: () => clock,
      setTimer: scheduler.set,
      clearTimer: scheduler.clear,
    });
    const done = client.process(request());
    worker.emit(startedEvent(token));
    clock += 120_000; // markdown work runs well past one image timeout
    expect(scheduler.size).toBe(1);
    worker.emit(progressEvent(token));
    // Only now is an image in flight, and it gets the whole 60s.
    expect(scheduler.size).toBe(2);
    scheduler.fireSoonest();
    const terminal = await done;
    expect(terminal.type).toBe("blocked");
    if (terminal.type !== "blocked") return;
    expect(terminal.issues[0].code).toBe(ISSUE_CODES.workerImageTimeout);
    expect(terminal.activeSourceId).toBe("a");
  });

  it("keeps the plan budget armed across markdown and image work", async () => {
    const { worker, scheduler, client } = setup();
    const done = client.process(request());
    worker.emit(startedEvent(token));
    worker.emit(progressEvent(token));
    // Drop the per-image timer, leaving the plan budget as the only clock.
    scheduler.clear(2);
    scheduler.fireSoonest();
    const terminal = await done;
    expect(terminal.type).toBe("blocked");
    if (terminal.type !== "blocked") return;
    expect(terminal.issues[0].code).toBe(ISSUE_CODES.planBudgetExhausted);
  });
});
