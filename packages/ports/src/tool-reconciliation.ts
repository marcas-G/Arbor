import type { ToolInvocationId } from "@arbor/domain";
import { Context, type Effect } from "effect";
import type { RepositoryFailure } from "./errors.js";
import { sha256Hex } from "./provider-extension.js";
import type { TransactionScope } from "./session.js";

export type ReconciliationUnknownCode =
  | "ProfileUnavailable"
  | "EffectIdentityUnavailable"
  | "ExternalSourceUnavailable"
  | "ExternalSourceNotAuthoritative"
  | "EvidenceStale"
  | "EvidenceBindingMismatch"
  | "AttemptNotFinal"
  | "ResultEvidenceUnavailable"
  | "ProfileVersionUnavailable";

/** Evidence that the named attempt can no longer take effect after the
 * observation. An empty lookup or timeout is deliberately not representable. */
export type AttemptFinality =
  | {
      readonly _tag: "ExternallyFenced";
      readonly confirmationRef: string;
      readonly confirmedAt: string;
    }
  | {
      readonly _tag: "CancellationConfirmed";
      readonly confirmationRef: string;
      readonly confirmedAt: string;
    }
  | {
      readonly _tag: "TerminallyRejected";
      readonly rejectionRef: string;
      readonly rejectedAt: string;
    }
  | {
      readonly _tag: "FinalityHorizonElapsed";
      readonly horizon: string;
      readonly elapsedAt: string;
    };

/** Versioned external-source evidence bound to one exact effect attempt. */
export interface ReconciliationProofRef {
  readonly invocationId: ToolInvocationId;
  readonly attemptNo: 0 | 1;
  readonly bindingSha256: string;
  readonly profileHash: string;
  readonly effectKey: string;
  readonly sourceRevision: string;
  readonly sourceWatermark: string;
  readonly observedAt: string;
  readonly visibilityScopeSha256: string;
  readonly evidenceRef: string;
  readonly evidenceSha256: string;
  readonly finality: AttemptFinality;
}

export type ToolReconciliationResult =
  | { readonly _tag: "NotOccurred"; readonly proof: ReconciliationProofRef }
  | {
      readonly _tag: "Occurred";
      readonly proof: ReconciliationProofRef;
      readonly settlement: "Success" | "ExpectedFailure";
      readonly resultRef: string;
    }
  | {
      readonly _tag: "StillUnknown";
      readonly reasonCode: ReconciliationUnknownCode;
      readonly evidenceRef: string | null;
    };

export interface ToolReconciliationRequest {
  readonly invocationId: ToolInvocationId;
  readonly attemptNo: 0 | 1;
  readonly bindingSha256: string;
  readonly profileHash: string;
  readonly effectKey: string;
  /** Digest of the exact external visibility scope from RecoveryBinding. */
  readonly visibilityScopeSha256: string;
}

export interface ToolReconciliationError {
  readonly _tag: "ToolReconciliationError";
  readonly cause: unknown;
}

export interface ToolReconciliationPortService {
  /** Queries/confirm/cancel/fence only. This port must never call an executor. */
  readonly reconcile: (
    request: ToolReconciliationRequest,
  ) => Effect.Effect<ToolReconciliationResult, ToolReconciliationError>;
}

export class ToolReconciliationPort extends Context.Service<
  ToolReconciliationPort,
  ToolReconciliationPortService
>()("arbor/ToolReconciliationPort") {}

/** Composition-owned proof capability. Provider output can select only a
 * registered ToolDefinitionRef; profile identity and effect keys stay trusted
 * Runtime facts. */
export interface ToolReconciliationProfile {
  readonly toolName: string;
  readonly toolVersion: string;
  readonly toolDefinitionHash: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly profileHash: string;
  readonly profileProtocol: string;
  readonly effectKey: (input: {
    readonly invocationId: ToolInvocationId;
    readonly argumentsJson: string;
  }) => string | null;
  /** Decodes the trusted result Artifact into the canonical P4 observation.
   * No workspace-state inference is permitted. */
  readonly reconstructOccurred: (input: {
    readonly bytes: Uint8Array;
    readonly settlement: "Success" | "ExpectedFailure";
  }) => {
    readonly settlement: "Success" | "ExpectedFailure";
    readonly observation: {
      readonly text: string;
      readonly truncated: boolean;
    };
  } | null;
}

export interface ToolReconciliationProfileRegistryService {
  readonly resolve: (input: {
    readonly toolName: string;
    readonly toolVersion: string;
    readonly toolDefinitionHash: string;
  }) => ToolReconciliationProfile | undefined;
}

export class ToolReconciliationProfileRegistry extends Context.Service<
  ToolReconciliationProfileRegistry,
  ToolReconciliationProfileRegistryService
>()("arbor/ToolReconciliationProfileRegistry") {}

export const makeToolReconciliationProfileRegistry = (
  profiles: ReadonlyArray<ToolReconciliationProfile>,
): ToolReconciliationProfileRegistryService => {
  const byDescriptor = new Map<string, ToolReconciliationProfile>();
  for (const profile of profiles) {
    if (
      !profile.toolName.trim() ||
      !profile.toolVersion.trim() ||
      !profile.toolDefinitionHash.trim() ||
      !profile.profileId.trim() ||
      !profile.profileVersion.trim() ||
      !/^[0-9a-f]{64}$/u.test(profile.profileHash) ||
      !profile.profileProtocol.trim() ||
      typeof profile.effectKey !== "function" ||
      typeof profile.reconstructOccurred !== "function"
    ) {
      throw new TypeError("incomplete trusted ToolReconciliationProfile");
    }
    const key = `${profile.toolName}\u0000${profile.toolVersion}\u0000${profile.toolDefinitionHash}`;
    if (byDescriptor.has(key)) {
      throw new TypeError(
        "duplicate trusted ToolReconciliationProfile descriptor",
      );
    }
    byDescriptor.set(key, Object.freeze({ ...profile }));
  }
  return {
    resolve: (input) =>
      byDescriptor.get(
        `${input.toolName}\u0000${input.toolVersion}\u0000${input.toolDefinitionHash}`,
      ),
  };
};

export interface RecordedReconciliationFact {
  readonly factId: string;
  readonly invocationId: ToolInvocationId;
  readonly attemptNo: 0 | 1;
  readonly factDisposition: "RecoveryInput" | "PostTerminalEvidence";
  readonly outcome: "NotOccurred" | "Occurred" | "StillUnknown";
}

export interface ToolReconciliationFactStoreService {
  /** Persists a validated result as one immutable P39 fact. The implementation
   * derives disposition from current terminal state and never selects or
   * rewrites a terminal fact. */
  readonly record: (
    request: ToolReconciliationRequest,
    result: ToolReconciliationResult,
    observedAt: string,
  ) => Effect.Effect<
    RecordedReconciliationFact,
    RepositoryFailure<"ToolReconciliationFactStore">,
    TransactionScope
  >;
}

export class ToolReconciliationFactStore extends Context.Service<
  ToolReconciliationFactStore,
  ToolReconciliationFactStoreService
>()("arbor/ToolReconciliationFactStore") {}

/** Identity JSON uses a fixed insertion order and only immutable fact fields.
 * Replaying the exact profile result therefore produces the same SHA-256 id. */
export const reconciliationFactId = (input: {
  readonly request: ToolReconciliationRequest;
  readonly result: ToolReconciliationResult;
  readonly factDisposition: "RecoveryInput" | "PostTerminalEvidence";
  readonly evidenceSha256?: string | null;
}): string => {
  const result = input.result;
  const proof = result._tag === "StillUnknown" ? null : result.proof;
  const identity = {
    invocationId: input.request.invocationId,
    attemptNo: input.request.attemptNo,
    bindingSha256: input.request.bindingSha256,
    profileHash: input.request.profileHash,
    effectKey: input.request.effectKey,
    factOrigin: "ProfileReconciliation",
    factDisposition: input.factDisposition,
    outcome: result._tag,
    reasonCode: result._tag === "StillUnknown" ? result.reasonCode : null,
    evidenceRef:
      result._tag === "StillUnknown" ? result.evidenceRef : proof?.evidenceRef,
    evidenceSha256: input.evidenceSha256 ?? proof?.evidenceSha256 ?? null,
    resultRef: result._tag === "Occurred" ? result.resultRef : null,
  };
  return sha256Hex(JSON.stringify(identity));
};

/** Defense-in-depth boundary before a profile result can be stored or used for
 * a terminal settlement. It verifies exact attempt binding and structural
 * finality evidence; each profile adapter remains responsible for proving the
 * evidence is authoritative for its external system. */
export const validateToolReconciliationResult = (
  request: ToolReconciliationRequest,
  result: ToolReconciliationResult,
): boolean => {
  if (typeof result !== "object" || result === null) return false;
  if (result._tag === "StillUnknown") {
    return (
      [
        "ProfileUnavailable",
        "EffectIdentityUnavailable",
        "ExternalSourceUnavailable",
        "ExternalSourceNotAuthoritative",
        "EvidenceStale",
        "EvidenceBindingMismatch",
        "AttemptNotFinal",
        "ResultEvidenceUnavailable",
        "ProfileVersionUnavailable",
      ] as const
    ).includes(result.reasonCode);
  }
  if (result._tag !== "NotOccurred" && result._tag !== "Occurred") {
    return false;
  }
  const proof = result.proof;
  if (typeof proof !== "object" || proof === null) return false;
  const nonEmpty = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const sha256 = (value: unknown): value is string =>
    typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  if (
    proof.invocationId !== request.invocationId ||
    proof.attemptNo !== request.attemptNo ||
    proof.bindingSha256 !== request.bindingSha256 ||
    proof.profileHash !== request.profileHash ||
    proof.effectKey !== request.effectKey ||
    proof.visibilityScopeSha256 !== request.visibilityScopeSha256 ||
    !nonEmpty(proof.sourceRevision) ||
    !nonEmpty(proof.sourceWatermark) ||
    !nonEmpty(proof.observedAt) ||
    !nonEmpty(proof.evidenceRef) ||
    !sha256(proof.bindingSha256) ||
    !sha256(proof.profileHash) ||
    !sha256(proof.evidenceSha256) ||
    !sha256(proof.visibilityScopeSha256) ||
    !sha256(request.bindingSha256) ||
    !sha256(request.profileHash) ||
    !sha256(request.visibilityScopeSha256) ||
    proof.finality === null ||
    typeof proof.finality !== "object"
  ) {
    return false;
  }
  let finalityEvidence: string;
  switch (proof.finality._tag) {
    case "ExternallyFenced":
    case "CancellationConfirmed":
      finalityEvidence = proof.finality.confirmationRef;
      if (!nonEmpty(proof.finality.confirmedAt)) return false;
      break;
    case "TerminallyRejected":
      finalityEvidence = proof.finality.rejectionRef;
      if (!nonEmpty(proof.finality.rejectedAt)) return false;
      break;
    case "FinalityHorizonElapsed":
      finalityEvidence = proof.finality.horizon;
      if (!nonEmpty(proof.finality.elapsedAt)) return false;
      break;
    default:
      return false;
  }
  if (!nonEmpty(finalityEvidence)) return false;
  return (
    result._tag !== "Occurred" ||
    ((result.settlement === "Success" ||
      result.settlement === "ExpectedFailure") &&
      nonEmpty(result.resultRef))
  );
};
