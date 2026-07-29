import type { ExportPlan } from "../contracts/export-plan";
import { createIssue, ISSUE_CODES } from "../contracts/issues";
import {
  mdxRelayErr,
  mdxRelayOk,
  type MdxRelayResult,
} from "../contracts/result";
import type { ExportPlanDraft, UnsealedExportPlan } from "./build-export-plan";
import {
  buildPlanIdentityManifest,
  computePlanId,
  verifyPlanEnvelope,
  type SealedExportPlanEnvelope,
} from "./plan-verification";

/**
 * Sealing turns a derived draft into an identity-bearing plan.
 *
 *   draft -> RFC 8785 identity manifest -> plan ID -> structural verification
 *
 * The plan ID is the digest of the canonical manifest of every plan field
 * except the per-run generation token and the ID itself, so the same capture
 * always seals to the same ID while a stale generation never changes it.
 * Structural re-admission of the sealed candidate (and of hostile stored
 * documents) lives in `plan-verification.ts`; this module only constructs the
 * identity and crosses that seam before returning an envelope.
 */

export type { SealedExportPlanEnvelope } from "./plan-verification";
export {
  buildPlanIdentityManifest,
  computePlanId,
  verifyStoredExportPlan,
} from "./plan-verification";

/** Assigns the content-derived plan ID and refuses to return an unsound seal. */
export function sealExportPlan(
  draft: ExportPlanDraft,
): MdxRelayResult<SealedExportPlanEnvelope> {
  let identityManifest: string;
  try {
    identityManifest = buildPlanIdentityManifest(draft.plan);
  } catch {
    return mdxRelayErr([createIssue(ISSUE_CODES.staleDuringPlanning)]);
  }
  const sealed: ExportPlan = {
    ...(draft.plan as UnsealedExportPlan),
    planId: computePlanId(identityManifest),
  } as unknown as ExportPlan;
  const envelope = verifyPlanEnvelope(
    sealed,
    draft.blobBytes,
    draft.sourceBytes,
  );
  return envelope?.sourceBytesVerified
    ? mdxRelayOk(envelope)
    : mdxRelayErr([createIssue(ISSUE_CODES.staleDuringPlanning)]);
}
