import { isIsoTimestamp } from "./authority.js";
import {
  ExecutionId,
  ProjectId,
  parse,
  VerificationId,
  WorkId,
  WorkspaceId,
} from "./ids.js";
import { WorkRevision } from "./ordinals.js";

/** Independent identity; deliberately not an ExecutionEpisodeBinding. The
 * basis digest binds current authority/resource/host/provider provenance;
 * inputManifestRef must name durably retained actual captured input evidence. */
export interface VerificationSandboxBindingV1 {
  readonly version: 1;
  readonly kind: "IndependentVerification";
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly executionId: ExecutionId;
  readonly verificationId: VerificationId;
  readonly workId: WorkId;
  readonly targetWorkRevision: WorkRevision;
  readonly copySetId: string;
  readonly authorizationRevision: number;
  readonly sourceBasisDigest: string;
  readonly inputDigest: string;
  readonly inputManifestRef: string;
  readonly policyRevision: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export const encodeVerificationSandboxBindingV1 = (
  binding: VerificationSandboxBindingV1,
): string =>
  JSON.stringify({
    version: 1,
    kind: "IndependentVerification",
    projectId: binding.projectId,
    workspaceId: binding.workspaceId,
    executionId: binding.executionId,
    verificationId: binding.verificationId,
    workId: binding.workId,
    targetWorkRevision: binding.targetWorkRevision,
    copySetId: binding.copySetId,
    authorizationRevision: binding.authorizationRevision,
    sourceBasisDigest: binding.sourceBasisDigest,
    inputDigest: binding.inputDigest,
    inputManifestRef: binding.inputManifestRef,
    policyRevision: binding.policyRevision,
    issuedAt: binding.issuedAt,
    expiresAt: binding.expiresAt,
  });

/** Closed canonical bytes, no legacy fallback, path fields or unknown keys. */
export const decodeCanonicalVerificationSandboxBindingV1 = (
  json: string,
): VerificationSandboxBindingV1 | undefined => {
  if (json.length > 8192) return undefined;
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      value.version !== 1 ||
      value.kind !== "IndependentVerification" ||
      typeof value.copySetId !== "string" ||
      !/^vcp_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        value.copySetId,
      ) ||
      typeof value.authorizationRevision !== "number" ||
      !Number.isSafeInteger(value.authorizationRevision) ||
      value.authorizationRevision < 1 ||
      typeof value.targetWorkRevision !== "number" ||
      !Number.isSafeInteger(value.targetWorkRevision) ||
      value.targetWorkRevision < 0 ||
      typeof value.policyRevision !== "number" ||
      !Number.isSafeInteger(value.policyRevision) ||
      value.policyRevision < 1 ||
      typeof value.sourceBasisDigest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(value.sourceBasisDigest) ||
      typeof value.inputDigest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(value.inputDigest) ||
      typeof value.inputManifestRef !== "string" ||
      !/^blob:sha256:[0-9a-f]{64}$/u.test(value.inputManifestRef) ||
      typeof value.issuedAt !== "string" ||
      !isIsoTimestamp(value.issuedAt) ||
      typeof value.expiresAt !== "string" ||
      !isIsoTimestamp(value.expiresAt) ||
      Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)
    )
      return undefined;
    const binding: VerificationSandboxBindingV1 = {
      version: 1,
      kind: "IndependentVerification",
      projectId: parse(ProjectId)(value.projectId),
      workspaceId: parse(WorkspaceId)(value.workspaceId),
      executionId: parse(ExecutionId)(value.executionId),
      verificationId: parse(VerificationId)(value.verificationId),
      workId: parse(WorkId)(value.workId),
      targetWorkRevision: parse(WorkRevision)(value.targetWorkRevision),
      copySetId: value.copySetId,
      authorizationRevision: value.authorizationRevision,
      sourceBasisDigest: value.sourceBasisDigest,
      inputDigest: value.inputDigest,
      inputManifestRef: value.inputManifestRef,
      policyRevision: value.policyRevision,
      issuedAt: value.issuedAt,
      expiresAt: value.expiresAt,
    };
    return encodeVerificationSandboxBindingV1(binding) === json
      ? binding
      : undefined;
  } catch {
    return undefined;
  }
};
