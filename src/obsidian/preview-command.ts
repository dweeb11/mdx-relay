import type {
  ApprovalFingerprint,
  ApprovalRecord,
  ExportPlan,
  GenerationToken,
  PlanIdentity,
} from "../contracts/export-plan";
import {
  createIssue,
  ISSUE_CODES,
  type BlockerIssue,
} from "../contracts/issues";
import type { MdxRelayResult } from "../contracts/result";
import type { DecodedWorkerEvent } from "../contracts/worker-protocol";
import type { PlanSourceBytes } from "../planning/build-export-plan";
import type { SealedExportPlanEnvelope } from "../planning/plan-verification";
import type {
  ApplyApprovedWritesInput,
  ApplyApprovedWritesResult,
} from "../write";
import { sha256OfBytes } from "../canonical/hash";
import type {
  ActiveMarkdownCapture,
  ObsidianHost,
  PreviewModalHandle,
} from "./host-adapter";
import { renderPreviewModal } from "./preview-modal";
import {
  initialPreviewState,
  reducePreviewState,
  type PreviewDocument,
  type PreviewState,
} from "./preview-state";

export interface BuiltPreview {
  readonly envelope: SealedExportPlanEnvelope;
  /** Exact worker output bytes; verified against plan.generatedMdx before use. */
  readonly generatedMdxBytes: Uint8Array;
}

export interface ApprovalRecapture {
  readonly sourceBytes: PlanSourceBytes;
  readonly fingerprint: ApprovalFingerprint;
}

export interface PreviewCommandDeps {
  readonly host: ObsidianHost;
  readonly createGenerationToken: () => GenerationToken;
  /**
   * Owns worker processing, pure planning, sealing, and private-store
   * publication. It must return only a verified, source-bound envelope.
   */
  readonly buildPreview: (
    capture: ActiveMarkdownCapture,
    onWorkerEvent: (event: DecodedWorkerEvent) => void,
  ) => Promise<MdxRelayResult<BuiltPreview>>;
  readonly cancelGeneration: (generationToken: GenerationToken) => void;
  /** Recaptures source bytes and the bounded target-folder snapshot. */
  readonly recaptureApproval: (
    plan: ExportPlan,
  ) => Promise<MdxRelayResult<ApprovalRecapture>>;
  readonly recordApproval: (
    planId: ExportPlan["planId"],
    sourceBytes: PlanSourceBytes,
  ) => Promise<MdxRelayResult<ExportPlan["planId"]>>;
  readonly applyApprovedWrites: (
    input: ApplyApprovedWritesInput,
  ) => Promise<ApplyApprovedWritesResult>;
}

interface ActiveSession {
  readonly generationToken: GenerationToken;
  modal: PreviewModalHandle;
  state: PreviewState;
  envelope?: SealedExportPlanEnvelope;
  closed: boolean;
}

const blockers = (
  result: MdxRelayResult<unknown>,
): readonly [BlockerIssue, ...BlockerIssue[]] => {
  if (result.ok) throw new TypeError("Expected a failed result.");
  const values = result.error.filter(
    (issue): issue is BlockerIssue => issue.severity === "blocker",
  );
  return values.length > 0
    ? (values as [BlockerIssue, ...BlockerIssue[]])
    : [createIssue(ISSUE_CODES.staleApproval) as BlockerIssue];
};

const deriveMdxDiff = (
  sourceNoteBytes: Uint8Array,
  generatedMdxBytes: Uint8Array,
): string | undefined => {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const source = decoder.decode(sourceNoteBytes);
    const generated = decoder.decode(generatedMdxBytes);
    const removed = source.split("\n").map((line) => `- ${line}`);
    const added = generated.split("\n").map((line) => `+ ${line}`);
    return ["--- source note", "+++ generated MDX", ...removed, ...added].join(
      "\n",
    );
  } catch {
    return undefined;
  }
};

const documentFor = (
  built: BuiltPreview,
  capture: ActiveMarkdownCapture,
): PreviewDocument | undefined => {
  const { plan } = built.envelope;
  if (
    capture.bytes.byteLength !== plan.sourceNote.byteLength ||
    sha256OfBytes(capture.bytes) !== plan.sourceNote.contentSha256 ||
    built.generatedMdxBytes.byteLength !== plan.generatedMdx.byteLength ||
    sha256OfBytes(built.generatedMdxBytes) !== plan.generatedMdx.contentSha256
  )
    return undefined;
  const mdxDiff = deriveMdxDiff(capture.bytes, built.generatedMdxBytes);
  if (mdxDiff === undefined) return undefined;

  const sourceByDigest = new Map(
    plan.sourceImages.map((image) => [
      image.transformedOutputSha256,
      image.sourceId,
    ]),
  );
  const assets: Array<PreviewDocument["assets"][number]> = [];
  if (plan.state === "ready") {
    for (const action of plan.actions) {
      if (action.documentOrder === 0) continue;
      assets.push(
        Object.freeze({
          sourceId:
            sourceByDigest.get(action.sealedOutput.contentSha256) ??
            `document-order-${action.documentOrder}`,
          targetPath: action.targetPath,
          contentSha256: action.sealedOutput.contentSha256,
          byteLength: action.sealedOutput.byteLength,
        }),
      );
    }
  } else {
    const imageDigests = new Set(
      plan.sourceImages.map((image) => image.transformedOutputSha256),
    );
    for (const target of plan.targetFolderSnapshot.targets) {
      if (
        target.priorState.state !== "regularFile" ||
        !imageDigests.has(target.priorState.contentSha256)
      )
        continue;
      const output = plan.blobs[target.priorState.contentSha256];
      assets.push(
        Object.freeze({
          sourceId:
            sourceByDigest.get(target.priorState.contentSha256) ??
            target.relativePath,
          targetPath: target.relativePath,
          contentSha256: target.priorState.contentSha256,
          byteLength: output?.byteLength ?? 0,
        }),
      );
    }
  }
  return Object.freeze({
    plan,
    mdxDiff,
    assets: Object.freeze(assets),
  });
};

/**
 * Owns one modal generation at a time. Every continuation rechecks the session
 * object plus generation and, after sealing, the exact rendered plan identity.
 */
export class PreviewCommand {
  private active: ActiveSession | undefined;
  private unloaded = false;

  constructor(private readonly deps: PreviewCommandDeps) {}

  execute(): void {
    if (this.unloaded) return;
    this.closeActive();
    const generationToken = this.deps.createGenerationToken();
    const session = {
      generationToken,
      state: initialPreviewState(generationToken),
      closed: false,
    } as ActiveSession;
    session.modal = this.deps.host.openModal(
      (element) => this.render(session, element),
      () => this.onModalClosed(session),
    );
    this.active = session;
    this.render(session);
    void this.captureAndBuild(session);
  }

  unload(): void {
    this.unloaded = true;
    this.closeActive();
  }

  private isActive(session: ActiveSession): boolean {
    return (
      !this.unloaded &&
      !session.closed &&
      this.active === session &&
      this.active.generationToken === session.generationToken
    );
  }

  private sameVisibleIdentity(
    session: ActiveSession,
    identity: PlanIdentity,
  ): boolean {
    return (
      this.isActive(session) &&
      "identity" in session.state &&
      session.state.identity.generationToken === identity.generationToken &&
      session.state.identity.planId === identity.planId &&
      session.envelope?.planId === identity.planId &&
      session.envelope.plan.generationToken === identity.generationToken
    );
  }

  private update(session: ActiveSession, state: PreviewState): void {
    if (!this.isActive(session)) return;
    session.state = state;
    this.render(session);
  }

  private render(
    session: ActiveSession,
    element = session.modal?.element,
  ): void {
    if (!this.isActive(session) || element === undefined) return;
    renderPreviewModal(element, session.state, {
      setApprovalEnabled: (enabled) => {
        if (!("identity" in session.state)) return;
        this.update(
          session,
          reducePreviewState(session.state, {
            type: "approval-toggle",
            identity: session.state.identity,
            enabled,
          }),
        );
      },
      approve: () => void this.approve(session),
      cancel: () => session.modal.close(),
    });
  }

  private async captureAndBuild(session: ActiveSession): Promise<void> {
    const captured = await this.deps.host.captureActiveMarkdown(
      session.generationToken,
    );
    if (!this.isActive(session)) return;
    if (!captured.ok) {
      this.update(
        session,
        reducePreviewState(session.state, {
          type: "blocked",
          generationToken: session.generationToken,
          issues: blockers(captured),
        }),
      );
      return;
    }

    this.update(
      session,
      reducePreviewState(session.state, {
        type: "processing",
        generationToken: session.generationToken,
      }),
    );
    const built = await this.deps.buildPreview(captured.value, (event) => {
      if (
        !this.isActive(session) ||
        event.generationToken !== session.generationToken
      )
        return;
      if (event.type === "started" || event.type === "progress")
        this.update(
          session,
          reducePreviewState(session.state, {
            type: "progress",
            generationToken: session.generationToken,
            progress:
              event.type === "started"
                ? `Processing ${event.imageCount} image(s)…`
                : `Processing image ${event.imageIndex + 1} of ${event.totalImages}…`,
          }),
        );
    });
    if (!this.isActive(session)) return;
    if (!built.ok) {
      this.update(
        session,
        reducePreviewState(session.state, {
          type: "blocked",
          generationToken: session.generationToken,
          issues: blockers(built),
        }),
      );
      return;
    }
    const envelope = built.value.envelope;
    if (
      !envelope.sourceBytesVerified ||
      envelope.plan.generationToken !== session.generationToken
    ) {
      this.update(
        session,
        reducePreviewState(session.state, {
          type: "blocked",
          generationToken: session.generationToken,
          issues: [
            createIssue(ISSUE_CODES.staleDuringPlanning) as BlockerIssue,
          ],
        }),
      );
      return;
    }
    const document = documentFor(built.value, captured.value);
    if (document === undefined) {
      this.update(
        session,
        reducePreviewState(session.state, {
          type: "blocked",
          generationToken: session.generationToken,
          issues: [
            createIssue(ISSUE_CODES.previewContentMismatch) as BlockerIssue,
          ],
        }),
      );
      return;
    }
    session.envelope = envelope;
    this.update(
      session,
      reducePreviewState(session.state, {
        type: "plan",
        generationToken: session.generationToken,
        document,
      }),
    );
  }

  private async approve(session: ActiveSession): Promise<void> {
    if (
      !this.isActive(session) ||
      (session.state.phase !== "ready" &&
        session.state.phase !== "no-changes") ||
      !session.state.approvalEnabled ||
      session.state.approving
    )
      return;
    const identity = session.state.identity;
    const envelope = session.envelope;
    if (
      envelope === undefined ||
      !envelope.sourceBytesVerified ||
      envelope.planId !== identity.planId
    )
      return;

    const started = reducePreviewState(session.state, {
      type: "approval-start",
      identity,
    });
    this.update(session, started);
    if (!this.sameVisibleIdentity(session, identity)) return;

    const recaptured = await this.deps.recaptureApproval(envelope.plan);
    if (!this.sameVisibleIdentity(session, identity)) return;
    if (!recaptured.ok) {
      this.finishFailedApproval(session, identity, blockers(recaptured));
      return;
    }

    const recorded = await this.deps.recordApproval(
      identity.planId,
      recaptured.value.sourceBytes,
    );
    if (!this.sameVisibleIdentity(session, identity)) return;
    if (!recorded.ok || recorded.value !== identity.planId) {
      this.finishFailedApproval(
        session,
        identity,
        recorded.ok
          ? [createIssue(ISSUE_CODES.approvalMismatch) as BlockerIssue]
          : blockers(recorded),
      );
      return;
    }

    const approval: ApprovalRecord = Object.freeze({ planId: identity.planId });
    let result: ApplyApprovedWritesResult;
    try {
      result = await this.deps.applyApprovedWrites({
        plan: envelope.plan,
        blobBytes: envelope.blobBytes,
        configuredTargetRoot:
          envelope.plan.targetFolderSnapshot.targetRootRealPath,
        approval,
        approvalTransition: identity,
        currentApprovalFingerprint: recaptured.value.fingerprint,
      });
    } catch {
      result = {
        ok: false,
        report: {
          completed: [],
          failed: [
            {
              targetPath: "",
              issue: createIssue(ISSUE_CODES.targetWriteFailed) as BlockerIssue,
            },
          ],
          unattempted: envelope.plan.actions.map((action) => action.targetPath),
        },
        error: [createIssue(ISSUE_CODES.targetWriteFailed) as BlockerIssue],
      };
    }
    if (!this.sameVisibleIdentity(session, identity)) return;
    this.update(
      session,
      reducePreviewState(session.state, {
        type: "write-result",
        identity,
        report: result.report,
        ...(!result.ok ? { issues: result.error } : {}),
      }),
    );
  }

  private finishFailedApproval(
    session: ActiveSession,
    identity: PlanIdentity,
    issues: readonly BlockerIssue[],
  ): void {
    this.update(
      session,
      reducePreviewState(session.state, {
        type: "write-result",
        identity,
        report: { completed: [], failed: [], unattempted: [] },
        issues,
      }),
    );
  }

  private onModalClosed(session: ActiveSession): void {
    if (session.closed) return;
    session.closed = true;
    this.deps.cancelGeneration(session.generationToken);
    if (this.active === session) this.active = undefined;
  }

  private closeActive(): void {
    const active = this.active;
    if (active === undefined) return;
    this.deps.cancelGeneration(active.generationToken);
    active.closed = true;
    if (this.active === active) this.active = undefined;
    active.modal.close();
  }
}
