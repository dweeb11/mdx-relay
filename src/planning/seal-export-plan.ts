import type {
  ExportPlan,
  NoChangesExportPlan,
  PlanId,
  SealedOutput,
  VerifiedReadyExportPlan,
} from "../contracts/export-plan";
import { matchesApprovalContext } from "../contracts/export-plan";
import { createIssue, isMdxRelayIssue, ISSUE_CODES } from "../contracts/issues";
import {
  mdxRelayErr,
  mdxRelayOk,
  type MdxRelayResult,
} from "../contracts/result";
import {
  deepEquals,
  sha256OfBytes,
  sha256OfUtf8,
  type ExportPlanDraft,
  type UnsealedExportPlan,
} from "./build-export-plan";

/**
 * Sealing turns a derived draft into an identity-bearing plan and is also the
 * only gate that re-admits a stored plan as trusted.
 *
 *   draft -> RFC 8785 identity manifest -> plan ID -> full verification -> seal
 *
 * The plan ID is the digest of the canonical manifest of every plan field
 * except the per-run generation token and the ID itself, so the same capture
 * always seals to the same ID while a stale generation never changes it.
 * Verification recomputes that ID, recomputes every snapshot and blob digest
 * from bytes, and re-runs the frozen approval-context gate before anything is
 * branded verified. Nothing that fails any step is ever returned.
 */

export type SealedExportPlanEnvelope =
  | Readonly<{
      state: "ready";
      planId: PlanId;
      identityManifest: string;
      plan: VerifiedReadyExportPlan;
      blobBytes: ReadonlyMap<string, Uint8Array>;
    }>
  | Readonly<{
      state: "no-changes";
      planId: PlanId;
      identityManifest: string;
      plan: NoChangesExportPlan;
      blobBytes: ReadonlyMap<string, Uint8Array>;
    }>;

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * RFC 8785 JSON Canonicalization Scheme. Keys sort by UTF-16 code unit, strings
 * and numbers use the ECMAScript serializations JCS defers to, and anything
 * that is not finite JSON data throws rather than canonicalizing to something
 * an attacker could steer.
 */
export function canonicalizeJcs(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalizeJcs(entry)).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Unsupported JSON value");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJcs(record[key])}`)
    .join(",")}}`;
}

/** The canonical identity of a plan: every field except generation and ID. */
export function buildPlanIdentityManifest(plan: object): string {
  const identity: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(plan))
    if (key !== "generationToken" && key !== "planId") identity[key] = value;
  return canonicalizeJcs(identity);
}

export function computePlanId(identityManifest: string): PlanId {
  return `plan-${sha256OfUtf8(identityManifest).slice("sha256:".length)}` as PlanId;
}

const CONTENT_ADDRESSED_PATH = /^[0-9a-f]{64}$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isIsoUtc = (value: unknown): value is string => {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
};

const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value))
    return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
};

/**
 * Re-derives every sealed output from its bytes. Blob paths are the lowercase
 * hex of their own digest, so a verified plan can only name single-segment
 * content-addressed files and the store never has to trust a path.
 */
const hasVerifiedBlobs = (
  blobs: unknown,
  blobBytes: ReadonlyMap<string, Uint8Array>,
): blobs is Record<string, SealedOutput> => {
  if (!isRecord(blobs)) return false;
  const entries = Object.entries(blobs);
  if (entries.length !== blobBytes.size) return false;
  return entries.every(([recordKey, output]) => {
    if (
      !isRecord(output) ||
      typeof output.planRelativePath !== "string" ||
      !CONTENT_ADDRESSED_PATH.test(output.planRelativePath)
    )
      return false;
    const bytes = blobBytes.get(output.planRelativePath);
    if (!bytes) return false;
    const digest = sha256OfBytes(bytes);
    return (
      recordKey === digest &&
      output.contentSha256 === digest &&
      output.byteLength === bytes.byteLength &&
      output.planRelativePath === digest.slice("sha256:".length)
    );
  });
};

/** Every duplicated capture field must equal the approval fingerprint exactly. */
const mirrorsApprovalCapture = (plan: Record<string, unknown>): boolean => {
  const approval = plan.approvalFingerprint;
  const sourceNote = plan.sourceNote;
  const blobs = plan.blobs;
  if (!isRecord(approval) || !isRecord(sourceNote) || !isRecord(blobs))
    return false;
  if (
    approval.profileSnapshotSha256 !== plan.profileSnapshotSha256 ||
    approval.dependencySnapshotSha256 !== plan.dependencySnapshotSha256 ||
    !deepEquals(approval.sourceNote, {
      byteLength: sourceNote.byteLength,
      contentSha256: sourceNote.contentSha256,
    }) ||
    !deepEquals(approval.repositoryFingerprint, plan.repositoryFingerprint) ||
    !Array.isArray(plan.sourceImages) ||
    !deepEquals(
      approval.sourceImages,
      plan.sourceImages.map((image: Record<string, unknown>) => ({
        sourceId: image.sourceId,
        byteLength: image.byteLength,
        contentSha256: image.contentSha256,
        transformedOutputSha256: image.transformedOutputSha256,
      })),
    )
  )
    return false;
  const orderedOutputs = Object.values(blobs).sort((left, right) =>
    compareCodeUnits(
      (left as SealedOutput).planRelativePath,
      (right as SealedOutput).planRelativePath,
    ),
  );
  return deepEquals(approval.sealedOutputs, orderedOutputs);
};

const isNoChangesPlanShape = (plan: Record<string, unknown>): boolean => {
  const blobs = plan.blobs as Record<string, SealedOutput>;
  const repository = plan.repositoryFingerprint;
  const generatedMdx = plan.generatedMdx;
  const commitMessage = plan.commitMessage;
  return (
    Array.isArray(plan.actions) &&
    plan.actions.length === 0 &&
    isRecord(repository) &&
    Array.isArray(repository.targets) &&
    repository.targets.length === 0 &&
    isRecord(generatedMdx) &&
    isRecord(commitMessage) &&
    deepEquals(blobs[String(generatedMdx.contentSha256)], generatedMdx) &&
    deepEquals(blobs[String(commitMessage.contentSha256)], commitMessage) &&
    deepEquals(
      plan.author,
      (repository as Record<string, unknown>).canonicalCommitAuthor,
    ) &&
    Array.isArray(plan.issues) &&
    plan.issues.every(
      (issue) => isMdxRelayIssue(issue) && issue.severity === "warning",
    ) &&
    isIsoUtc(plan.createdAtUtc) &&
    isIsoUtc(plan.expiresAtUtc) &&
    Date.parse(String(plan.createdAtUtc)) <
      Date.parse(String(plan.expiresAtUtc))
  );
};

/**
 * The one place a plan becomes trusted. Returns nothing at all unless every
 * recomputed digest, mirrored capture field, structural rule and the recomputed
 * plan ID agree with what the candidate claims.
 */
const verifiedEnvelope = (
  candidate: unknown,
  blobBytes: ReadonlyMap<string, Uint8Array>,
): SealedExportPlanEnvelope | undefined => {
  if (
    !isRecord(candidate) ||
    typeof candidate.planId !== "string" ||
    candidate.planId.length === 0 ||
    typeof candidate.generationToken !== "string" ||
    candidate.generationToken.length === 0 ||
    candidate.schemaVersion !== 1 ||
    typeof candidate.profileSnapshot !== "string" ||
    typeof candidate.dependencySnapshot !== "string" ||
    candidate.profileSnapshotSha256 !==
      sha256OfUtf8(candidate.profileSnapshot) ||
    candidate.dependencySnapshotSha256 !==
      sha256OfUtf8(candidate.dependencySnapshot) ||
    !hasVerifiedBlobs(candidate.blobs, blobBytes) ||
    !mirrorsApprovalCapture(candidate)
  )
    return undefined;

  let identityManifest: string;
  try {
    identityManifest = buildPlanIdentityManifest(candidate);
  } catch {
    return undefined;
  }
  if (computePlanId(identityManifest) !== candidate.planId) return undefined;

  const planId = candidate.planId as PlanId;
  if (candidate.state === "ready") {
    if (
      !matchesApprovalContext(
        candidate as unknown as VerifiedReadyExportPlan,
        { generationToken: candidate.generationToken, planId },
        candidate.approvalFingerprint,
        String(candidate.createdAtUtc),
      )
    )
      return undefined;
    return Object.freeze({
      state: "ready" as const,
      planId,
      identityManifest,
      plan: deepFreeze(candidate) as unknown as VerifiedReadyExportPlan,
      blobBytes,
    });
  }
  if (candidate.state !== "no-changes" || !isNoChangesPlanShape(candidate))
    return undefined;
  return Object.freeze({
    state: "no-changes" as const,
    planId,
    identityManifest,
    plan: deepFreeze(candidate) as unknown as NoChangesExportPlan,
    blobBytes,
  });
};

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
  const envelope = verifiedEnvelope(sealed, draft.blobBytes);
  return envelope
    ? mdxRelayOk(envelope)
    : mdxRelayErr([createIssue(ISSUE_CODES.staleDuringPlanning)]);
}

/**
 * Load-time verifier for a plan restored from private storage. Anything that
 * does not verify is reported as tampering; a sound but elapsed plan is
 * reported as expired so the caller previews again instead of publishing.
 */
export function verifyStoredExportPlan(
  candidate: unknown,
  blobBytes: ReadonlyMap<string, Uint8Array>,
  currentUtc: string,
): MdxRelayResult<SealedExportPlanEnvelope> {
  const envelope = verifiedEnvelope(candidate, blobBytes);
  if (
    !envelope ||
    !isIsoUtc(currentUtc) ||
    Date.parse(currentUtc) < Date.parse(envelope.plan.createdAtUtc)
  )
    return mdxRelayErr([createIssue(ISSUE_CODES.storageTampered)]);
  if (Date.parse(currentUtc) >= Date.parse(envelope.plan.expiresAtUtc))
    return mdxRelayErr([createIssue(ISSUE_CODES.planExpired)]);
  return mdxRelayOk(envelope);
}
