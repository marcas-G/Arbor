/** Process-local crash qualification seam. It is never model-facing, never
 * persisted, and production Composition leaves it absent. Tests supply a
 * probe through an explicit in-process config, then kill that process at the
 * named durable boundary. */
export interface AgentLoopQualificationProbeEvent {
  readonly boundary:
    | "AH3BeforeStepAvailable"
    | "AH3AfterStepAvailable"
    | "AH4BeforeSettlementProposal"
    | "AH4AfterSettlementProposal"
    | "AH4RepairBeforeSettlementProposal"
    | "AH4RepairAfterSettlementProposal"
    | "AH56AfterOutputAcceptedCommit"
    | "AH7AfterActionIntentCommit"
    | "AH7AfterActionResultCommit"
    | "AH10AfterControlHandlerReturnBeforeObservationCommit"
    | "AH9BeforeTerminalActionCommit"
    | "AH9AfterTerminalActionCommit"
    | "AH11BeforeStepEffectsCommit"
    | "AH11AfterStepEffectsCommit"
    | "AH17BeforeCheckpointEpochCommit"
    | "AH17AfterCheckpointEpochCommit"
    | "AH18BeforeOverflowLinksCommit"
    | "AH18AfterOverflowLinksCommit"
    | "AH18BeforeInferenceFailTurnCommit"
    | "AH19NativeCheckpointRecovery"
    | "AH14BeforeLegacyAdoptionCommit"
    | "AH14AfterLegacyAdoptionCommit";
  readonly providerTurnId: string;
  readonly executionId?: string;
  readonly logicalActionId?: string;
  readonly callRef?: string;
  readonly actionIndex?: number;
  readonly stage?: string;
}

export type AgentLoopQualificationProbe = (
  event: AgentLoopQualificationProbeEvent,
) => Promise<void>;
