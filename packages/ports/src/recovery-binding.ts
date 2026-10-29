import type {
  CanonicalResourceRegion,
  ExecutionId,
  ProviderTurnId,
  ToolInvocationId,
} from "@arbor/domain";
import { canonicalRegionString } from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { RepositoryFailure } from "./errors.js";
import { sha256Hex } from "./provider-extension.js";
import type { TransactionScope } from "./session.js";

export type RecoveryBindingJsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<RecoveryBindingJsonValue>
  | { readonly [key: string]: RecoveryBindingJsonValue };

export const RECOVERY_BINDING_V1_KEYS = [
  "bindingVersion",
  "digestAlgorithm",
  "executionId",
  "invocationId",
  "providerTurnId",
  "logicalStepNo",
  "repairAttempt",
  "logicalActionId",
  "actionIndex",
  "callRef",
  "toolName",
  "toolVersion",
  "toolDefinitionHash",
  "sideEffectSemantics",
  "canonicalArgumentsDigest",
  "targetResourceIdentityDigest",
  "resourceBoundaryRevision",
  "environmentRevision",
  "authoritySourceRevision",
  "principalId",
  "capability",
  "permissionGrantRevisions",
  "workspacePolicyRevision",
  "projectPolicyRevision",
  "controlBasisDigest",
  "approvalId",
  "approvalSubject",
  "approvalPreConsumeRevision",
  "approvalConsumedRevision",
  "approvalExpiresAt",
  "approvalTargetDigest",
  "approvalActionDigest",
  "approvalConsumedBy",
  "profileId",
  "profileVersion",
  "profileHash",
  "profileProtocol",
  "effectKey",
] as const;

export interface RecoveryBindingV1 {
  readonly bindingVersion: 1;
  readonly digestAlgorithm: "SHA-256";
  readonly executionId: ExecutionId;
  readonly invocationId: ToolInvocationId;
  readonly providerTurnId: ProviderTurnId;
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
  readonly logicalActionId: string;
  readonly actionIndex: number;
  readonly callRef: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly toolDefinitionHash: string;
  readonly sideEffectSemantics:
    | "ReadOnly"
    | "Idempotent"
    | "Reconcilable"
    | "NonIdempotent";
  readonly canonicalArgumentsDigest: string;
  readonly targetResourceIdentityDigest: string;
  readonly resourceBoundaryRevision: number;
  readonly environmentRevision: string;
  readonly authoritySourceRevision: string | null;
  readonly principalId: string;
  readonly capability: string | ReadonlyArray<string> | null;
  readonly permissionGrantRevisions: ReadonlyArray<
    readonly [permissionGrantId: string, revision: number | null]
  >;
  readonly workspacePolicyRevision: number;
  readonly projectPolicyRevision: number;
  readonly controlBasisDigest: string;
  readonly approvalId: string | null;
  readonly approvalSubject: string | null;
  readonly approvalPreConsumeRevision: number | null;
  readonly approvalConsumedRevision: number | null;
  readonly approvalExpiresAt: string | null;
  readonly approvalTargetDigest: string | null;
  readonly approvalActionDigest: string | null;
  readonly approvalConsumedBy: ToolInvocationId | null;
  readonly profileId: string | null;
  readonly profileVersion: string | null;
  readonly profileHash: string | null;
  readonly profileProtocol: string | null;
  readonly effectKey: string | null;
}

const verifiedRecoveryBindingBrand: unique symbol = Symbol(
  "verifiedRecoveryBindingV1",
);

/** Only the P39 verifier constructs this proof-carrying binding value. */
export interface VerifiedRecoveryBindingV1 {
  readonly value: RecoveryBindingV1;
  readonly canonicalJson: string;
  readonly bindingSha256: string;
  readonly [verifiedRecoveryBindingBrand]: true;
}

const canonicalJsonV1 = (value: unknown): string => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("RecoveryBindingV1 rejects non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonV1).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => {
        const item = record[key];
        if (item === undefined) {
          throw new TypeError("RecoveryBindingV1 rejects undefined values");
        }
        return `${JSON.stringify(key)}:${canonicalJsonV1(item)}`;
      })
      .join(",")}}`;
  }
  throw new TypeError("RecoveryBindingV1 is not canonical JSON");
};

const isSha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/**
 * P38's accepted `InvocationApproval.actionDigest` codec is the exact
 * eight-character lowercase FNV-1a token produced by Tool Runtime. The
 * accepted P38/P39 projection stores this receipt value verbatim in
 * `approvalActionDigest`; it is not a SHA-256 projection.
 */
export const isP38InvocationApprovalActionDigestV1 = (
  value: unknown,
): value is string => typeof value === "string" && /^[0-9a-f]{8}$/.test(value);

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const hasExactKeys = (value: Record<string, unknown>): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...RECOVERY_BINDING_V1_KEYS].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};

const isPermissionGrantRevisions = (value: unknown): boolean => {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      entry[0].length === 0 ||
      seen.has(entry[0]) ||
      (entry[1] !== null && !isNonNegativeInteger(entry[1]))
    ) {
      return false;
    }
    seen.add(entry[0]);
  }
  return true;
};

const isRecoveryBindingV1 = (value: unknown): value is RecoveryBindingV1 => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    hasExactKeys(record) &&
    record.bindingVersion === 1 &&
    record.digestAlgorithm === "SHA-256" &&
    typeof record.executionId === "string" &&
    typeof record.invocationId === "string" &&
    typeof record.providerTurnId === "string" &&
    isNonNegativeInteger(record.logicalStepNo) &&
    isNonNegativeInteger(record.repairAttempt) &&
    typeof record.logicalActionId === "string" &&
    isNonNegativeInteger(record.actionIndex) &&
    typeof record.callRef === "string" &&
    typeof record.toolName === "string" &&
    typeof record.toolVersion === "string" &&
    isSha256(record.toolDefinitionHash) &&
    (record.sideEffectSemantics === "ReadOnly" ||
      record.sideEffectSemantics === "Idempotent" ||
      record.sideEffectSemantics === "Reconcilable" ||
      record.sideEffectSemantics === "NonIdempotent") &&
    isSha256(record.canonicalArgumentsDigest) &&
    isSha256(record.targetResourceIdentityDigest) &&
    isNonNegativeInteger(record.resourceBoundaryRevision) &&
    typeof record.environmentRevision === "string" &&
    isNullableString(record.authoritySourceRevision) &&
    typeof record.principalId === "string" &&
    (isNullableString(record.capability) ||
      (Array.isArray(record.capability) &&
        record.capability.every((value) => typeof value === "string"))) &&
    isPermissionGrantRevisions(record.permissionGrantRevisions) &&
    isNonNegativeInteger(record.workspacePolicyRevision) &&
    isNonNegativeInteger(record.projectPolicyRevision) &&
    isSha256(record.controlBasisDigest) &&
    isNullableString(record.approvalId) &&
    isNullableString(record.approvalSubject) &&
    (record.approvalPreConsumeRevision === null ||
      isNonNegativeInteger(record.approvalPreConsumeRevision)) &&
    (record.approvalConsumedRevision === null ||
      isNonNegativeInteger(record.approvalConsumedRevision)) &&
    isNullableString(record.approvalExpiresAt) &&
    (record.approvalTargetDigest === null ||
      isSha256(record.approvalTargetDigest)) &&
    (record.approvalActionDigest === null ||
      isP38InvocationApprovalActionDigestV1(record.approvalActionDigest)) &&
    isNullableString(record.approvalConsumedBy) &&
    isNullableString(record.profileId) &&
    isNullableString(record.profileVersion) &&
    (record.profileHash === null || isSha256(record.profileHash)) &&
    isNullableString(record.profileProtocol) &&
    isNullableString(record.effectKey) &&
    (() => {
      const approvalFields = [
        record.approvalId,
        record.approvalSubject,
        record.approvalPreConsumeRevision,
        record.approvalConsumedRevision,
        record.approvalExpiresAt,
        record.approvalTargetDigest,
        record.approvalActionDigest,
        record.approvalConsumedBy,
      ];
      return (
        approvalFields.every((field) => field === null) ||
        approvalFields.every((field) => field !== null)
      );
    })() &&
    (() => {
      const profileFields = [
        record.profileId,
        record.profileVersion,
        record.profileHash,
        record.profileProtocol,
        record.effectKey,
      ];
      return (
        profileFields.every((field) => field === null) ||
        profileFields.every((field) => field !== null)
      );
    })()
  );
};

export const canonicalizeRecoveryBindingV1 = (
  value: RecoveryBindingV1,
): string => {
  if (!isRecoveryBindingV1(value)) {
    throw new TypeError("RecoveryBindingV1 has an invalid closed schema");
  }
  return canonicalJsonV1(value);
};

export const recoveryBindingV1Digest = (value: RecoveryBindingV1): string =>
  sha256Hex(canonicalizeRecoveryBindingV1(value));

/** P39 stores the registry's stable definition identity token as a SHA-256
 * digest in the closed RecoveryBindingV1 field. This preserves the token's
 * identity without treating registry-specific tokens as digest bytes. */
export const toolDefinitionIdentityDigestV1 = (
  identityToken: string,
): string => {
  if (identityToken.trim().length === 0) {
    throw new TypeError("Tool definition identity token is empty");
  }
  return sha256Hex(identityToken);
};

export const canonicalArgumentsDigestV1 = (value: unknown): string =>
  sha256Hex(canonicalJsonV1(value));

export const approvalTargetDigestV1 = (
  targetResourceSpaceIds: ReadonlyArray<string>,
): string => {
  if (!targetResourceSpaceIds.every((value) => typeof value === "string")) {
    throw new TypeError("approval target IDs must be strings");
  }
  return sha256Hex(
    canonicalJsonV1({ targetResourceSpaceIds: [...targetResourceSpaceIds] }),
  );
};

export const targetResourceIdentityDigestV1 = (
  regions: ReadonlyArray<CanonicalResourceRegion>,
): string =>
  sha256Hex(
    canonicalJsonV1({
      regions: regions.map((region) => canonicalRegionString(region)),
    }),
  );

/** Parse and authenticate persisted P39 V1 bytes before exposing a binding. */
export const verifyRecoveryBindingV1 = (input: {
  readonly invocationId: ToolInvocationId;
  readonly canonicalJson: string;
  readonly bindingSha256: string;
}): VerifiedRecoveryBindingV1 | null => {
  if (!isSha256(input.bindingSha256)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.canonicalJson);
  } catch {
    return null;
  }
  if (!isRecoveryBindingV1(parsed)) return null;
  if (parsed.invocationId !== input.invocationId) return null;
  let canonical: string;
  try {
    canonical = canonicalJsonV1(parsed);
  } catch {
    return null;
  }
  if (
    canonical !== input.canonicalJson ||
    sha256Hex(canonical) !== input.bindingSha256
  ) {
    return null;
  }
  return {
    value: parsed,
    canonicalJson: canonical,
    bindingSha256: input.bindingSha256,
    [verifiedRecoveryBindingBrand]: true,
  };
};

export interface SelectedP39EffectAttempt {
  readonly invocationId: ToolInvocationId;
  readonly attemptNo: 0 | 1;
  readonly admissionState: "NotAdmitted" | "MayHaveStarted" | "LegacyUnknown";
  readonly bindingSha256: string | null;
  readonly toolDefinitionHash: string | null;
  readonly sideEffectSemantics:
    | "ReadOnly"
    | "Idempotent"
    | "Reconcilable"
    | "NonIdempotent";
  readonly profileId: string | null;
  readonly profileVersion: string | null;
  readonly profileHash: string | null;
  readonly profileProtocol: string | null;
  readonly effectKey: string | null;
  readonly admittedAt: string | null;
  readonly admissionSource: "P36Backfill" | "P39Claim" | "P39Admission";
  readonly admissionTimePrecision:
    | "NotAdmitted"
    | "TransactionTimestamp"
    | "UnknownLegacy";
}

export interface SelectedP39ReconciliationFact {
  readonly factId: string;
  readonly invocationId: ToolInvocationId;
  readonly attemptNo: 0 | 1;
  readonly bindingSha256: string | null;
  readonly profileHash: string | null;
  readonly effectKey: string | null;
  readonly factOrigin: "ProfileReconciliation" | "P36LegacyUnprofiled";
  readonly legacyReason: "LegacyProfileUnavailable" | null;
  readonly factDisposition: "RecoveryInput" | "PostTerminalEvidence";
  readonly outcome: "NotOccurred" | "Occurred" | "StillUnknown";
  readonly reasonCode: string | null;
  readonly evidenceRef: string | null;
  readonly evidenceSha256: string | null;
  readonly resultRef: string | null;
  readonly observedAt: string;
}

export interface SelectedP39RecoveryEvidence {
  readonly binding: VerifiedRecoveryBindingV1;
  readonly attempt: SelectedP39EffectAttempt;
  readonly fact: SelectedP39ReconciliationFact;
}

export interface P39RecoveryEvidenceStoreService {
  /** Inserts the immutable V1 binding and attempt-0 NotAdmitted row, then
   * changes the same invocation to Bound. The caller provides the surrounding
   * fenced TransactionScope that also records intent and consumes approval. */
  readonly bindClaim: (input: {
    readonly binding: RecoveryBindingV1;
    readonly createdAt: string;
  }) => Effect.Effect<
    "Bound" | "AlreadyBound",
    RepositoryFailure<"P39RecoveryEvidenceStore">,
    TransactionScope
  >;
  /** Returns the latest exact bound attempt, including a not-yet-settled
   * attempt that recovery must reconcile before any Executor call. */
  readonly findLatestAttempt: (
    invocationId: ToolInvocationId,
  ) => Effect.Effect<
    Option.Option<SelectedP39EffectAttempt>,
    RepositoryFailure<"P39RecoveryEvidenceStore">,
    TransactionScope
  >;
  /** Marks the claimed attempt 0 as MayHaveStarted in the same fenced
   * transaction as ToolInvocationStore.admitEffect. */
  readonly admitFirstAttempt: (
    invocationId: ToolInvocationId,
    admittedAt: string,
  ) => Effect.Effect<
    void,
    RepositoryFailure<"P39RecoveryEvidenceStore">,
    TransactionScope
  >;
  /** Creates attempt 1 only from an exact attempt-0 authoritative
   * NotOccurred RecoveryInput fact. Caller owns current Worker/authority/
   * resource/approval/Stop gates in the surrounding transaction. */
  readonly admitRetryAttempt: (input: {
    readonly invocationId: ToolInvocationId;
    readonly factId: string;
    readonly admittedAt: string;
  }) => Effect.Effect<
    void,
    RepositoryFailure<"P39RecoveryEvidenceStore">,
    TransactionScope
  >;
  /** Read-only terminal storage projection for a P4 no-effect Denied that
   * committed before any P39 binding claim. This marker is never recovery
   * evidence and carries no authority or denial reason. */
  readonly findTerminalUnboundDenial: (
    invocationId: ToolInvocationId,
  ) => Effect.Effect<
    Option.Option<{
      readonly invocationId: ToolInvocationId;
      readonly recoveryBindingState: "DeniedUnbound";
    }>,
    RepositoryFailure<"P39RecoveryEvidenceStore">,
    TransactionScope
  >;
  /** Read-only replay lookup. Persisted canonical bytes and digest are checked
   * before any binding is exposed to a caller. */
  readonly findBinding: (
    invocationId: ToolInvocationId,
  ) => Effect.Effect<
    Option.Option<VerifiedRecoveryBindingV1>,
    RepositoryFailure<"P39RecoveryEvidenceStore">,
    TransactionScope
  >;
  /** Returns only the exact terminal selected tuple after V1 bytes/hash and
   * invocation/attempt/fact provenance have been validated by P39. */
  readonly findSelected: (
    invocationId: ToolInvocationId,
  ) => Effect.Effect<
    Option.Option<SelectedP39RecoveryEvidence>,
    RepositoryFailure<"P39RecoveryEvidenceStore">,
    TransactionScope
  >;
}

export class P39RecoveryEvidenceStore extends Context.Service<
  P39RecoveryEvidenceStore,
  P39RecoveryEvidenceStoreService
>()("arbor/P39RecoveryEvidenceStore") {}
