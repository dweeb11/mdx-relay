import type {
  Sha256Digest,
  ValidatedPortableProfileSnapshot,
} from "../contracts/export-plan";
import { createIssue, ISSUE_CODES } from "../contracts/issues";
import {
  mdxRelayErr,
  mdxRelayOk,
  type MdxRelayResult,
} from "../contracts/result";
import { validateMachineBinding } from "./machine-binding";
import { validatePortableProfile } from "./portable-profile";
import type { PortableProfileV1 } from "./profile-schema";

export interface ResolvedProfile {
  readonly portableProfile: PortableProfileV1;
  readonly portableSnapshot: ValidatedPortableProfileSnapshot;
  readonly profileSnapshotSha256: Sha256Digest;
  readonly repositoryRoot: string;
  readonly repositoryUrl: string;
  readonly machineBindingFingerprint: Sha256Digest;
}

export function resolveProfile(
  portableProfile: unknown,
  machineBinding: unknown,
): MdxRelayResult<ResolvedProfile> {
  const portableResult = validatePortableProfile(portableProfile);
  if (!portableResult.ok) return portableResult;
  const bindingResult = validateMachineBinding(machineBinding);
  if (!bindingResult.ok) return bindingResult;
  if (bindingResult.value.binding.profileId !== portableResult.value.profile.id)
    return mdxRelayErr([createIssue(ISSUE_CODES.invalidProfile)]);
  return mdxRelayOk(
    Object.freeze({
      portableProfile: portableResult.value.profile,
      portableSnapshot: portableResult.value.snapshot,
      profileSnapshotSha256: portableResult.value.profileSnapshotSha256,
      repositoryRoot: bindingResult.value.binding.repositoryRoot,
      repositoryUrl: bindingResult.value.binding.repositoryUrl,
      machineBindingFingerprint: bindingResult.value.fingerprint,
    }),
  );
}
