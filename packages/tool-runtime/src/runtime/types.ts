import type { CanonicalResourceRegion } from "@arbor/domain";
import type {
  BoundedObservation,
  NoEffectDenialCode,
  SandboxHandle,
  SandboxProcessRunner,
  SandboxProviderUnavailableOutcome,
  ToolDefinition,
  ToolExecutionContext,
  ToolIntent,
  ToolInvocationSettlement,
  ToolRuntimeError,
} from "@arbor/ports";
import type { Effect } from "effect";

export interface ToolExecutionResult {
  readonly settlement: ToolInvocationSettlement;
  readonly observation: BoundedObservation;
  readonly resultRef: string | null;
  readonly sandboxProviderUnavailable?: SandboxProviderUnavailableOutcome;
}

export interface ToolExecutor {
  readonly name: string;
  readonly write: boolean;
  readonly processCapability?: "SandboxProcess";
  readonly requiresApproval: (intent: ToolIntent) => boolean;
  readonly execute: (input: {
    readonly intent: ToolIntent;
    readonly definition: ToolDefinition;
    readonly context: ToolExecutionContext;
    readonly sandbox: SandboxHandle;
    readonly regions: ReadonlyArray<CanonicalResourceRegion>;
    readonly runProcess?: SandboxProcessRunner;
  }) => Effect.Effect<ToolExecutionResult, ToolRuntimeError>;
}

export interface ToolRuntimeQualificationEvent {
  readonly boundary:
    | "AH7AfterToolIntentCommit"
    | "AH7BeforeEffectAdmission"
    | "AH7AfterEffectAdmissionCommit"
    | "AH7AfterToolEffectBeforeSettlement"
    | "AH7BeforeToolSettlementTransaction"
    | "AH7BeforeToolSettlementCommit"
    | "AH7AfterToolSettlementCommit"
    | "AH7BeforeReconciliationFactCommit"
    | "AH7AfterReconciliationFactCommit"
    | "AH7ReconciliationResultFenceRejected"
    | "AH7ToolSettlementFenceRejected"
    | "AH7AfterEffectAuthorityResolvedBeforeAdmission"
    | "P38StopInvocationLookup"
    | "P38StopEffectAdmissionResult"
    | "P38P39ClaimBeforeTransaction"
    | "NativeProcessModeDenialBeforeCommit"
    | "NativeProcessModeDenialAfterCommit";
  readonly executionId: string;
  readonly invocationId: string;
  readonly callRef: string;
  readonly approvalId?: string | null;
  readonly logicalActionId?: string | undefined;
  readonly inputHash?: string;
  readonly toolName?: string;
  readonly toolVersion?: string;
  readonly fencingGeneration?: number;
  readonly priorFound?: boolean;
  readonly priorIdentityMatches?: boolean;
  readonly priorEffectAdmissionState?: string | null;
  readonly priorSettlementKind?: string | null;
  readonly admissionResult?: string;
  readonly admissionDenialReason?: string;
  readonly denialReasonCode?: NoEffectDenialCode;
  readonly outcomeTag?: "NotOccurred" | "Occurred" | "StillUnknown";
  readonly attemptNo?: 0 | 1;
  readonly factId?: string;
}

export type ToolRuntimeQualificationProbe = (
  event: ToolRuntimeQualificationEvent,
) => Promise<void>;

