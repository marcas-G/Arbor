import type {
  CommandSubmissionContext,
  Execution,
  ExecutionSettlement,
} from "@arbor/domain";
import type { ControlBasis } from "@arbor/model-context";
import {
  type AgentLoopStepFence,
  type AgentLoopStepStoreService,
  type ExecutionActivity,
  type ExecutionDriverError,
  type InboxProjectionStoreService,
  type ProviderTurnStoreService,
  type RuntimeSafetyObservation,
  SandboxPolicyDecisionStore,
  SandboxProviderUnavailableStore,
  SessionRepository,
  TransactionPort,
} from "@arbor/ports";
import { Context, Effect, Layer, Option } from "effect";
import type {
  AgentLoopActionOutcome,
  ReconciliationEscalationRecorderError,
} from "./agent-loop-actions/types.js";
import { foldAgentLoopActionPhaseError } from "./agent-loop-actions/errors.js";
import { executeAgentLoopActions } from "./agent-loop-actions.js";
import { foldAgentLoopStepCompletionError } from "./decision/errors.js";
import type { ModelDecisionOutcome } from "./agent-loop-policy.js";
import { completeAgentLoopStep } from "./agent-loop-step-completion.js";
import type {
  ControlToolRegistryService,
  ExecutableInvocationHandler,
} from "./control.js";
import type { ControlActionAuthorizerService } from "./control-authorization.js";
import type { AgentLoopQualificationProbe } from "./qualification-probe.js";

type AcceptedModelDecision = Extract<
  ModelDecisionOutcome,
  { readonly _tag: "Ready" }
>;

export interface AgentLoopActionProgressionServiceOptions {
  readonly controlRegistry: ControlToolRegistryService;
  readonly controlAuthorizer?: ControlActionAuthorizerService;
  readonly executableInvocationHandler?: ExecutableInvocationHandler;
  readonly recordReconciliationEscalation?: (input: {
    readonly execution: Execution;
    readonly fence: AgentLoopStepFence;
    readonly principal: import("@arbor/domain").Principal;
    readonly invocationRefs: ReadonlyArray<string>;
  }) => Effect.Effect<void, ReconciliationEscalationRecorderError>;
  readonly qualificationProbe?: AgentLoopQualificationProbe;
}

export interface AgentLoopActionProgressionBindingInput {
  readonly execution: Execution;
  readonly context: CommandSubmissionContext;
  readonly loopSteps?: AgentLoopStepStoreService;
  readonly providerTurns?: Pick<
    ProviderTurnStoreService,
    "findManifestByTurn" | "findSettledResult"
  >;
  readonly inboxSequence?: Pick<InboxProjectionStoreService, "currentSequence">;
  readonly loopStepFence?: AgentLoopStepFence;
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
}

export interface AgentLoopActionProgressionInput {
  readonly decision: AcceptedModelDecision;
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

export type AgentLoopActionProgressionOutcome =
  | Exclude<AgentLoopActionOutcome, { readonly _tag: "Completed" }>
  | {
      readonly _tag: "Continue";
      readonly durableProgress: boolean;
    };

export interface BoundAgentLoopActionProgression {
  readonly progress: (
    input: AgentLoopActionProgressionInput,
  ) => Effect.Effect<AgentLoopActionProgressionOutcome, ExecutionDriverError>;
}

export interface AgentLoopActionProgressionServiceShape {
  readonly forExecution: (
    input: AgentLoopActionProgressionBindingInput,
  ) => Effect.Effect<BoundAgentLoopActionProgression>;
}

export class AgentLoopActionProgressionService extends Context.Service<
  AgentLoopActionProgressionService,
  AgentLoopActionProgressionServiceShape
>()("arbor/AgentLoopActionProgressionService") {}

export const AgentLoopActionProgressionServiceLive = (
  options: AgentLoopActionProgressionServiceOptions,
): Layer.Layer<
  AgentLoopActionProgressionService,
  never,
  TransactionPort | SessionRepository
> =>
  Layer.effect(
    AgentLoopActionProgressionService,
    Effect.gen(function* () {
      const tx = yield* TransactionPort;
      const sessions = yield* SessionRepository;
      const sandboxUnavailableFacts = yield* Effect.serviceOption(
        SandboxProviderUnavailableStore,
      );
      const sandboxPolicyDecisions = yield* Effect.serviceOption(
        SandboxPolicyDecisionStore,
      );

      return AgentLoopActionProgressionService.of({
        forExecution: (binding) =>
          Effect.succeed({
            progress: (input) =>
              Effect.gen(function* () {
                const decision = input.decision;
                const actionOutcome = yield* executeAgentLoopActions({
                  input: {
                    execution: binding.execution,
                    context: binding.context,
                  },
                  preparedTurn: decision.turn,
                  decodedOutput: decision.output,
                  turn: input.turn,
                  ...(decision.loopStep === undefined
                    ? {}
                    : { currentLoopStep: decision.loopStep }),
                  ...(input.recoverExactNotAdmittedAction === undefined
                    ? {}
                    : {
                        recoverExactNotAdmittedAction:
                          input.recoverExactNotAdmittedAction,
                      }),
                  ...(binding.loopSteps === undefined
                    ? {}
                    : { loopSteps: binding.loopSteps }),
                  ...(binding.providerTurns === undefined
                    ? {}
                    : { providerTurns: binding.providerTurns }),
                  ...(binding.inboxSequence === undefined
                    ? {}
                    : { inboxSequence: binding.inboxSequence }),
                  ...(binding.loopStepFence === undefined
                    ? {}
                    : { loopStepFence: binding.loopStepFence }),
                  tx,
                  sessions,
                  controlRegistry: options.controlRegistry,
                  ...(options.controlAuthorizer === undefined
                    ? {}
                    : { controlAuthorizer: options.controlAuthorizer }),
                  ...(options.executableInvocationHandler === undefined
                    ? {}
                    : {
                        executableInvocationHandler:
                          options.executableInvocationHandler,
                      }),
                  currentControlBasis: binding.currentControlBasis,
                  admit: binding.admit,
                  failure: binding.failure,
                  now: binding.now,
                  ...(options.recordReconciliationEscalation === undefined
                    ? {}
                    : {
                        recordReconciliationEscalation:
                          options.recordReconciliationEscalation,
                      }),
                  ...(options.qualificationProbe === undefined
                    ? {}
                    : { qualificationProbe: options.qualificationProbe }),
                  ...(Option.isNone(sandboxUnavailableFacts)
                    ? {}
                    : {
                        sandboxUnavailableFacts: sandboxUnavailableFacts.value,
                      }),
                  ...(Option.isNone(sandboxPolicyDecisions)
                    ? {}
                    : {
                        sandboxPolicyDecisions: sandboxPolicyDecisions.value,
                      }),
                }).pipe(Effect.mapError(foldAgentLoopActionPhaseError));
                if (actionOutcome._tag !== "Completed") {
                  return actionOutcome;
                }
                const completion = yield* completeAgentLoopStep({
                  input: {
                    execution: binding.execution,
                    context: binding.context,
                  },
                  decodedOutput: decision.output,
                  observations: actionOutcome.observations,
                  conversation: decision.conversation === true,
                  turn: input.turn,
                  ...(actionOutcome.loopStep === undefined
                    ? {}
                    : { currentLoopStep: actionOutcome.loopStep }),
                  ...(binding.loopSteps === undefined
                    ? {}
                    : { loopSteps: binding.loopSteps }),
                  ...(binding.loopStepFence === undefined
                    ? {}
                    : { loopStepFence: binding.loopStepFence }),
                  tx,
                  sessions,
                  now: binding.now,
                  ...(options.qualificationProbe === undefined
                    ? {}
                    : { qualificationProbe: options.qualificationProbe }),
                }).pipe(Effect.mapError(foldAgentLoopStepCompletionError));
                if (completion._tag === "Settle") {
                  return {
                    _tag: "Settle",
                    settlement: completion.settlement,
                  } satisfies {
                    readonly _tag: "Settle";
                    readonly settlement: ExecutionSettlement;
                  };
                }
                return {
                  _tag: "Continue",
                  durableProgress: actionOutcome.durableProgress,
                };
              }),
          }),
      });
    }),
  );
