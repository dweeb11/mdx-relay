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
  DecodedWorkerEvent,
  WorkerImageInput,
  WorkerProcessRequest,
  WorkerRequest,
  WorkerWireEvent,
} from "../../../src/contracts/worker-protocol";
import { MDX_RELAY_LIMITS } from "../../../src/core/limits";
import {
  ProcessingClient,
  type ProcessingClientOptions,
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

const setup = (overrides: Partial<ProcessingClientOptions> = {}) => {
  const worker = new FakeWorker();
  const scheduler = new Scheduler();
  const client = new ProcessingClient({
    createWorker: () => worker,
    hash: async (bytes) => sha(bytes),
    now: () => 1_000,
    setTimer: scheduler.set,
    clearTimer: scheduler.clear,
    ...overrides,
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

/**
 * The frozen order is `started -> progress* -> terminal`, and a trusted
 * completion may only follow the whole sequence. Tests that care about the
 * *payload* drive the valid lifecycle first so the payload is what is on trial.
 */
const emitLifecycle = (
  worker: FakeWorker,
  plan: WorkerProcessRequest = request(),
): void => {
  worker.emit({
    type: "started",
    generationToken: plan.generationToken,
    imageCount: plan.images.length,
  });
  plan.images.forEach((input, imageIndex) => {
    worker.emit({
      type: "progress",
      generationToken: plan.generationToken,
      sourceId: input.sourceId,
      imageIndex,
      completedImages: imageIndex,
      totalImages: plan.images.length,
      elapsedMs: 10,
      remainingPlanBudgetMs: 599_000,
    });
  });
};

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
        decodedWidth: 4,
        decodedHeight: 4,
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
    emitLifecycle(worker);
    worker.emit(completedEvent({ ok: true, value: okCompletion() }));
    const terminal = await done;
    expect(seen).toEqual(["started", "progress"]);
    expect(terminal.type).toBe("completed");
  });

  it("discards late events after the run has settled", async () => {
    const { worker, client } = setup();
    const done = client.process(request());
    emitLifecycle(worker);
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
    worker.emit(startedEvent(token));
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
    emitLifecycle(worker);
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
    emitLifecycle(worker);
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
    worker.emit(startedEvent(token));
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
    emitLifecycle(worker);
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
      emitLifecycle(worker);
      worker.emit(completedEvent({ ok: true, value: okCompletion() }));
    } else if (name === "worker-blocked") {
      worker.emit(startedEvent(token));
      worker.emit({
        type: "blocked",
        generationToken: token,
        issues: [createIssue(ISSUE_CODES.imageDecodeFailed)],
      });
    } else if (name === "worker-cancelled") {
      worker.emit(startedEvent(token));
      worker.emit({ type: "cancelled", generationToken: token });
    } else if (name === "malformed") {
      emitLifecycle(worker);
      worker.emit(completedEvent({ ok: true, value: { nonsense: true } }));
    } else if (name === "crash") {
      worker.emitError();
    } else if (name === "cancel") {
      client.cancel();
    } else if (name === "plan-timeout") {
      scheduler.fireSoonest();
    } else if (name === "image-timeout") {
      worker.emit(startedEvent(token));
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
    emitLifecycle(worker);
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
    emitLifecycle(worker);
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
    emitLifecycle(worker);
    worker.emit(completedEvent({ ok: true, value: okCompletion() }));
    await done;
    expect(worker.terminateCount).toBe(1);
    // Simulate a timer that had already been dispatched before clearTimer ran.
    planTimer();
    expect(worker.terminateCount).toBe(1);
  });
});

/**
 * Cancellation is parent-authoritative: the posted `cancel-generation` only
 * lets a healthy worker stop early, and termination is what actually ends the
 * run. The reviewed head let that courtesy decide the outcome -- a
 * `postMessage` that threw escaped `cancel()`, leaving the promise pending, the
 * plan and per-image timers armed, and the worker and its embedded WASM bundle
 * alive.
 */
describe("ProcessingClient cancellation", () => {
  /** A worker that accepts the plan but refuses the cancellation message. */
  class RefusingWorker extends FakeWorker {
    override postMessage(
      message: WorkerRequest,
      transfer?: Transferable[],
    ): void {
      if (message.type === "cancel-generation")
        throw new Error("cancel post failed");
      super.postMessage(message, transfer);
    }
  }

  const started = () => {
    const worker = new RefusingWorker();
    const harness = setup({ createWorker: () => worker });
    const done = harness.client.process(request());
    worker.emit(startedEvent(token));
    worker.emit(progressEvent(token)); // the per-image timer is armed too
    expect(harness.scheduler.size).toBe(2);
    return { ...harness, worker, done };
  };

  it("settles cancelled even when the cancel message cannot be posted", async () => {
    const { worker, scheduler, client, done } = started();
    expect(() => client.cancel()).not.toThrow();
    const terminal = await done;
    expect(terminal.type).toBe("cancelled");
    expect(worker.terminateCount).toBe(1);
    expect(scheduler.size).toBe(0);
    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
    expect(worker.onmessageerror).toBeNull();
    // The plan request was accepted; the refused cancellation never queued.
    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0]!.message.type).toBe("process-plan");
  });

  it("stays idempotent when cancel is called again after a failed post", async () => {
    const { worker, client, done } = started();
    client.cancel();
    expect(() => client.cancel()).not.toThrow();
    expect(() => client.cancel()).not.toThrow();
    expect((await done).type).toBe("cancelled");
    expect(worker.terminateCount).toBe(1);
  });

  it("ignores a late terminal event after a failed cancel post", async () => {
    const { worker, scheduler, client, done } = started();
    client.cancel();
    const terminal = await done;
    expect(() =>
      worker.emit(completedEvent({ ok: true, value: okCompletion() })),
    ).not.toThrow();
    expect(terminal.type).toBe("cancelled");
    expect(worker.terminateCount).toBe(1);
    expect(scheduler.size).toBe(0);
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
    emitLifecycle(worker, req);
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
 * `createWorker()` runs before any handler, timer, or cancel hook exists, and
 * the reviewed head called it unguarded: a constructor that throws -- a missing
 * bundle, a blocked worker URL -- escaped `process()` synchronously, from an
 * API documented never to throw or reject. There is no worker to terminate, but
 * the boundary still owes one redacted terminal event and a client fit for the
 * next generation.
 */
describe("ProcessingClient worker construction", () => {
  const CONSTRUCTOR_MESSAGE = "worker constructor failed";
  const refuse = (): WorkerLike => {
    throw new Error(CONSTRUCTOR_MESSAGE);
  };

  it("returns one redacted terminal blocker when the constructor throws", async () => {
    const { scheduler, client } = setup({ createWorker: refuse });
    const terminal = await client.process(request());
    expect(terminal.type).toBe("blocked");
    if (terminal.type !== "blocked") return;
    expect(terminal.issues).toHaveLength(1);
    expect(terminal.issues[0].code).toBe(ISSUE_CODES.workerCrashed);
    expect(terminal.issues[0].displayDetails).toEqual({
      summary: terminal.issues[0].displayDetails.summary,
    });
    // Neither the thrown message nor its stack may reach the host.
    expect(JSON.stringify(terminal)).not.toContain(CONSTRUCTOR_MESSAGE);
    expect(JSON.stringify(terminal)).not.toContain("processing-client");
    expect(scheduler.size).toBe(0);
  });

  it("never throws or rejects when the constructor throws", async () => {
    const { client } = setup({ createWorker: refuse });
    let promise: Promise<DecodedWorkerEvent> | undefined;
    expect(() => {
      promise = client.process(request());
    }).not.toThrow();
    await expect(promise!).resolves.toMatchObject({ type: "blocked" });
  });

  it("installs no active generation, so a later cancel stays a no-op", async () => {
    const { client } = setup({ createWorker: refuse });
    await client.process(request());
    expect(() => client.cancel()).not.toThrow();
  });

  it("still runs a later generation after a construction failure", async () => {
    const worker = new FakeWorker();
    let attempts = 0;
    const { client, scheduler } = setup({
      createWorker: () => {
        attempts += 1;
        if (attempts === 1) refuse();
        return worker;
      },
    });
    expect((await client.process(request())).type).toBe("blocked");
    const done = client.process(request());
    emitLifecycle(worker);
    worker.emit(completedEvent({ ok: true, value: okCompletion() }));
    expect((await done).type).toBe("completed");
    expect(worker.terminateCount).toBe(1);
    expect(scheduler.size).toBe(0);
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

/**
 * `started -> progress* -> terminal` is the frozen worker contract, and the
 * per-image clock is armed from `progress` alone. A completion trusted without
 * that sequence therefore buys image work that no timer ever governed, so the
 * order is enforced, not assumed: a success completion is trusted only after
 * `started` and every expected image progress event.
 */
describe("ProcessingClient completion lifecycle", () => {
  const twoImages = (): WorkerProcessRequest =>
    request({ images: [image("a"), image("b")] });

  const okFor = (plan: WorkerProcessRequest): unknown => {
    const base = okCompletion();
    return {
      ...base,
      transformedImages: plan.images.map((input) => ({
        ...base.transformedImages[0]!,
        sourceId: input.sourceId,
      })),
    };
  };

  const expectFailsClosed = async (
    plan: WorkerProcessRequest,
    drive: (worker: FakeWorker) => void,
  ): Promise<void> => {
    const { worker, client } = setup();
    const done = client.process(plan);
    drive(worker);
    const terminal = await done;
    expect(terminal.type).toBe("blocked");
    if (terminal.type !== "blocked") return;
    expect(terminal.issues[0].code).toBe(ISSUE_CODES.malformedWorkerResponse);
    expect(worker.terminateCount).toBe(1);
  };

  it("fails closed on a completion that arrives without started", async () => {
    const plan = request();
    await expectFailsClosed(plan, (worker) => {
      worker.emit(completedEvent({ ok: true, value: okFor(plan) }));
    });
  });

  it("fails closed on a completion that skips every image progress", async () => {
    const plan = twoImages();
    await expectFailsClosed(plan, (worker) => {
      worker.emit({ type: "started", generationToken: token, imageCount: 2 });
      worker.emit(completedEvent({ ok: true, value: okFor(plan) }));
    });
  });

  it("fails closed on a completion that skips the last image progress", async () => {
    const plan = twoImages();
    await expectFailsClosed(plan, (worker) => {
      worker.emit({ type: "started", generationToken: token, imageCount: 2 });
      worker.emit({
        type: "progress",
        generationToken: token,
        sourceId: "a",
        imageIndex: 0,
        completedImages: 0,
        totalImages: 2,
        elapsedMs: 10,
        remainingPlanBudgetMs: 599_000,
      });
      worker.emit(completedEvent({ ok: true, value: okFor(plan) }));
    });
  });

  it("fails closed on a zero-image completion that arrives without started", async () => {
    const plan = request({ images: [] });
    await expectFailsClosed(plan, (worker) => {
      worker.emit(
        completedEvent({
          ok: true,
          value: { ...okCompletion(), transformedImages: [] },
        }),
      );
    });
  });

  it("accepts a zero-image completion once started has been seen", async () => {
    const { worker, client } = setup();
    const plan = request({ images: [] });
    const done = client.process(plan);
    worker.emit({ type: "started", generationToken: token, imageCount: 0 });
    worker.emit(
      completedEvent({
        ok: true,
        value: { ...okCompletion(), transformedImages: [] },
      }),
    );
    expect((await done).type).toBe("completed");
  });

  it.each([
    ["blocked", { type: "blocked", generationToken: token, issues: [] }],
    ["cancelled", { type: "cancelled", generationToken: token }],
  ])(
    "fails closed on a %s event that arrives without started",
    async (name, event) => {
      const shaped =
        name === "blocked"
          ? { ...event, issues: [createIssue(ISSUE_CODES.imageDecodeFailed)] }
          : event;
      await expectFailsClosed(request(), (worker) => {
        worker.emit(shaped);
      });
    },
  );

  it("fails closed on any event that follows an accepted completion", async () => {
    const { worker, client } = setup();
    const plan = request();
    const done = client.process(plan);
    emitLifecycle(worker, plan);
    worker.emit(completedEvent({ ok: true, value: okFor(plan) }));
    // Lands while the completion's hash verification is still in flight.
    worker.emit(progressEvent(token));
    const terminal = await done;
    expect(terminal.type).toBe("blocked");
    if (terminal.type !== "blocked") return;
    expect(terminal.issues[0].code).toBe(ISSUE_CODES.malformedWorkerResponse);
    expect(worker.terminateCount).toBe(1);
  });

  it("still accepts an error completion that stops at the failing image", async () => {
    // The worker legitimately abandons a plan mid-way: `progress*` is
    // zero-or-more, and an error arm carries no trusted output to gate.
    const { worker, client } = setup();
    const plan = twoImages();
    const done = client.process(plan);
    worker.emit({ type: "started", generationToken: token, imageCount: 2 });
    worker.emit({
      type: "progress",
      generationToken: token,
      sourceId: "a",
      imageIndex: 0,
      completedImages: 0,
      totalImages: 2,
      elapsedMs: 10,
      remainingPlanBudgetMs: 599_000,
    });
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
  });
});

/**
 * Parent-side hash verification is asynchronous, so it is a place the run can
 * hang or throw. Clearing every timer before verifying left a never-resolving
 * digest with no clock at all -- a pending promise and an unterminated worker
 * owning an embedded WASM bundle -- and a rejected digest escaped as an
 * unhandled rejection from an API documented never to reject.
 */
describe("ProcessingClient completion verification", () => {
  const hangingHash = (): (() => Promise<Sha256Digest>) => {
    return () => new Promise<Sha256Digest>(() => undefined);
  };

  it("drops the per-image clock but keeps the plan deadline while verifying", async () => {
    const { worker, scheduler, client } = setup({ hash: hangingHash() });
    const plan = request();
    const done = client.process(plan);
    emitLifecycle(worker, plan);
    expect(scheduler.size).toBe(2); // plan budget + the in-flight image
    worker.emit(completedEvent({ ok: true, value: okCompletion() }));
    // Image work is over, so the per-image timer must not govern verification;
    // the plan deadline is the hard bound that remains.
    expect(scheduler.size).toBe(1);
    scheduler.fireSoonest();
    const terminal = await done;
    expect(terminal.type).toBe("blocked");
    if (terminal.type !== "blocked") return;
    expect(terminal.issues[0].code).toBe(ISSUE_CODES.planBudgetExhausted);
  });

  it("settles once and releases the worker when the digest never resolves", async () => {
    const { worker, scheduler, client } = setup({ hash: hangingHash() });
    const plan = request();
    const done = client.process(plan);
    emitLifecycle(worker, plan);
    worker.emit(completedEvent({ ok: true, value: okCompletion() }));
    scheduler.fireSoonest();
    const terminal = await done;
    expect(terminal.type).toBe("blocked");
    expect(worker.terminateCount).toBe(1);
    expect(scheduler.size).toBe(0);
    expect(worker.onmessage).toBeNull();
  });

  it("settles once with a redacted blocker when the digest rejects", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const { worker, scheduler, client } = setup({
        hash: async () => {
          await Promise.resolve();
          throw new Error("digest unavailable");
        },
      });
      const plan = request();
      const done = client.process(plan);
      emitLifecycle(worker, plan);
      worker.emit(completedEvent({ ok: true, value: okCompletion() }));
      const terminal = await done;
      expect(terminal.type).toBe("blocked");
      if (terminal.type !== "blocked") return;
      expect(terminal.issues).toHaveLength(1);
      expect(terminal.issues[0].code).toBe(ISSUE_CODES.malformedWorkerResponse);
      expect(terminal.issues[0].displayDetails).toEqual({
        summary: terminal.issues[0].displayDetails.summary,
      });
      expect(worker.terminateCount).toBe(1);
      expect(scheduler.size).toBe(0);
      // Nothing escaped the never-reject contract.
      await new Promise((resolve) => setImmediate(resolve));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("never rejects when the digest rejects", async () => {
    const { worker, client } = setup({
      hash: () => Promise.reject(new Error("digest unavailable")),
    });
    const plan = request();
    const promise = client.process(plan);
    emitLifecycle(worker, plan);
    worker.emit(completedEvent({ ok: true, value: okCompletion() }));
    await expect(promise).resolves.toMatchObject({ type: "blocked" });
  });

  it("ignores a digest that resolves after the deadline already settled", async () => {
    let release: ((digest: Sha256Digest) => void) | undefined;
    const { worker, scheduler, client } = setup({
      hash: () =>
        new Promise<Sha256Digest>((resolve) => {
          release = resolve;
        }),
    });
    const plan = request();
    const done = client.process(plan);
    emitLifecycle(worker, plan);
    worker.emit(completedEvent({ ok: true, value: okCompletion() }));
    scheduler.fireSoonest();
    expect((await done).type).toBe("blocked");
    release?.(digest("late"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(worker.terminateCount).toBe(1);
  });
});

const CANARY = "CANARY_MUST_NOT_REACH_THE_HOST";

/**
 * Wire data is untrusted. The reviewed head branded `started`, `progress`, and
 * `cancelled` after only an object check plus a generation-token match, so a
 * hostile or buggy worker could hand the host negative counts, wrong types, and
 * extra fields, and the client reflected them verbatim into onProgress.
 */
describe("ProcessingClient wire-event validation", () => {
  const emitOne = async (
    event: unknown,
    before: readonly unknown[] = [],
  ): Promise<{
    terminal: Awaited<ReturnType<ProcessingClient["process"]>>;
    seen: unknown[];
    worker: FakeWorker;
  }> => {
    const { worker, client } = setup();
    const seen: unknown[] = [];
    const done = client.process(request(), (progress) => seen.push(progress));
    for (const earlier of before) worker.emit(earlier);
    worker.emit(event);
    return { terminal: await done, seen, worker };
  };

  const expectMalformed = async (
    event: unknown,
    before: readonly unknown[] = [],
  ): Promise<void> => {
    const { terminal, seen, worker } = await emitOne(event, before);
    expect(terminal.type, JSON.stringify(event)).toBe("blocked");
    if (terminal.type !== "blocked") return;
    expect(terminal.issues[0].code).toBe(ISSUE_CODES.malformedWorkerResponse);
    // Nothing malformed is ever delivered as progress, and the run is closed.
    expect(seen.filter((value) => value !== undefined)).toHaveLength(
      before.length,
    );
    expect(worker.terminateCount).toBe(1);
    expect(JSON.stringify(terminal)).not.toContain(CANARY);
  };

  it("rejects the forged progress event and never reflects its fields", async () => {
    const forged = {
      type: "progress",
      generationToken: token,
      sourceId: "not-a-planned-source",
      imageIndex: -5,
      completedImages: -1,
      totalImages: "many",
      elapsedMs: Number.NaN,
      remainingPlanBudgetMs: -999,
      secret: CANARY,
    };
    const { terminal, seen } = await emitOne(forged, [startedEvent(token)]);
    expect(seen.map((event) => (event as { type: string }).type)).toEqual([
      "started",
    ]);
    expect(terminal.type).toBe("blocked");
    if (terminal.type !== "blocked") return;
    expect(terminal.issues[0].code).toBe(ISSUE_CODES.malformedWorkerResponse);
    expect(JSON.stringify(terminal)).not.toContain(CANARY);
    expect(JSON.stringify(seen)).not.toContain(CANARY);
  });

  it.each([
    ["missing imageCount", { type: "started", generationToken: token }],
    [
      "negative imageCount",
      { type: "started", generationToken: token, imageCount: -3 },
    ],
    [
      "fractional imageCount",
      { type: "started", generationToken: token, imageCount: 1.5 },
    ],
    [
      "imageCount disagreeing with the plan",
      { type: "started", generationToken: token, imageCount: 7 },
    ],
    [
      "an extra field",
      {
        type: "started",
        generationToken: token,
        imageCount: 1,
        secret: CANARY,
      },
    ],
  ])("fails closed on a started event with %s", async (_name, event) => {
    await expectMalformed(event);
  });

  it.each([
    ["a repeated started event", [startedEvent(token), startedEvent(token)]],
    ["progress before started", [progressEvent(token)]],
    [
      "a repeated progress index",
      [startedEvent(token), progressEvent(token), progressEvent(token)],
    ],
    [
      "a skipped progress index",
      [
        startedEvent(token),
        {
          ...(progressEvent(token) as object),
          imageIndex: 1,
          completedImages: 1,
        },
      ],
    ],
  ])("fails closed on %s", async (_name, events) => {
    const emitted = [...events];
    await expectMalformed(emitted.pop(), emitted);
  });

  it.each([
    [
      "completedImages disagreeing with imageIndex",
      { ...(progressEvent(token) as object), completedImages: 5 },
    ],
    [
      "totalImages disagreeing with the plan",
      { ...(progressEvent(token) as object), totalImages: 9 },
    ],
    [
      "an unplanned sourceId",
      { ...(progressEvent(token) as object), sourceId: CANARY },
    ],
    [
      "a remaining budget beyond the plan window",
      {
        ...(progressEvent(token) as object),
        remainingPlanBudgetMs: 900_000,
      },
    ],
    [
      "an infinite elapsed time",
      {
        ...(progressEvent(token) as object),
        elapsedMs: Number.POSITIVE_INFINITY,
      },
    ],
  ])("fails closed on a progress event with %s", async (_name, event) => {
    await expectMalformed(event, [startedEvent(token)]);
  });

  it.each([
    [
      "cancelled",
      { type: "cancelled", generationToken: token, secret: CANARY },
    ],
    [
      "blocked",
      {
        type: "blocked",
        generationToken: token,
        issues: [createIssue(ISSUE_CODES.workerCrashed)],
        secret: CANARY,
      },
    ],
    [
      "completed",
      {
        type: "completed",
        generationToken: token,
        result: { ok: true, value: okCompletion() },
        secret: CANARY,
      },
    ],
  ])(
    "fails closed on a %s event carrying an extra field",
    async (_n, event) => {
      await expectMalformed(event);
    },
  );

  it.each([
    ["an unknown type", { type: "surprise", generationToken: token }],
    ["a missing type", { generationToken: token }],
    ["a non-string type", { type: 7, generationToken: token }],
  ])("fails closed on %s", async (_name, event) => {
    await expectMalformed(event);
  });

  it.each([
    ["a bare string", "completed"],
    ["a number", 7],
    ["null", null],
    ["an array", [{ type: "completed", generationToken: token }]],
  ])("fails closed on wire data that is %s", async (_name, data) => {
    const { worker, client } = setup();
    const done = client.process(request());
    worker.emit(data);
    const terminal = await done;
    expect(terminal.type).toBe("blocked");
    if (terminal.type !== "blocked") return;
    expect(terminal.issues[0].code).toBe(ISSUE_CODES.malformedWorkerResponse);
  });

  it("still silently discards a stale generation instead of failing closed", async () => {
    const { worker, client } = setup();
    const seen: unknown[] = [];
    const done = client.process(request(), (event) => seen.push(event));
    // Malformed *and* stale: the token gate wins, so this is simply dropped.
    worker.emit({
      type: "progress",
      generationToken: otherToken,
      junk: CANARY,
    });
    emitLifecycle(worker);
    worker.emit(completedEvent({ ok: true, value: okCompletion() }));
    expect((await done).type).toBe("completed");
    expect(seen).toHaveLength(2);
  });

  it("delivers only the contract fields of a valid progress event", async () => {
    const { worker, client } = setup();
    const seen: Record<string, unknown>[] = [];
    const done = client.process(request(), (event) =>
      seen.push(event as unknown as Record<string, unknown>),
    );
    worker.emit(startedEvent(token));
    worker.emit(progressEvent(token));
    worker.emit(completedEvent({ ok: true, value: okCompletion() }));
    await done;
    expect(Object.keys(seen[0]!).sort()).toEqual([
      "generationToken",
      "imageCount",
      "type",
    ]);
    expect(Object.keys(seen[1]!).sort()).toEqual([
      "completedImages",
      "elapsedMs",
      "generationToken",
      "imageIndex",
      "remainingPlanBudgetMs",
      "sourceId",
      "totalImages",
      "type",
    ]);
    expect(Object.isFrozen(seen[1])).toBe(true);
  });
});

/**
 * Completion dimensions are a trust boundary: sealing sizes buffers from them.
 * The reviewed head accepted any nonnegative integer, so a zero or a forged
 * four-billion-pixel edge crossed into host state as a verified completion.
 */
describe("ProcessingClient completion decoding", () => {
  const completionWith = async (
    mutate: (completion: ReturnType<typeof okCompletion>) => unknown,
  ) => {
    const { worker, client } = setup();
    const done = client.process(request());
    emitLifecycle(worker);
    const completion = okCompletion();
    const value = mutate(completion) ?? completion;
    worker.emit(completedEvent({ ok: true, value }));
    return done;
  };

  const expectRejected = async (
    mutate: (completion: ReturnType<typeof okCompletion>) => unknown,
  ): Promise<void> => {
    const terminal = await completionWith(mutate);
    expect(terminal.type).toBe("blocked");
    if (terminal.type !== "blocked") return;
    expect(terminal.issues[0].code).toBe(ISSUE_CODES.malformedWorkerResponse);
  };

  it.each([
    ["zero width", 0, 4],
    ["zero height", 4, 0],
    ["a negative width", -1, 4],
    ["a fractional height", 4, 2.5],
    ["an absurd forged height", 1, 4_000_000_000],
    ["a product beyond the decoded-pixel limit", 40_000, 1_001],
  ])("rejects a completion image with %s", async (_name, width, height) => {
    await expectRejected((completion) => {
      completion.transformedImages[0]!.width = width;
      completion.transformedImages[0]!.height = height;
    });
  });

  it("accepts an image exactly at the decoded-pixel limit", async () => {
    const terminal = await completionWith((completion) => {
      const [output] = completion.transformedImages;
      output!.decodedWidth = 8_000;
      output!.decodedHeight = 5_000;
      output!.width = 8_000;
      output!.height = 5_000;
    });
    expect(terminal.type).toBe("completed");
  });

  it("rejects an output byte length beyond the sealed-output limit", async () => {
    await expectRejected((completion) => {
      completion.generatedMdx.byteLength = 26_214_401;
    });
  });

  it("rejects a non-canonical content digest", async () => {
    await expectRejected((completion) => {
      completion.generatedMdx.contentSha256 = digest("not-hex");
    });
  });

  it("rejects a transformed-image list that does not match the request", async () => {
    await expectRejected((completion) => {
      completion.transformedImages = [];
    });
    await expectRejected((completion) => {
      completion.transformedImages = [
        completion.transformedImages[0]!,
        completion.transformedImages[0]!,
      ];
    });
    await expectRejected((completion) => {
      completion.transformedImages[0]!.sourceId = "unplanned";
    });
  });

  it.each([
    [
      "the completion value",
      (completion: Record<string, unknown>) => {
        completion.secret = CANARY;
      },
    ],
    [
      "the generated MDX output",
      (completion: Record<string, unknown>) => {
        (completion.generatedMdx as Record<string, unknown>).secret = CANARY;
      },
    ],
    [
      "an image output",
      (completion: Record<string, unknown>) => {
        (
          (
            completion.transformedImages as Record<string, unknown>[]
          )[0] as Record<string, unknown>
        ).secret = CANARY;
      },
    ],
  ])("rejects an extra field on %s", async (_name, mutate) => {
    await expectRejected((completion) => {
      mutate(completion as unknown as Record<string, unknown>);
    });
  });

  it("rejects an extra field on the result envelope", async () => {
    const { worker, client } = setup();
    const done = client.process(request());
    emitLifecycle(worker);
    worker.emit(
      completedEvent({ ok: true, value: okCompletion(), secret: CANARY }),
    );
    const terminal = await done;
    expect(terminal.type).toBe("blocked");
    if (terminal.type !== "blocked") return;
    expect(terminal.issues[0].code).toBe(ISSUE_CODES.malformedWorkerResponse);
    expect(JSON.stringify(terminal)).not.toContain(CANARY);
  });
});

/**
 * The worker's own budget accounting is untrusted. The parent recomputes the
 * plan's cumulative decoded work from the reported decoded dimensions, applying
 * the same per-canonical-source dedupe from its *own* request hashes, so a
 * worker that overruns -- or lies about having stayed inside -- still fails
 * closed on the locked DECODED_WORK_LIMIT_EXCEEDED channel.
 */
describe("ProcessingClient cumulative decoded-work budget", () => {
  const CUMULATIVE = MDX_RELAY_LIMITS.cumulativeDecodedPixels;
  const PER_IMAGE = MDX_RELAY_LIMITS.decodedImagePixels;

  /** `contentSha256` values drive the parent's dedupe, independent of sourceId. */
  const planOf = (contentKeys: readonly string[]): WorkerProcessRequest =>
    request({
      images: contentKeys.map((key, index) => ({
        sourceId: `img-${String(index)}`,
        safePathLabel: label(`assets/img-${String(index)}.png`),
        contentSha256: digest(key),
        byteLength: 4,
        bytes: Uint8Array.of(1, 2, 3, 4).buffer,
      })),
    });

  const completionFor = (
    plan: WorkerProcessRequest,
    decoded: (index: number) => readonly [number, number],
  ) => {
    const base = okCompletion();
    return {
      ...base,
      transformedImages: plan.images.map((input, index) => {
        const [decodedWidth, decodedHeight] = decoded(index);
        return {
          ...base.transformedImages[0]!,
          sourceId: input.sourceId,
          decodedWidth,
          decodedHeight,
        };
      }),
    };
  };

  const settleWith = async (
    plan: WorkerProcessRequest,
    completion: unknown,
  ) => {
    const { worker, client } = setup();
    const done = client.process(plan);
    emitLifecycle(worker, plan);
    worker.emit(completedEvent({ ok: true, value: completion }));
    return done;
  };

  it("blocks a completion whose unique decoded work exceeds the budget", async () => {
    // Eleven distinct canonical sources at the 40MP per-image boundary: 440MP.
    const plan = planOf(
      Array.from({ length: 11 }, (_, index) => `source-${String(index)}`),
    );
    const terminal = await settleWith(
      plan,
      completionFor(plan, () => [8_000, 5_000]),
    );
    expect(terminal.type).toBe("blocked");
    if (terminal.type !== "blocked") return;
    expect(terminal.issues[0].code).toBe(ISSUE_CODES.decodedWorkLimitExceeded);
    expect(terminal.issues[0].severity).toBe("blocker");
  });

  it("accepts a plan exactly at the cumulative budget", async () => {
    const plan = planOf(
      Array.from({ length: 10 }, (_, index) => `source-${String(index)}`),
    );
    const terminal = await settleWith(
      plan,
      completionFor(plan, () => [8_000, 5_000]),
    );
    expect(10 * PER_IMAGE).toBe(CUMULATIVE);
    expect(terminal.type).toBe("completed");
  });

  it("charges a repeated canonical source once, matching worker dedupe", async () => {
    // Twenty embeds of one source: 40MP of decoded work, not 800MP.
    const plan = planOf(Array<string>(20).fill("one-source"));
    const terminal = await settleWith(
      plan,
      completionFor(plan, () => [8_000, 5_000]),
    );
    expect(terminal.type).toBe("completed");
  });

  it("rejects repeated sources that disagree on their decoded size", async () => {
    const plan = planOf(["one-source", "one-source"]);
    const terminal = await settleWith(
      plan,
      completionFor(plan, (index) => (index === 0 ? [8_000, 5_000] : [10, 10])),
    );
    // Incoherent dedupe accounting is an unusable report, not a budget verdict.
    expect(terminal.type).toBe("blocked");
    if (terminal.type !== "blocked") return;
    expect(terminal.issues[0].code).toBe(ISSUE_CODES.malformedWorkerResponse);
  });

  it("rejects repeated sources with equal area but different dimensions", async () => {
    // One canonical source cannot have decoded as both 2x6 and 3x4. Comparing
    // only the 12-pixel area accepted the contradiction; the exact edges are
    // what the dedupe claim actually asserts.
    const plan = planOf(["one-source", "one-source"]);
    const terminal = await settleWith(
      plan,
      completionFor(plan, (index) => (index === 0 ? [2, 6] : [3, 4])),
    );
    expect(terminal.type).toBe("blocked");
    if (terminal.type !== "blocked") return;
    expect(terminal.issues[0].code).toBe(ISSUE_CODES.malformedWorkerResponse);
  });

  it("rejects decoded dimensions that are absent, zero, or absurd", async () => {
    for (const decoded of [
      [0, 5_000],
      [8_000, 0],
      [-1, 5_000],
      [1.5, 5_000],
      [4_000_000_000, 4_000_000_000],
      [8_001, 5_000], // 40,005,000 px: past the per-image ceiling
    ] as const) {
      // A fresh plan each round: the previous run transferred its buffers away.
      const plan = planOf(["one-source"]);
      const terminal = await settleWith(
        plan,
        completionFor(plan, () => decoded),
      );
      expect(terminal.type, decoded.join("x")).toBe("blocked");
      if (terminal.type !== "blocked") continue;
      expect(terminal.issues[0].code).toBe(ISSUE_CODES.malformedWorkerResponse);
    }
  });

  it("rejects an output larger than the source the codec decoded", async () => {
    const plan = planOf(["one-source"]);
    const base = okCompletion();
    const terminal = await settleWith(plan, {
      ...base,
      transformedImages: [
        {
          ...base.transformedImages[0]!,
          sourceId: plan.images[0]!.sourceId,
          decodedWidth: 2,
          decodedHeight: 2,
          width: 8,
          height: 8,
        },
      ],
    });
    expect(terminal.type).toBe("blocked");
    if (terminal.type !== "blocked") return;
    expect(terminal.issues[0].code).toBe(ISSUE_CODES.malformedWorkerResponse);
  });

  it("allows an orientation transpose that preserves the decoded area", async () => {
    const plan = planOf(["one-source"]);
    const base = okCompletion();
    const terminal = await settleWith(plan, {
      ...base,
      transformedImages: [
        {
          ...base.transformedImages[0]!,
          sourceId: plan.images[0]!.sourceId,
          decodedWidth: 4_000,
          decodedHeight: 2_000,
          width: 2_000,
          height: 4_000,
        },
      ],
    });
    expect(terminal.type).toBe("completed");
  });

  it("preserves a worker-reported decoded-work blocker verbatim", async () => {
    const { worker, client } = setup();
    const done = client.process(request());
    worker.emit(startedEvent(token));
    worker.emit(
      completedEvent({
        ok: false,
        error: [createIssue(ISSUE_CODES.decodedWorkLimitExceeded)],
      }),
    );
    const terminal = await done;
    expect(terminal.type).toBe("completed");
    if (terminal.type !== "completed") return;
    expect(terminal.result.ok).toBe(false);
    if (terminal.result.ok) return;
    expect(terminal.result.error[0].code).toBe(
      ISSUE_CODES.decodedWorkLimitExceeded,
    );
  });
});
