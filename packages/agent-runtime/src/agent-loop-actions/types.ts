import type { CommandSubmissionContext, Execution, ExecutionSettlement } from "@arbor/domain";
import type { ControlBasis, ModelOutput, PreparedModelTurn } from "@arbor/model-context";
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
  SandboxProviderUnavailableOutcome,
  SessionRepositoryService,
  TransactionPortService,
} from "@arbor/ports";
import type { Effect } from "effect";
import type { ControlToolRegistryService, ExecutableInvocationHandler } from "../control.js";
import type { ControlActionAuthorizerService } from "../control-authorization.js";
import type { AgentLoopQualificationProbe } from "../qualification-probe.js";

export interface AgentLoopActionDependencies {
  readonly input: {
    readonly execution: Execution;
    readonly context: CommandSubmissionContext;
  };
  readonly preparedTurn: PreparedModelTurn;
  readonly decodedOutput: ModelOutput;
  readonly turn: number;
  readonly currentLoopStep?: AgentLoopStepRecord;
  readonly loopSteps?: AgentLoopStepStoreService;
  readonly providerTurns?: Pick<
    ProviderTurnStoreService,
    "findManifestByTurn" | "findSettledResult"
  >;
  readonly inboxSequence?: Pick<InboxProjectionStoreService, "currentSequence">;
  readonly loopStepFence?: AgentLoopStepFence;
  readonly tx: TransactionPortService;
  readonly sessions: SessionRepositoryService;
  readonly controlRegistry: ControlToolRegistryService;
  readonly controlAuthorizer?: ControlActionAuthorizerService;
  readonly executableInvocationHandler?: ExecutableInvocationHandler;
  readonly recoverExactNotAdmittedAction?: {
    readonly executionId: string;
    readonly logicalStepNo: number;
    readonly repairAttempt: number;
    readonly providerTurnId: string;
    readonly logicalActionId: string;
    readonly actionIndex: number;
    readonly callRef: string;
  };
  /** P9-owned durable escalation for an unresolved P4 effect. It runs before
   * P3 persists the terminal OutcomeUnknown action so P9 can use the current
   * Worker fence and unsettled Execution required by DID v1.40. */
  readonly recordReconciliationEscalation?: (input: {
    readonly execution: Execution;
    readonly fence: AgentLoopStepFence;
    readonly principal: import("@arbor/domain").Principal;
    readonly invocationRefs: ReadonlyArray<string>;
  }) => Effect.Effect<void, unknown>;
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
  readonly qualificationProbe?: AgentLoopQualificationProbe;
}

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

