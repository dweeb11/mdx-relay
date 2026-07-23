import type {
  ExportPlan,
  NoChangesExportPlan,
  PlanId,
  ReadyExportPlan,
  RepositoryTargetFingerprint,
  SealedOutput,
  Sha256Digest,
  VerifiedReadyExportPlan,
} from "../contracts/export-plan";
import { matchesApprovalContext } from "../contracts/export-plan";
import { createIssue, ISSUE_CODES } from "../contracts/issues";
import {
  mdxRelayErr,
  mdxRelayOk,
  type MdxRelayResult,
} from "../contracts/result";
import {
  deepEquals,
  isWellFormedUnicode,
  sha256OfBytes,
  sha256OfUtf8,
  verifySourceBytes,
  type ExportPlanDraft,
  type PlanSourceBytes,
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
 * Verification recomputes that ID, recomputes every snapshot, source and blob
 * digest from bytes, and re-runs the frozen approval-context gate before
 * anything is branded verified. Nothing that fails any step is ever returned.
 *
 * Source note and image bytes are never stored, so a plan restored from private
 * storage after a process or crash boundary carries structural proof only. It
 * becomes `sourceBytesVerified` -- and only then can it hold the frozen
 * `VerifiedReadyExportPlan` brand -- when a live capture supplies those bytes
 * again and every source fingerprint is recomputed from them.
 */

interface SealedExportPlanEnvelopeFields {
  readonly planId: PlanId;
  readonly identityManifest: string;
  readonly blobBytes: ReadonlyMap<string, Uint8Array>;
}

export type SealedExportPlanEnvelope =
  | Readonly<
      SealedExportPlanEnvelopeFields & {
        state: "ready";
        sourceBytesVerified: true;
        plan: VerifiedReadyExportPlan;
      }
    >
  | Readonly<
      SealedExportPlanEnvelopeFields & {
        state: "ready";
        sourceBytesVerified: false;
        plan: ReadyExportPlan;
      }
    >
  | Readonly<
      SealedExportPlanEnvelopeFields & {
        state: "no-changes";
        sourceBytesVerified: boolean;
        plan: NoChangesExportPlan;
      }
    >;

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalString = (value: string): string => {
  // RFC 8785 requires canonicalization to terminate on invalid Unicode rather
  // than emit an escape for a code unit that has no UTF-8 encoding.
  if (!isWellFormedUnicode(value))
    throw new TypeError("Lone UTF-16 surrogate in JSON string");
  return JSON.stringify(value);
};

/**
 * Own enumerable data properties in their own insertion order. Accessors, own
 * symbol keys and exotic prototypes are refused instead of being read: JCS
 * output has to be a function of JSON data alone, and a getter or a `toJSON`
 * would let the value being canonicalized choose its own manifest.
 */
const jsonDataKeys = (value: object): readonly string[] => {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError("Unsupported JSON object prototype");
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new TypeError("Symbol key in JSON object");
  const keys: string[] = [];
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!("value" in descriptor))
      throw new TypeError("Accessor in JSON object");
    if (descriptor.enumerable) keys.push(key);
    else throw new TypeError("Non-enumerable key in JSON object");
  }
  return keys;
};

/**
 * RFC 8785 JSON Canonicalization Scheme. Keys sort by UTF-16 code unit, strings
 * and numbers use the ECMAScript serializations JCS defers to, and anything
 * that is not well-formed finite JSON data throws rather than canonicalizing to
 * something an attacker could steer.
 */
export function canonicalizeJcs(value: unknown): string {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "string") return canonicalString(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite JSON number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("Unsupported JSON value");
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype)
      throw new TypeError("Unsupported JSON array prototype");
    // A hole is neither `null` nor a value and an extra named property is not
    // JSON data at all; both make the own-key count disagree with the length.
    if (Object.keys(value).length !== value.length)
      throw new TypeError("Hole or non-index key in JSON array");
    const entries: string[] = [];
    for (let index = 0; index < value.length; index += 1)
      entries.push(canonicalizeJcs(value[index]));
    return `[${entries.join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${[...jsonDataKeys(record)]
    .sort(compareCodeUnits)
    .map((key) => `${canonicalString(key)}:${canonicalizeJcs(record[key])}`)
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

/** The image digests must point at verified sealed image blobs, not just any blob. */
const hasVerifiedSourceImageTransforms = (
  candidate: Record<string, unknown>,
  blobs: Record<string, SealedOutput>,
): boolean => {
  const sourceImages = candidate.sourceImages;
  const commitMessage = candidate.commitMessage;
  const generatedMdx = candidate.generatedMdx;
  if (
    !Array.isArray(sourceImages) ||
    !isRecord(commitMessage) ||
    !isRecord(generatedMdx) ||
    typeof commitMessage.contentSha256 !== "string" ||
    typeof generatedMdx.contentSha256 !== "string"
  )
    return false;

  const sealedImageDigests = Object.values(blobs)
    .filter(
      (output: SealedOutput) =>
        output.contentSha256 !== commitMessage.contentSha256 &&
        output.contentSha256 !== generatedMdx.contentSha256,
    )
    .map((output: SealedOutput) => output.contentSha256 as Sha256Digest);

  const remaining = new Set(sealedImageDigests);
  for (const image of sourceImages) {
    const transformedOutputSha256 =
      isRecord(image) && typeof image.transformedOutputSha256 === "string"
        ? (image.transformedOutputSha256 as Sha256Digest)
        : undefined;
    if (transformedOutputSha256 === undefined || !remaining.has(transformedOutputSha256))
      return false;
    remaining.delete(transformedOutputSha256);
  }
  return remaining.size === 0;
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

/** Plan-relative synthetic targets used only by the no-changes probe below. */
const NO_CHANGES_PROBE_ROOT = "no-changes-probe/";

/**
 * No-changes plans carry no actions and no repository targets, so the frozen
 * ready-plan gate cannot be applied to them directly. Every other field has the
 * identical shape and the identical duplication rules, so verification runs
 * that gate over a probe which substitutes exactly and only the empty parts:
 * one synthetic create action per sealed output the candidate actually owns
 * plus the matching ordered repository targets, mirrored into the approval
 * fingerprint exactly as a ready plan mirrors its own. Everything else the
 * probe carries is the candidate's own data, so the frozen structural, digest,
 * duplicate-field, blob, ordering, issue, author and repository rules all apply
 * unchanged. The genuinely empty fields are checked separately.
 */
const noChangesProbe = (
  candidate: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  const { blobs, commitMessage } = candidate;
  const repository = candidate.repositoryFingerprint;
  const approval = candidate.approvalFingerprint;
  if (
    !isRecord(blobs) ||
    !isRecord(commitMessage) ||
    !isRecord(repository) ||
    !isRecord(approval)
  )
    return undefined;
  const outputs = (Object.values(blobs) as SealedOutput[])
    .filter((output) => output.contentSha256 !== commitMessage.contentSha256)
    .sort((left, right) =>
      compareCodeUnits(left.contentSha256, right.contentSha256),
    );
  const targets: RepositoryTargetFingerprint[] = outputs.map((_, index) => ({
    normalizedPath: `${NO_CHANGES_PROBE_ROOT}${String(index).padStart(4, "0")}.mdx`,
    symlinkStatus: "not-symlink",
    approvedPriorTarget: { state: "absent" },
  }));
  const probeRepository = { ...repository, targets };
  return {
    ...candidate,
    state: "ready",
    repositoryFingerprint: probeRepository,
    approvalFingerprint: {
      ...approval,
      repositoryFingerprint: probeRepository,
    },
    actions: outputs.map((sealedOutput, index) => ({
      kind: "create",
      documentOrder: index,
      targetPath: targets[index]!.normalizedPath,
      expectedGitMode: "100644",
      sealedOutput,
      sourceOccurrence: index,
      approvedPriorTarget: { state: "absent" },
    })),
  };
};

/** The two fields a no-changes plan must leave genuinely empty. */
const hasNoChangesEmptiness = (candidate: Record<string, unknown>): boolean => {
  const repository = candidate.repositoryFingerprint;
  return (
    Array.isArray(candidate.actions) &&
    candidate.actions.length === 0 &&
    isRecord(repository) &&
    Array.isArray(repository.targets) &&
    repository.targets.length === 0
  );
};

/**
 * Recomputes the source-note and every source-image fingerprint from the bytes
 * a live capture supplied. Duplicated metadata proves nothing here: only the
 * bytes do.
 */
const hasVerifiedSources = (
  candidate: Record<string, unknown>,
  sourceBytes: PlanSourceBytes,
): boolean => {
  const sourceNote = candidate.sourceNote;
  const sourceImages = candidate.sourceImages;
  if (
    !isRecord(sourceNote) ||
    !Array.isArray(sourceImages) ||
    typeof sourceNote.byteLength !== "number" ||
    typeof sourceNote.contentSha256 !== "string"
  )
    return false;
  const captured = [];
  for (const image of sourceImages) {
    if (
      !isRecord(image) ||
      typeof image.sourceId !== "string" ||
      typeof image.byteLength !== "number" ||
      typeof image.contentSha256 !== "string"
    )
      return false;
    captured.push({
      sourceId: image.sourceId,
      byteLength: image.byteLength,
      contentSha256: image.contentSha256 as Sha256Digest,
    });
  }
  return (
    verifySourceBytes(
      {
        byteLength: sourceNote.byteLength,
        contentSha256: sourceNote.contentSha256 as Sha256Digest,
      },
      captured,
      sourceBytes,
    ) === undefined
  );
};

/**
 * The one place a plan becomes trusted. Returns nothing at all unless every
 * recomputed digest, mirrored capture field, structural rule and the recomputed
 * plan ID agree with what the candidate claims. Supplying source bytes is what
 * earns `sourceBytesVerified`, and only that brands a ready plan; supplying
 * bytes that disagree with the plan fails the whole verification.
 */
const verifiedEnvelope = (
  candidate: unknown,
  blobBytes: ReadonlyMap<string, Uint8Array>,
  sourceBytes: PlanSourceBytes | undefined,
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
    !isWellFormedUnicode(candidate.profileSnapshot) ||
    !isWellFormedUnicode(candidate.dependencySnapshot) ||
    candidate.profileSnapshotSha256 !==
      sha256OfUtf8(candidate.profileSnapshot) ||
    candidate.dependencySnapshotSha256 !==
      sha256OfUtf8(candidate.dependencySnapshot) ||
    !hasVerifiedBlobs(candidate.blobs, blobBytes) ||
    !hasVerifiedSourceImageTransforms(candidate, candidate.blobs) ||
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
  const transition = { generationToken: candidate.generationToken, planId };
  const sealedUtc = String(candidate.createdAtUtc);
  if (candidate.state === "ready") {
    if (
      !matchesApprovalContext(
        candidate as unknown as VerifiedReadyExportPlan,
        transition,
        candidate.approvalFingerprint,
        sealedUtc,
      )
    )
      return undefined;
  } else if (candidate.state === "no-changes") {
    const probe = noChangesProbe(candidate);
    if (
      probe === undefined ||
      !hasNoChangesEmptiness(candidate) ||
      !matchesApprovalContext(
        probe as unknown as VerifiedReadyExportPlan,
        transition,
        probe.approvalFingerprint,
        sealedUtc,
      )
    )
      return undefined;
  } else return undefined;

  const sourceBytesVerified = sourceBytes !== undefined;
  if (sourceBytes !== undefined && !hasVerifiedSources(candidate, sourceBytes))
    return undefined;

  const plan = deepFreeze(candidate);
  if (candidate.state !== "ready")
    return Object.freeze({
      state: "no-changes" as const,
      sourceBytesVerified,
      planId,
      identityManifest,
      plan: plan as unknown as NoChangesExportPlan,
      blobBytes,
    });
  return Object.freeze(
    sourceBytesVerified
      ? {
          state: "ready" as const,
          sourceBytesVerified: true as const,
          planId,
          identityManifest,
          plan: plan as unknown as VerifiedReadyExportPlan,
          blobBytes,
        }
      : {
          state: "ready" as const,
          sourceBytesVerified: false as const,
          planId,
          identityManifest,
          plan: plan as unknown as ReadyExportPlan,
          blobBytes,
        },
  );
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
  const envelope = verifiedEnvelope(sealed, draft.blobBytes, draft.sourceBytes);
  return envelope?.sourceBytesVerified
    ? mdxRelayOk(envelope)
    : mdxRelayErr([createIssue(ISSUE_CODES.staleDuringPlanning)]);
}

/**
 * Load-time verifier for a plan restored from private storage. Anything that
 * does not verify is reported as tampering; a sound but elapsed plan is
 * reported as expired so the caller previews again instead of publishing.
 * Source bytes are optional because storage never holds them: a caller that
 * supplies the live bytes again gets a `sourceBytesVerified` envelope, and a
 * caller that does not gets structural proof alone and no brand.
 */
export function verifyStoredExportPlan(
  candidate: unknown,
  blobBytes: ReadonlyMap<string, Uint8Array>,
  currentUtc: string,
  sourceBytes?: PlanSourceBytes,
): MdxRelayResult<SealedExportPlanEnvelope> {
  const envelope = verifiedEnvelope(candidate, blobBytes, sourceBytes);
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
