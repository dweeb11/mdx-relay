import type {
  ExportPlan,
  GenerationToken,
  PlanIdentity,
} from "../contracts/export-plan";
import type { BlockerIssue, WarningIssue } from "../contracts/issues";
import type { TargetFolderWriteReport } from "../write";

export interface PreviewAsset {
  readonly sourceId: string;
  readonly targetPath: string;
  readonly contentSha256: string;
  readonly byteLength: number;
}

export interface PreviewDocument {
  readonly plan: ExportPlan;
  readonly mdxDiff: string;
  readonly assets: readonly PreviewAsset[];
}

export type PreviewState =
  | Readonly<{
      phase: "capturing" | "processing";
      generationToken: GenerationToken;
      progress?: string;
    }>
  | Readonly<{
      phase: "ready" | "no-changes";
      generationToken: GenerationToken;
      identity: PlanIdentity;
      document: PreviewDocument;
      approvalEnabled: boolean;
      approving: boolean;
    }>
  | Readonly<{
      phase: "blocked";
      generationToken: GenerationToken;
      issues: readonly [BlockerIssue, ...BlockerIssue[]];
    }>
  | Readonly<{
      phase: "cancelled";
      generationToken: GenerationToken;
    }>
  | Readonly<{
      phase: "success" | "partial-failure" | "write-failed";
      generationToken: GenerationToken;
      identity: PlanIdentity;
      document: PreviewDocument;
      report: TargetFolderWriteReport;
      issues: readonly BlockerIssue[];
    }>;

export type PreviewAction =
  | Readonly<{ type: "processing"; generationToken: GenerationToken }>
  | Readonly<{
      type: "progress";
      generationToken: GenerationToken;
      progress: string;
    }>
  | Readonly<{
      type: "plan";
      generationToken: GenerationToken;
      document: PreviewDocument;
    }>
  | Readonly<{
      type: "blocked";
      generationToken: GenerationToken;
      issues: readonly [BlockerIssue, ...BlockerIssue[]];
    }>
  | Readonly<{ type: "cancel"; generationToken: GenerationToken }>
  | Readonly<{
      type: "approval-toggle";
      identity: PlanIdentity;
      enabled: boolean;
    }>
  | Readonly<{ type: "approval-start"; identity: PlanIdentity }>
  | Readonly<{
      type: "write-result";
      identity: PlanIdentity;
      report: TargetFolderWriteReport;
      issues?: readonly BlockerIssue[];
    }>;

const sameGeneration = (
  state: PreviewState,
  generationToken: GenerationToken,
): boolean => state.generationToken === generationToken;

const sameIdentity = (
  state: PreviewState,
  identity: PlanIdentity,
): state is Extract<PreviewState, { identity: PlanIdentity }> =>
  "identity" in state &&
  state.identity.generationToken === identity.generationToken &&
  state.identity.planId === identity.planId;

/** Pure identity-gated state machine. Stale and late actions are no-ops. */
export function reducePreviewState(
  state: PreviewState,
  action: PreviewAction,
): PreviewState {
  if (action.type === "processing")
    return sameGeneration(state, action.generationToken) &&
      state.phase === "capturing"
      ? { phase: "processing", generationToken: action.generationToken }
      : state;

  if (action.type === "progress")
    return sameGeneration(state, action.generationToken) &&
      state.phase === "processing"
      ? { ...state, progress: action.progress }
      : state;

  if (action.type === "plan") {
    if (
      !sameGeneration(state, action.generationToken) ||
      (state.phase !== "capturing" && state.phase !== "processing") ||
      action.document.plan.generationToken !== action.generationToken
    )
      return state;
    const identity = Object.freeze({
      generationToken: action.generationToken,
      planId: action.document.plan.planId,
    });
    return Object.freeze({
      phase:
        action.document.plan.state === "ready"
          ? ("ready" as const)
          : ("no-changes" as const),
      generationToken: action.generationToken,
      identity,
      document: action.document,
      approvalEnabled: false,
      approving: false,
    });
  }

  if (action.type === "blocked")
    return sameGeneration(state, action.generationToken) &&
      (state.phase === "capturing" || state.phase === "processing")
      ? {
          phase: "blocked",
          generationToken: action.generationToken,
          issues: action.issues,
        }
      : state;

  if (action.type === "cancel")
    return sameGeneration(state, action.generationToken) &&
      (state.phase === "capturing" || state.phase === "processing")
      ? { phase: "cancelled", generationToken: action.generationToken }
      : state;

  if (action.type === "approval-toggle")
    return sameIdentity(state, action.identity) &&
      (state.phase === "ready" || state.phase === "no-changes") &&
      !state.approving
      ? { ...state, approvalEnabled: action.enabled }
      : state;

  if (action.type === "approval-start")
    return sameIdentity(state, action.identity) &&
      (state.phase === "ready" || state.phase === "no-changes") &&
      state.approvalEnabled &&
      !state.approving
      ? { ...state, approvalEnabled: false, approving: true }
      : state;

  if (!sameIdentity(state, action.identity) || !("document" in state))
    return state;
  if (state.phase !== "ready" && state.phase !== "no-changes") return state;
  const issues = action.issues ?? [];
  const phase =
    action.report.failed.length === 0 &&
    action.report.unattempted.length === 0 &&
    issues.length === 0
      ? "success"
      : action.report.completed.length > 0
        ? "partial-failure"
        : "write-failed";
  return {
    phase,
    generationToken: state.generationToken,
    identity: state.identity,
    document: state.document,
    report: action.report,
    issues,
  };
}

export const initialPreviewState = (
  generationToken: GenerationToken,
): PreviewState => Object.freeze({ phase: "capturing", generationToken });

export const planWarnings = (state: PreviewState): readonly WarningIssue[] =>
  "document" in state ? state.document.plan.issues : [];
