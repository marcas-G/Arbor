import type {
  AgentExecutionState,
  CommandSubmissionContext,
  Execution,
} from "@arbor/domain";
import {
  type ControlBasis,
  ModelContext,
  TurnProfileResolver,
} from "@arbor/model-context";
import {
  type AgentLoopStepFence,
  type AgentLoopStepStoreService,
  BlobStorePort,
  ConversationAttemptStore,
  ConversationCheckpointStore,
  ConversationResponseJobStore,
  DecisionRequestStore,
  type ExecutionActivity,
  type ExecutionDriverError,
  ExecutionRepository,
  HumanMessageStore,
  LocalPlanStore,
  ModelCapabilityPort,
  type PortableOperationKind,
  type ProviderCancellationSignal,
  ProviderRuntime,
  type ProviderTurnStoreService,
  RecoveryAttentionFactStore,
  SessionRepository,
  TransactionPort,
  WorkRepository,
  WorkspaceKnowledgePort,
  WorkspacePlacementPort,
  WorkspaceRepository,
} from "@arbor/ports";
import { Context, Effect, Layer } from "effect";
import type { ModelDecisionOutcome } from "./agent-loop-policy.js";
import { ControlBasisResolver } from "./control-basis-resolver.js";
import type { ModelDecisionOptions } from "./decision/contract.js";
import { foldModelOutputJournalError } from "./decision/errors.js";
import { toExecutionDriverError } from "./execution-driver-failure.js";
import { runModelDecision } from "./model-decision.js";
import { recordAcceptedModelOutput } from "./model-output-journal.js";

export type ModelDecisionServiceOptions = Omit<
  ModelDecisionOptions,
  "cancellationSignal" | "resumeExactActionStepIdentity"
>;

export interface ModelDecisionCursor {
  readonly turn: number;
  readonly repairAttempt: number;
  readonly resumeExactActionStepIdentity?: {
    readonly executionId: Execution["executionId"];
    readonly logicalStepNo: number;
    readonly repairAttempt: number;
  };
}

export interface ModelDecisionExecutionInput {
  readonly execution: Execution;
  readonly agentExecutionState: AgentExecutionState;
  readonly context: CommandSubmissionContext;
  readonly loopSteps?: AgentLoopStepStoreService;
  readonly loopStepFence?: AgentLoopStepFence;
  readonly providerTurns?: ProviderTurnStoreService;
  readonly cancellationSignal?: ProviderCancellationSignal;
  readonly admitProviderTurn: (
    operationKind: PortableOperationKind,
    compiledRequestHash: string,
  ) => Effect.Effect<{
    readonly activity: ExecutionActivity;
    readonly decision: "Continue" | "Stop";
  }>;
  readonly completeProviderTurn: (
    activity: ExecutionActivity,
    attemptNo?: number,
  ) => Effect.Effect<"Continue" | "Stop">;
  readonly now: () => Effect.Effect<string>;
}

export interface BoundModelDecision {
  readonly currentControlBasis: () => Effect.Effect<
    ControlBasis,
    ExecutionDriverError
  >;
  readonly decide: (
    cursor: ModelDecisionCursor,
  ) => Effect.Effect<ModelDecisionOutcome, ExecutionDriverError>;
}

export interface ModelDecisionServiceShape {
  readonly forExecution: (
    input: ModelDecisionExecutionInput,
  ) => Effect.Effect<BoundModelDecision, ExecutionDriverError>;
}

export class ModelDecisionService extends Context.Service<
  ModelDecisionService,
  ModelDecisionServiceShape
>()("arbor/ModelDecisionService") {}

export const ModelDecisionServiceLive = (
  options: ModelDecisionServiceOptions = {},
): Layer.Layer<
  ModelDecisionService,
  never,
  | ModelContext
  | ProviderRuntime
  | ModelCapabilityPort
  | ControlBasisResolver
  | SessionRepository
  | TransactionPort
  | ConversationCheckpointStore
  | BlobStorePort
  | TurnProfileResolver
  | WorkRepository
  | DecisionRequestStore
  | WorkspaceRepository
  | LocalPlanStore
  | WorkspaceKnowledgePort
  | WorkspacePlacementPort
  | RecoveryAttentionFactStore
  | HumanMessageStore
  | ConversationResponseJobStore
  | ConversationAttemptStore
  | ExecutionRepository
> =>
  Layer.effect(
    ModelDecisionService,
    Effect.gen(function* () {
      const modelContext = yield* ModelContext;
      const providerRuntime = yield* ProviderRuntime;
      const capabilityPort = yield* ModelCapabilityPort;
      const makeControlBasis = yield* ControlBasisResolver;
      const sessions = yield* SessionRepository;
      const tx = yield* TransactionPort;
      const conversationCheckpoints = yield* ConversationCheckpointStore;
      const blobs = yield* BlobStorePort;
      const turnProfileResolver = yield* TurnProfileResolver;
      const works = yield* WorkRepository;
      const decisionRequests = yield* DecisionRequestStore;
      const workspaces = yield* WorkspaceRepository;
      const localPlans = yield* LocalPlanStore;
      const workspaceKnowledge = yield* WorkspaceKnowledgePort;
      const workspacePlacement = yield* WorkspacePlacementPort;
      const recoveryAttentionFacts = yield* RecoveryAttentionFactStore;
      const humanMessages = yield* HumanMessageStore;
      const responseJobs = yield* ConversationResponseJobStore;
      const responseAttempts = yield* ConversationAttemptStore;
      const executions = yield* ExecutionRepository;
      const failure = toExecutionDriverError;

      const provideInternalCapabilities = <A, E>(
        effect: Effect.Effect<
          A,
          E,
          | ModelContext
          | TurnProfileResolver
          | DecisionRequestStore
          | LocalPlanStore
          | WorkspaceKnowledgePort
          | WorkspacePlacementPort
          | RecoveryAttentionFactStore
          | HumanMessageStore
          | ConversationResponseJobStore
          | ConversationAttemptStore
          | ExecutionRepository
        >,
      ): Effect.Effect<A, E> =>
        effect.pipe(
          Effect.provideService(ModelContext, modelContext),
          Effect.provideService(TurnProfileResolver, turnProfileResolver),
          Effect.provideService(DecisionRequestStore, decisionRequests),
          Effect.provideService(WorkspaceKnowledgePort, workspaceKnowledge),
          Effect.provideService(WorkspacePlacementPort, workspacePlacement),
          Effect.provideService(LocalPlanStore, localPlans),
          Effect.provideService(
            RecoveryAttentionFactStore,
            recoveryAttentionFacts,
          ),
          Effect.provideService(HumanMessageStore, humanMessages),
          Effect.provideService(ConversationResponseJobStore, responseJobs),
          Effect.provideService(ConversationAttemptStore, responseAttempts),
          Effect.provideService(ExecutionRepository, executions),
        );

      return ModelDecisionService.of({
        forExecution: (input) =>
          Effect.gen(function* () {
            const agentBinding =
              input.execution.binding._tag === "WorkspaceExecution"
                ? {
                    _tag: "ResponsibilityBoundAgentBinding" as const,
                    workspaceId: input.execution.binding.workspaceId,
                  }
                : input.execution.binding;
            const capability = yield* capabilityPort
              .resolve({
                binding: agentBinding,
                cognitiveMode:
                  input.agentExecutionState.currentMode ?? "execute",
                requiredCapabilities: [],
              })
              .pipe(Effect.mapError(failure));
            const currentControlBasis = makeControlBasis({
              execution: input.execution,
              context: input.context,
            });
            const decide = (
              cursor: ModelDecisionCursor,
            ): Effect.Effect<ModelDecisionOutcome, ExecutionDriverError> =>
              provideInternalCapabilities(
                Effect.gen(function* () {
                  const outcome = yield* runModelDecision(
                    {
                      input: {
                        execution: input.execution,
                        agentExecutionState: input.agentExecutionState,
                      },
                      capability,
                      currentControlBasis,
                      providerRuntime,
                      tx,
                      sessions,
                      conversationCheckpoints,
                      blobs,
                      works,
                      workspaces,
                      options: {
                        ...options,
                        ...(input.cancellationSignal === undefined
                          ? {}
                          : {
                              cancellationSignal: input.cancellationSignal,
                            }),
                        ...(cursor.resumeExactActionStepIdentity === undefined
                          ? {}
                          : {
                              resumeExactActionStepIdentity:
                                cursor.resumeExactActionStepIdentity,
                            }),
                      },
                      admitProviderTurn: input.admitProviderTurn,
                      completeProviderTurn: input.completeProviderTurn,
                      failure,
                      now: input.now,
                      ...(input.loopSteps === undefined
                        ? {}
                        : { loopSteps: input.loopSteps }),
                      ...(input.loopStepFence === undefined
                        ? {}
                        : { loopStepFence: input.loopStepFence }),
                      ...(input.providerTurns === undefined
                        ? {}
                        : { providerTurns: input.providerTurns }),
                    },
                    cursor.turn,
                    cursor.repairAttempt,
                  );
                  if (outcome._tag !== "Ready") {
                    return outcome;
                  }
                  const loopStep = yield* recordAcceptedModelOutput({
                    input: {
                      execution: input.execution,
                      context: input.context,
                    },
                    preparedTurn: outcome.turn,
                    decodedOutput: outcome.output,
                    ...(outcome.loopStep === undefined
                      ? {}
                      : { currentLoopStep: outcome.loopStep }),
                    ...(input.loopSteps === undefined
                      ? {}
                      : { loopSteps: input.loopSteps }),
                    ...(input.loopStepFence === undefined
                      ? {}
                      : { loopStepFence: input.loopStepFence }),
                    tx,
                    sessions,
                    // E09/Gate C C2: the reasoning-attachment blob write requires
                    // the blob store; without it every reasoning response would
                    // fail closed as ReasoningRoundTripBindingUnavailable.
                    blobs,
                    now: input.now,
                    ...(options.qualificationProbe === undefined
                      ? {}
                      : { qualificationProbe: options.qualificationProbe }),
                  }).pipe(Effect.mapError(foldModelOutputJournalError));
                  return {
                    ...outcome,
                    ...(loopStep === undefined ? {} : { loopStep }),
                  };
                }),
              );

            return {
              currentControlBasis,
              decide,
            } satisfies BoundModelDecision;
          }),
      });
    }),
  );
