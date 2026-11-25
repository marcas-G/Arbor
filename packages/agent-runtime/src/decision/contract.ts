import type {
  AgentBinding,
  AgentExecutionState,
  Execution,
} from "@arbor/domain";
import type {
  ControlBasis,
  ModelContextService,
  TurnProfileResolverService,
} from "@arbor/model-context";
import type {
  AgentLoopStepFence,
  AgentLoopStepStoreService,
  BlobStorePortService,
  ConversationCheckpointStoreService,
  DecisionRequestStoreService,
  ExecutionActivity,
  ExecutionDriverError,
  ModelCapability,
  ProviderCancellationSignal,
  ProviderExecutionPolicyOverrides,
  ProviderRuntimeProgress,
  ProviderRuntimeService,
  ProviderTurnStoreService,
  SecretRef,
  SessionRepositoryService,
  TransactionPortService,
  WorkRepositoryService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import type { Effect } from "effect";
import type { AgentLoopQualificationProbe } from "../qualification-probe.js";

export interface ModelDecisionOptions {
  readonly cancellationSignal?: ProviderCancellationSignal;
  readonly secretRef?: SecretRef;
  readonly executionPolicyOverrides?: ProviderExecutionPolicyOverrides;
  readonly providerRef?: string;
  readonly protocolFamily?: string;
  readonly onProviderProgress?:
    | ((executionId: string, event: ProviderRuntimeProgress) => void)
    | undefined;
  readonly qualificationProbe?: AgentLoopQualificationProbe;
  /** Exact P4 recovery candidate selected from a bound NotAdmitted invocation.
   * It permits replaying its persisted ProviderTurn before its successor. */
  readonly resumeExactActionStepIdentity?: {
    readonly executionId: Execution["executionId"];
    readonly logicalStepNo: number;
    readonly repairAttempt: number;
  };
}

export interface ModelDecisionDependencies {
  readonly input: {
    readonly execution: Execution;
    readonly agentExecutionState: AgentExecutionState;
  };
  readonly agentBinding: AgentBinding;
  readonly capability: ModelCapability;
  readonly currentControlBasis: () => Effect.Effect<
    ControlBasis,
    ExecutionDriverError
  >;
  readonly modelContext: ModelContextService;
  readonly providerRuntime: ProviderRuntimeService;
  readonly tx: TransactionPortService;
  readonly loopSteps?: AgentLoopStepStoreService;
  readonly loopStepFence?: AgentLoopStepFence;
  readonly providerTurns?: ProviderTurnStoreService;
  readonly sessions: SessionRepositoryService;
  readonly conversationCheckpoints?: ConversationCheckpointStoreService;
  readonly blobs?: Pick<BlobStorePortService, "put" | "get">;
  readonly turnProfileResolver: TurnProfileResolverService;
  readonly works: WorkRepositoryService;
  readonly decisionRequests?: Pick<DecisionRequestStoreService, "findById">;
  readonly workspaces: WorkspaceRepositoryService;
  readonly options: ModelDecisionOptions;
  readonly admitProviderTurn: (
    operationKind: import("@arbor/ports").PortableOperationKind,
    compiledRequestHash: string,
  ) => Effect.Effect<{
    readonly activity: ExecutionActivity;
    readonly decision: "Continue" | "Stop";
  }>;
  readonly completeProviderTurn: (
    activity: ExecutionActivity,
    attemptNo?: number,
  ) => Effect.Effect<"Continue" | "Stop">;
  readonly failure: (cause: unknown) => ExecutionDriverError;
  readonly now: () => Effect.Effect<string>;
}
