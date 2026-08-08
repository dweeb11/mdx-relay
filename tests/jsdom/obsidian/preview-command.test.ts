import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  GenerationToken,
  PlanId,
} from "../../../src/contracts/export-plan";
import { createIssue, ISSUE_CODES } from "../../../src/contracts/issues";
import { mdxRelayErr, mdxRelayOk } from "../../../src/contracts/result";
import {
  PreviewCommand,
  type BuiltPreview,
  type PreviewCommandDeps,
} from "../../../src/obsidian/preview-command";
import type {
  ApplyApprovedWritesInput,
  ApplyApprovedWritesResult,
} from "../../../src/write";
import {
  buildFakePreview,
  fakeCapture,
  FakeObsidianHost,
  FAKE_IMAGE_BYTES,
  FAKE_NOTE_BYTES,
} from "../../helpers/fake-obsidian-host";

const token = (number: number) => `generation-${number}` as GenerationToken;

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const approve = (root: HTMLElement): void => {
  const checkbox = root.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  )!;
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event("change"));
  root.querySelector<HTMLButtonElement>('[data-action="approve"]')!.click();
};

const makeDeps = (
  host: FakeObsidianHost,
  overrides: Partial<PreviewCommandDeps> = {},
): PreviewCommandDeps => {
  let nextToken = 0;
  return {
    host,
    createGenerationToken: () => token(++nextToken),
    buildPreview: async (capture) =>
      mdxRelayOk(buildFakePreview(capture.generationToken)),
    cancelGeneration: vi.fn(),
    recaptureApproval: async (plan) =>
      mdxRelayOk({
        sourceBytes: {
          note: FAKE_NOTE_BYTES,
          images: new Map([["image-1", FAKE_IMAGE_BYTES]]),
        },
        fingerprint: plan.approvalFingerprint,
      }),
    recordApproval: async (planId) => mdxRelayOk(planId),
    applyApprovedWrites: vi.fn(async (input: ApplyApprovedWritesInput) => ({
      ok: true as const,
      report: {
        completed: input.plan.actions.map((action) => ({
          targetPath: action.targetPath,
          contentSha256: action.sealedOutput.contentSha256,
          byteLength: action.sealedOutput.byteLength,
          kind: action.kind,
        })),
        failed: [],
        unattempted: [],
      },
    })),
    ...overrides,
  };
};

describe("PreviewCommand", () => {
  beforeEach(() => document.body.replaceChildren());

  it("captures once, renders Ready, and writes only after explicit approval", async () => {
    const host = new FakeObsidianHost();
    host.queueCapture(mdxRelayOk(fakeCapture(token(1))));
    const deps = makeDeps(host);
    const command = new PreviewCommand(deps);
    command.execute();
    await flush();

    const modal = host.latestModal();
    expect(modal.querySelector("[data-preview-status]")?.textContent).toBe(
      "Ready",
    );
    expect(modal.textContent).toContain("/target/site");
    expect(modal.textContent).toContain("content/posts/example.mdx");
    expect(modal.textContent).toContain("sha256:");
    expect(modal.textContent).toContain("- old");
    expect(host.captures).toEqual([token(1)]);
    expect(deps.applyApprovedWrites).not.toHaveBeenCalled();
    expect(
      modal.querySelector<HTMLButtonElement>('[data-action="approve"]')
        ?.disabled,
    ).toBe(true);

    approve(modal);
    await flush();
    expect(deps.applyApprovedWrites).toHaveBeenCalledTimes(1);
    const request = vi.mocked(deps.applyApprovedWrites).mock.calls[0]![0];
    expect(request.plan.planId).toBe(modal.dataset.planId);
    expect(request.approvalTransition).toEqual({
      generationToken: token(1),
      planId: request.plan.planId,
    });
    expect(modal.querySelector("[data-preview-status]")?.textContent).toBe(
      "Write completed successfully",
    );
  });

  it("renders No Changes and Blocked deterministically", async () => {
    const host = new FakeObsidianHost();
    host.queueCapture(mdxRelayOk(fakeCapture(token(1))));
    host.queueCapture(mdxRelayOk(fakeCapture(token(2))));
    const deps = makeDeps(host, {
      buildPreview: vi
        .fn()
        .mockResolvedValueOnce(
          mdxRelayOk(buildFakePreview(token(1), "no-changes")),
        )
        .mockResolvedValueOnce(
          mdxRelayErr([createIssue(ISSUE_CODES.invalidMdx)]),
        ),
    });
    const command = new PreviewCommand(deps);
    command.execute();
    await flush();
    expect(
      host.latestModal().querySelector("[data-preview-status]")?.textContent,
    ).toBe("No Changes");

    command.execute();
    await flush();
    const modal = host.latestModal();
    expect(modal.querySelector("[data-preview-status]")?.textContent).toBe(
      "Blocked",
    );
    expect(modal.textContent).toContain("INVALID_MDX");
  });

  it("drops late generations and close/reopen results without changing identity", async () => {
    const first = deferred<ReturnType<typeof mdxRelayOk<BuiltPreview>>>();
    const host = new FakeObsidianHost();
    host.queueCapture(mdxRelayOk(fakeCapture(token(1))));
    host.queueCapture(mdxRelayOk(fakeCapture(token(2))));
    const deps = makeDeps(host, {
      buildPreview: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce(mdxRelayOk(buildFakePreview(token(2)))),
    });
    const command = new PreviewCommand(deps);
    command.execute();
    await flush();
    command.execute();
    await flush();
    const modal = host.latestModal();
    const planId = modal.dataset.planId;

    first.resolve(mdxRelayOk(buildFakePreview(token(1))));
    await flush();
    expect(modal.dataset.generationToken).toBe(token(2));
    expect(modal.dataset.planId).toBe(planId);
    expect(deps.cancelGeneration).toHaveBeenCalledWith(token(1));
  });

  it("rejects double approval, stale recapture, cancellation, and unload races", async () => {
    const approval = deferred<
      ReturnType<
        typeof mdxRelayOk<{
          sourceBytes: { note: Uint8Array; images: Map<string, Uint8Array> };
          fingerprint: ReturnType<
            typeof buildFakePreview
          >["envelope"]["plan"]["approvalFingerprint"];
        }>
      >
    >();
    const host = new FakeObsidianHost();
    host.queueCapture(mdxRelayOk(fakeCapture(token(1))));
    const apply = vi.fn();
    const deps = makeDeps(host, {
      recaptureApproval: vi.fn(() => approval.promise),
      applyApprovedWrites: apply,
    });
    const command = new PreviewCommand(deps);
    command.execute();
    await flush();
    const modal = host.latestModal();
    approve(modal);
    modal.querySelector<HTMLButtonElement>('[data-action="approve"]')?.click();
    expect(deps.recaptureApproval).toHaveBeenCalledTimes(1);

    modal.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click();
    approval.resolve(
      mdxRelayOk({
        sourceBytes: {
          note: FAKE_NOTE_BYTES,
          images: new Map([["image-1", FAKE_IMAGE_BYTES]]),
        },
        fingerprint: buildFakePreview(token(1)).envelope.plan
          .approvalFingerprint,
      }),
    );
    await flush();
    expect(apply).not.toHaveBeenCalled();

    const host2 = new FakeObsidianHost();
    host2.queueCapture(mdxRelayOk(fakeCapture(token(1))));
    const staleDeps = makeDeps(host2, {
      recaptureApproval: async () =>
        mdxRelayErr([createIssue(ISSUE_CODES.targetChanged)]),
    });
    const unloaded = new PreviewCommand(staleDeps);
    unloaded.execute();
    await flush();
    approve(host2.latestModal());
    await flush();
    expect(
      host2.latestModal().querySelector("[data-preview-status]")?.textContent,
    ).toBe("Write failed");
    expect(staleDeps.applyApprovedWrites).not.toHaveBeenCalled();
    unloaded.unload();
    unloaded.execute();
    expect(host2.modalElements).toHaveLength(1);
  });

  it("preserves truthful partial failure and exact plan ID", async () => {
    const host = new FakeObsidianHost();
    host.queueCapture(mdxRelayOk(fakeCapture(token(1))));
    const partial = vi.fn(
      async (
        input: Parameters<PreviewCommandDeps["applyApprovedWrites"]>[0],
      ): Promise<ApplyApprovedWritesResult> => ({
        ok: false as const,
        report: {
          completed: [
            {
              targetPath: input.plan.actions[0]!.targetPath,
              contentSha256: input.plan.actions[0]!.sealedOutput.contentSha256,
              byteLength: input.plan.actions[0]!.sealedOutput.byteLength,
              kind: input.plan.actions[0]!.kind,
            },
          ],
          failed: [
            {
              targetPath: input.plan.actions[1]!.targetPath,
              issue: createIssue(ISSUE_CODES.targetWriteFailed),
            },
          ],
          unattempted: [],
        },
        error: [createIssue(ISSUE_CODES.targetWriteFailed)],
      }),
    );
    const deps = makeDeps(host, { applyApprovedWrites: partial });
    const command = new PreviewCommand(deps);
    command.execute();
    await flush();
    const modal = host.latestModal();
    const planId = modal.dataset.planId as PlanId;
    approve(modal);
    await flush();
    expect(modal.querySelector("[data-preview-status]")?.textContent).toBe(
      "Partial failure",
    );
    expect(modal.textContent).not.toContain("completed successfully");
    expect(partial.mock.calls[0]![0].plan.planId).toBe(planId);
  });
});
