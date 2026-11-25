import type {
  CommandSubmissionContext,
  Execution,
  ExecutionSettlement,
} from "@arbor/domain";
import type {
  ControlBasis,
  ModelOutput,
  PreparedModelTurn,
} from "@arbor/model-context";
import type {
  AgentLoopStepFence,
  AgentLoopStepRecord,
  AgentLoopStepStoreService,
  BoundedObservation,
  ExecutionActivity,
  ExecutionDriverError,
  InboxProjectionStoreService,
  ProviderTurnStoreService,
  RuntimeSafetyObservation,
  SandboxPolicyDecisionStoreService,
  SandboxProviderUnavailableOutcome,
  SandboxProviderUnavailableStoreService,
  SessionRepositoryService,
  TransactionPortService,
} from "@arbor/ports";
import type { Effect } from "effect";

/** E09: the reconciliation-escalation callback owns a typed failure
 * surface instead of `unknown`; the execution-runtime recorder
 * implements it (architecture DAG: execution-runtime depends on
 * agent-runtime, never the reverse). */
export type ReconciliationEscalationRecorderError =
  | {
      readonly _tag: "ReconciliationEscalationBindingMismatch";
      readonly executionId: import("@arbor/domain").ExecutionId;
    }
  | {
      readonly _tag: "ReconciliationEscalationExecutionNotActive";
      readonly executionId: import("@arbor/domain").ExecutionId;
    }
  | import("@arbor/ports").ExecutionRepositoryError
  | import("@arbor/ports").DomainEventJournalError
  | import("@arbor/ports").LeaseFencingRejected
  | import("@arbor/ports").TransactionOperationalFailure;

import type {
  ControlToolRegistryService,
  ExecutableInvocationHandler,
} from "../control.js";
import type { ControlActionAuthorizerService } from "../control-authorization.js";
import type { AgentLoopQualificationProbe } from "../qualification-probe.js";

/**
 * Object 2 layering: the action phase's inputs split by nature so a
 * consumer states which class of thing it depends on — the decision
 * payload it is executing, the durable stores backing the phase, or the
 * per-drive orchestration state. The flattened legacy shape remains
 * available as an alias for existing assemblies.
 */
export interface AgentActionTurnInput {
  readonly input: {
    readonly execution: Execution;
    readonly context: CommandSubmissionContext;
  };
  readonly preparedTurn: PreparedModelTurn;
  readonly decodedOutput: ModelOutput;
  readonly turn: number;
  readonly recoverExactNotAdmittedAction?: {
    readonly executionId: string;
    readonly logicalStepNo: number;
    readonly repairAttempt: number;
    readonly providerTurnId: string;
    readonly logicalActionId: string;
    readonly actionIndex: number;
    readonly callRef: string;
  };
}

export interface AgentActionDurableStores {
  readonly loopSteps?: AgentLoopStepStoreService;
  readonly providerTurns?: Pick<
    ProviderTurnStoreService,
    "findManifestByTurn" | "findSettledResult"
  >;
  readonly inboxSequence?: Pick<InboxProjectionStoreService, "currentSequence">;
  readonly tx: TransactionPortService;
  readonly sessions: SessionRepositoryService;
  readonly sandboxUnavailableFacts?: SandboxProviderUnavailableStoreService;
  readonly sandboxPolicyDecisions?: SandboxPolicyDecisionStoreService;
}

export interface AgentActionOrchestration {
  readonly currentLoopStep?: AgentLoopStepRecord;
  readonly loopStepFence?: AgentLoopStepFence;
  readonly controlRegistry: ControlToolRegistryService;
  readonly controlAuthorizer?: ControlActionAuthorizerService;
  readonly executableInvocationHandler?: ExecutableInvocationHandler;
  readonly currentControlBasis: () => Effect.Effect<
    ControlBasis,
    ExecutionDriverError
  >;
  readonly admit: (
    activity: ExecutionActivity,
    observation: RuntimeSafetyObservation,
  ) => Effect.Effect<"Continue" | "Stop">;
  readonly failure: (cause: unknown) => ExecutionDriverError;
  readonly now: () => Effect.Effect<string>;
  /** P9-owned durable escalation for an unresolved P4 effect. It runs before
   * P3 persists the terminal OutcomeUnknown action so P9 can use the current
   * Worker fence and unsettled Execution required by DID v1.40. */
}

/** Legacy flattened shape: every consumer today; new consumers Pick from
 * the layered interfaces above. */
export type AgentLoopActionDependencies = AgentActionTurnInput &
  AgentActionDurableStores &
  AgentActionOrchestration & {
    readonly recordReconciliationEscalation?: (input: {
      readonly execution: Execution;
      readonly fence: AgentLoopStepFence;
      readonly principal: import("@arbor/domain").Principal;
      readonly invocationRefs: ReadonlyArray<string>;
    }) => Effect.Effect<void, ReconciliationEscalationRecorderError>;
    readonly qualificationProbe?: AgentLoopQualificationProbe;
  };

export type AgentLoopActionOutcome =
  | {
      readonly _tag: "Completed";
      readonly loopStep?: AgentLoopStepRecord;
      readonly observations: ReadonlyArray<{
        readonly source: "Runtime" | "Tool";
        readonly observation: BoundedObservation;
      }>;
      readonly durableProgress: boolean;
    }
  | { readonly _tag: "DecisionStale" }
  | { readonly _tag: "RecoveryBlocked" }
  | {
      readonly _tag: "ApprovalRequired";
      readonly approvalId: string;
      readonly revision: number;
    }
  | { readonly _tag: "Settle"; readonly settlement: ExecutionSettlement }
  | {
      readonly _tag: "SandboxProviderUnavailable";
      readonly outcome: SandboxProviderUnavailableOutcome;
    }
  | { readonly _tag: "SandboxPolicyRequiredInterruption" };
