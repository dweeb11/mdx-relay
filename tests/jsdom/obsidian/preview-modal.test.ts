import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GenerationToken } from "../../../src/contracts/export-plan";
import { createIssue, ISSUE_CODES } from "../../../src/contracts/issues";
import { renderPreviewModal } from "../../../src/obsidian/preview-modal";
import {
  initialPreviewState,
  reducePreviewState,
  type PreviewState,
} from "../../../src/obsidian/preview-state";
import { buildFakePreview } from "../../helpers/fake-obsidian-host";

const generationToken = "generation-modal" as GenerationToken;

const readyState = (): PreviewState => {
  const built = buildFakePreview(generationToken);
  return reducePreviewState(initialPreviewState(generationToken), {
    type: "plan",
    generationToken,
    document: {
      plan: built.envelope.plan,
      mdxDiff: "-before\n+after",
      assets: [
        {
          sourceId: "image-1",
          targetPath: "public/posts/example/img-1.webp",
          byteLength: 11,
          contentSha256: "sha256:asset",
        },
      ],
    },
  });
};

describe("renderPreviewModal", () => {
  beforeEach(() => document.body.replaceChildren());

  it("renders the exact local target identity, files, diff, assets, and warnings", () => {
    const root = document.createElement("div");
    const built = buildFakePreview(generationToken);
    const warningPlan = {
      ...built.envelope.plan,
      issues: [createIssue(ISSUE_CODES.summaryMissing)],
    };
    const state = reducePreviewState(initialPreviewState(generationToken), {
      type: "plan",
      generationToken,
      document: {
        plan: warningPlan,
        mdxDiff: "-before\n+after",
        assets: [
          {
            sourceId: "image-1",
            targetPath: "public/posts/example/img-1.webp",
            byteLength: 11,
            contentSha256: "sha256:asset",
          },
        ],
      },
    });
    renderPreviewModal(root, state, {
      setApprovalEnabled: vi.fn(),
      approve: vi.fn(),
      cancel: vi.fn(),
    });

    expect(root.textContent).toContain("Ready");
    expect(root.textContent).toContain("/target/site");
    expect(root.textContent).toContain("content/posts/example.mdx");
    expect(root.textContent).toContain("-before");
    expect(root.textContent).toContain("11 bytes");
    expect(root.textContent).toContain("SUMMARY_MISSING");
    expect(root.textContent).not.toMatch(
      /\b(?:commit|push|remote|branch|staging)\b/iu,
    );
  });

  it("keeps approval disabled until the checkbox changes", () => {
    const root = document.createElement("div");
    const setApprovalEnabled = vi.fn();
    const approve = vi.fn();
    renderPreviewModal(root, readyState(), {
      setApprovalEnabled,
      approve,
      cancel: vi.fn(),
    });
    const button = root.querySelector<HTMLButtonElement>(
      '[data-action="approve"]',
    )!;
    expect(button.disabled).toBe(true);
    button.click();
    expect(approve).not.toHaveBeenCalled();

    const checkbox = root.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    expect(setApprovalEnabled).toHaveBeenCalledWith(true);
  });

  it("renders blockers and never labels partial failure as success", () => {
    const root = document.createElement("div");
    const blocked = reducePreviewState(initialPreviewState(generationToken), {
      type: "blocked",
      generationToken,
      issues: [createIssue(ISSUE_CODES.invalidMdx)],
    });
    const actions = {
      setApprovalEnabled: vi.fn(),
      approve: vi.fn(),
      cancel: vi.fn(),
    };
    renderPreviewModal(root, blocked, actions);
    expect(root.textContent).toContain("Blocked");
    expect(root.textContent).toContain("INVALID_MDX");

    let state = readyState();
    if (state.phase !== "ready") throw new Error("expected ready");
    state = reducePreviewState(state, {
      type: "approval-toggle",
      identity: state.identity,
      enabled: true,
    });
    if (state.phase !== "ready") throw new Error("expected ready");
    state = reducePreviewState(state, {
      type: "approval-start",
      identity: state.identity,
    });
    if (state.phase !== "ready") throw new Error("expected ready");
    state = reducePreviewState(state, {
      type: "write-result",
      identity: state.identity,
      report: {
        completed: [
          {
            targetPath: "content/posts/example.mdx",
            contentSha256: state.document.plan.generatedMdx.contentSha256,
            byteLength: state.document.plan.generatedMdx.byteLength,
            kind: "create",
          },
        ],
        failed: [
          {
            targetPath: "public/posts/example/img-1.webp",
            issue: createIssue(ISSUE_CODES.targetWriteFailed),
          },
        ],
        unattempted: [],
      },
      issues: [createIssue(ISSUE_CODES.targetWriteFailed)],
    });
    renderPreviewModal(root, state, actions);
    expect(root.textContent).toContain("Partial failure");
    expect(root.textContent).not.toContain("completed successfully");
    expect(root.textContent).toContain("1 completed, 1 failed");
  });
});
