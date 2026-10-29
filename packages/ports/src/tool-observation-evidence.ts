import type { ToolInvocationId } from "@arbor/domain";
import { Context, type Effect } from "effect";
import type {
  ArtifactError,
  LeaseFencingRejected,
  RepositoryFailure,
} from "./errors.js";
import type { SelectedP39RecoveryEvidence } from "./recovery-binding.js";
import type { TransactionScope } from "./session.js";
import type {
  CanonicalToolObservation,
  ToolExecutionContext,
  ToolInvocationIntent,
  ToolInvocationSettlement,
} from "./tool.js";

export const P4_TOOL_OBSERVATION_FORMAT_V1 =
  "p4-canonical-tool-observation-v1" as const;
export const P4_TOOL_OBSERVATION_MAX_TEXT_UTF16_CODE_UNITS = 2_000;

export type ToolObservationReplayFailureCode =
  | "Missing"
  | "UnsupportedVersion"
  | "Malformed"
  | "HashMismatch"
  | "SettlementMismatch"
  | "IntentMismatch"
  | "ResultRefMismatch"
  | "UnexpectedResultRef";

export type ReconciledNoEffectReasonCode =
  | "AuthoritySnapshotChanged"
  | "ResourceSnapshotChanged"
  | "ApprovalNoLongerAuthorized"
  | "StopRequested"
  | "ReplayLimitReached";

export interface ReconciledNoEffectToolObservation {
  readonly _tag: "ReconciledNoEffect";
  readonly reasonCode: ReconciledNoEffectReasonCode;
  readonly reconciliationFactRef: string;
  readonly observation: {
    readonly text: string;
    readonly truncated: boolean;
  };
  readonly resultRef: string;
}

/** Strict typed proof carried only by the terminal ExpectedFailure produced
 * when a SandboxProcess provider cannot satisfy the exact pinned policy. */
export interface SandboxProviderUnavailableObservationV1 {
  readonly policyRevision: number;
  readonly policyDigest: string;
  readonly profile: import("@arbor/domain").SandboxProfile;
  readonly providerId: import("@arbor/domain").SandboxProviderId;
  readonly providerVersion: string;
  readonly capabilityRevision: string;
  readonly probeEvidenceRef: string | null;
  readonly failureCode: string;
  readonly effectDisposition: "NoEffect";
}

export interface ToolObservationEvidence {
  readonly formatVersion: typeof P4_TOOL_OBSERVATION_FORMAT_V1;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly observation: ToolObservationEvidenceObservation;
}

export interface ToolObservationEvidenceReplayFailure {
  readonly _tag: "ToolObservationReplayEvidenceFailure";
  readonly invocationId: ToolInvocationId;
  readonly failureCode: ToolObservationReplayFailureCode;
}

export type ToolObservationEvidenceStoreError =
  | RepositoryFailure<"ToolObservationEvidenceStore">
  | LeaseFencingRejected
  | ArtifactError
  | ToolObservationEvidenceReplayFailure;

export type ToolObservationSettlement =
  | Exclude<ToolInvocationSettlement, { readonly _tag: "Denied" }>
  | {
      readonly _tag: "ReconciledNoEffect";
      readonly reasonCode: ReconciledNoEffectReasonCode;
      readonly reconciliationFactRef: string;
    };

export type ToolObservationEvidenceObservation =
  | (CanonicalToolObservation & {
      readonly sandboxProviderUnavailable?: SandboxProviderUnavailableObservationV1;
    })
  | ReconciledNoEffectToolObservation;

export interface ToolObservationEvidenceCandidate {
  readonly invocation: ToolInvocationIntent;
  readonly settlement: ToolObservationSettlement;
  readonly resultRef: string | null;
  readonly observation: ToolObservationEvidenceObservation;
  /** Exact immutable P39 fact selected by a final NotOccurred proof. */
  readonly reconciliationSelection?: {
    readonly attemptNo: number;
    readonly factId: string;
  };
  /** P39 has already authenticated the closed V1 binding and exact selected
   * attempt/fact tuple. P40 consumes it as typed evidence and never reparses it. */
  readonly authenticatedRecoveryEvidence?: SelectedP39RecoveryEvidence;
  /** Called only after a current-fence read proves there is no settled winner;
   * the artifact and P4 terminal evidence share the surrounding transaction. */
  readonly materializeResultRef?: () => Effect.Effect<
    string,
    ArtifactError,
    TransactionScope
  >;
  readonly settledAt: string;
  readonly executionFence: NonNullable<ToolExecutionContext["executionFence"]>;
  readonly fenceNow: string;
}

export type ToolObservationEvidenceSettlement =
  | { readonly _tag: "Applied"; readonly evidence: ToolObservationEvidence }
  | { readonly _tag: "Existing"; readonly evidence: ToolObservationEvidence }
  | {
      /** P4 Denied rows intentionally have no P40 observation bytes. They are
       * still a committed winner that a racing Stop must not rewrite. */
      readonly _tag: "ExistingDenied";
      readonly reasonCode: import("./tool.js").NoEffectDenialCode;
    };

export interface ToolObservationEvidenceStoreService {
  /** Validates current P2 ownership before any terminal invocation-row read.
   * The caller must perform its following row read in this same transaction. */
  readonly assertCurrentFence: (
    executionFence: NonNullable<ToolExecutionContext["executionFence"]>,
    fenceNow: string,
  ) => Effect.Effect<void, ToolObservationEvidenceStoreError, TransactionScope>;
  /** Must be called inside the same P4 transaction as the canonical
   * ToolResult handoff. A losing CAS reads and returns only the committed
   * winner after checking the live execution fence. */
  readonly settleOrReadWinner: (
    candidate: ToolObservationEvidenceCandidate,
  ) => Effect.Effect<
    ToolObservationEvidenceSettlement,
    ToolObservationEvidenceStoreError,
    TransactionScope
  >;
  /** Fences before reading terminal evidence. Missing or invalid evidence is
   * returned as a closed failure code for the P9/P10 recovery path. */
  readonly read: (
    invocation: ToolInvocationIntent,
    executionFence: NonNullable<ToolExecutionContext["executionFence"]>,
    fenceNow: string,
  ) => Effect.Effect<
    ToolObservationEvidence,
    ToolObservationEvidenceStoreError,
    TransactionScope
  >;
}

export class ToolObservationEvidenceStore extends Context.Service<
  ToolObservationEvidenceStore,
  ToolObservationEvidenceStoreService
>()("arbor/ToolObservationEvidenceStore") {}
