import { ISSUE_REGISTRY, type MdxRelayIssue } from "../contracts/issues";
import type { PreviewState } from "./preview-state";

export interface PreviewModalActions {
  readonly setApprovalEnabled: (enabled: boolean) => void;
  readonly approve: () => void;
  readonly cancel: () => void;
}

const add = <K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  parent.append(element);
  return element;
};

const issueList = (
  parent: HTMLElement,
  title: string,
  issues: readonly MdxRelayIssue[],
): void => {
  if (issues.length === 0) return;
  add(parent, "h3", title);
  const list = add(parent, "ul");
  for (const issue of issues) {
    const definition = ISSUE_REGISTRY[issue.code];
    const item = add(list, "li", `${issue.code}: ${definition.summary}`);
    item.dataset.issueCode = issue.code;
  }
};

const renderPlan = (root: HTMLElement, state: PreviewState): void => {
  if (!("document" in state)) return;
  const { plan, mdxDiff, assets } = state.document;
  add(root, "h3", "Target folder");
  add(root, "code", plan.targetFolderSnapshot.targetRootRealPath);

  add(root, "h3", "Profile");
  const profileIdentity = add(root, "code", plan.profileSnapshotSha256);
  profileIdentity.dataset.preview = "profile-identity";

  add(root, "h3", "Exact files");
  const files = add(root, "ul");
  const entries =
    plan.state === "ready"
      ? plan.actions.map((action) => ({
          path: action.targetPath,
          detail: `${action.kind}, ${action.sealedOutput.byteLength} bytes, ${action.sealedOutput.contentSha256}`,
        }))
      : plan.targetFolderSnapshot.targets.map((target) => ({
          path: target.relativePath,
          detail: "unchanged",
        }));
  for (const entry of entries)
    add(files, "li", `${entry.path} — ${entry.detail}`);

  add(root, "h3", "MDX diff");
  const diff = add(root, "pre", mdxDiff);
  diff.dataset.preview = "mdx-diff";

  if (assets.length > 0) {
    add(root, "h3", "Assets");
    const list = add(root, "ul");
    list.dataset.preview = "assets";
    for (const asset of assets)
      add(
        list,
        "li",
        `${asset.targetPath} — ${asset.byteLength} bytes — ${asset.contentSha256}`,
      );
  }
  issueList(root, "Warnings", plan.issues);
};

/** DOM-only view. It has no access to Obsidian, planning, storage, or writing. */
export function renderPreviewModal(
  root: HTMLElement,
  state: PreviewState,
  actions: PreviewModalActions,
): void {
  root.replaceChildren();
  root.dataset.generationToken = state.generationToken;
  if ("identity" in state) root.dataset.planId = state.identity.planId;

  add(root, "h2", "MDX Relay preview");
  const status = add(root, "p");
  status.dataset.previewStatus = state.phase;

  if (state.phase === "capturing") status.textContent = "Capturing note…";
  else if (state.phase === "processing")
    status.textContent = state.progress ?? "Building exact preview…";
  else if (state.phase === "ready") status.textContent = "Ready";
  else if (state.phase === "no-changes") status.textContent = "No Changes";
  else if (state.phase === "blocked") status.textContent = "Blocked";
  else if (state.phase === "cancelled") status.textContent = "Cancelled";
  else if (state.phase === "success")
    status.textContent = "Write completed successfully";
  else if (state.phase === "partial-failure")
    status.textContent = "Partial failure";
  else status.textContent = "Write failed";

  renderPlan(root, state);

  if (state.phase === "blocked") issueList(root, "Blockers", state.issues);
  if (
    state.phase === "success" ||
    state.phase === "partial-failure" ||
    state.phase === "write-failed"
  ) {
    add(root, "h3", "Write result");
    add(
      root,
      "p",
      `${state.report.completed.length} completed, ${state.report.failed.length} failed, ${state.report.unattempted.length} unattempted`,
    );
    issueList(root, "Write blockers", state.issues);
  }

  if (state.phase === "ready" || state.phase === "no-changes") {
    const label = add(root, "label");
    const checkbox = add(label, "input");
    checkbox.type = "checkbox";
    checkbox.checked = state.approvalEnabled;
    checkbox.disabled = state.approving;
    checkbox.addEventListener("change", () =>
      actions.setApprovalEnabled(checkbox.checked),
    );
    label.append(" I reviewed this exact plan");

    const approve = add(
      root,
      "button",
      state.approving ? "Writing…" : "Approve",
    );
    approve.dataset.action = "approve";
    approve.disabled = !state.approvalEnabled || state.approving;
    approve.addEventListener("click", actions.approve);
  }

  const cancel = add(root, "button", "Close");
  cancel.dataset.action = "cancel";
  cancel.addEventListener("click", actions.cancel);
}
