import { InputPromotionService } from "@arbor/application";
import type { AgentExecutionState, Execution, WakeReason } from "@arbor/domain";
import { executionEpisode } from "@arbor/domain";
import {
  type AgentLoopStepFence,
  AgentLoopStepStore,
  Clock,
  ConversationCheckpointStore,
  DecisionRequestStore,
  type ExecutionActivity,
  type ExecutionDriveOutcome,
  type ExecutionDriverError,
  ExecutionDriverPort,
  InboxProjectionStore,
  P39RecoveryEvidenceStore,
  type PortableOperationKind,
  type ProviderCancellationSignal,
  ProviderTurnStore,
  type RuntimeSafetyGateService,
  type RuntimeSafetyObservation,
  SessionRepository,
  ToolInvocationStore,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import type { ReconciliationEscalationRecorderError } from "./agent-loop-actions/types.js";
import { executeAgentLoopActions } from "./agent-loop-actions.js";
import { recoverAgentLoopFrontier } from "./agent-loop-driver/recovery.js";
import { MAX_TURNS } from "./agent-loop-policy.js";
import { completeAgentLoopStep } from "./agent-loop-step-completion.js";
import {
  type ControlToolRegistryService,
  type ExecutableInvocationHandler,
  makeControlToolRegistry,
} from "./control.js";
import type { ControlActionAuthorizerService } from "./control-authorization.js";
import { foldAgentLoopStepCompletionError } from "./decision/errors.js";
import { toExecutionDriverError } from "./execution-driver-failure.js";
import { ModelDecisionService } from "./model-decision-service.js";
import { providerTurnSafetyFingerprint } from "./p12-safety-identity.js";
import type { AgentLoopQualificationProbe } from "./qualification-probe.js";
import { selectPendingInputPromotions } from "./safe-input-drain.js";
import { settlementProposal } from "./settlement-proposal.js";

export {
  type AgentLoopStepCursor,
  isAgentLoopStepManifestBound,
  isPreparedStepAwaitingInitialManifest,
  selectInitialAgentLoopStepCursor,
} from "./agent-loop-driver/cursor.js";

export interface AgentLoopDriverOptions {
  /** The typed control-tool registry. Composition supplies the live registry;
   * the default keeps Wait available for focused runtime tests. */
  readonly controlRegistry?: ControlToolRegistryService;
  readonly controlAuthorizer?: ControlActionAuthorizerService;
  readonly executableInvocationHandler?: ExecutableInvocationHandler;
  /** P9 durable recovery escalation for unknown external effects. */
  readonly recordReconciliationEscalation?: (input: {
    readonly execution: Execution;
    readonly fence: AgentLoopStepFence;
    readonly principal: import("@arbor/domain").Principal;
    readonly invocationRefs: ReadonlyArray<string>;
  }) => Effect.Effect<void, ReconciliationEscalationRecorderError>;
  readonly qualificationProbe?: AgentLoopQualificationProbe;
}
export const AgentLoopDriverLive = (
  options: AgentLoopDriverOptions = {},
): Layer.Layer<
  ExecutionDriverPort,
  never,
  | ModelDecisionService
  | SessionRepository
  | TransactionPort
  | InboxProjectionStore
  | InputPromotionService
  | ConversationCheckpointStore
  | DecisionRequestStore
  | ToolInvocationStore
  | P39RecoveryEvidenceStore
  | Clock
> =>
  Layer.effect(
    ExecutionDriverPort,
    Effect.gen(function* () {
      const modelDecisionService = yield* ModelDecisionService;
      const sessions = yield* SessionRepository;
      // E06 normalization (object 1, batch two): every service the
      // production composition always provides becomes a typed Layer
      // requirement. Only AgentLoopStepStore/ProviderTurnStore keep their
      // optionality — their absence carries schema-migration gating that
      // must stay fail-closed rather than become a type-level demand.
      const conversationCheckpointStore = yield* ConversationCheckpointStore;
      // E06 normalization (architecture-evolution object 1, first seam):
      // inbox draining is production-required — the composition root
      // always provides both services — and a missing pair previously
      // silently disabled workspace input promotion. They are now typed
      // requirements of the driver Layer.
      const inbox = yield* InboxProjectionStore;
      const inputPromotion = yield* InputPromotionService;
      const tx = yield* TransactionPort;
      const invocationStore = yield* ToolInvocationStore;
      const p39Recovery = yield* P39RecoveryEvidenceStore;
      const loopStepStoreOption =
        yield* Effect.serviceOption(AgentLoopStepStore);
      const providerTurnStoreOption =
        yield* Effect.serviceOption(ProviderTurnStore);
      const configuredLoopSteps = Option.isSome(loopStepStoreOption)
        ? loopStepStoreOption.value
        : undefined;
      const providerTurns = Option.isSome(providerTurnStoreOption)
        ? providerTurnStoreOption.value
        : undefined;
      const decisionRequests = yield* DecisionRequestStore;
      const clock = yield* Clock;
      const controlRegistry =
        options.controlRegistry ?? makeControlToolRegistry();
      const failure = toExecutionDriverError;

      const drive = (input: {
        readonly execution: Execution;
        readonly agentExecutionState: AgentExecutionState;
        readonly wakeReason: WakeReason;
        readonly context: import("@arbor/domain").CommandSubmissionContext;
        readonly safetyGate: RuntimeSafetyGateService;
        readonly cancellationSignal?: ProviderCancellationSignal;
      }): Effect.Effect<ExecutionDriveOutcome, ExecutionDriverError> =>
        Effect.gen(function* () {
          const commitSettlementProposal = (
            settlement: import("@arbor/domain").ExecutionSettlement,
          ) => settlementProposal(settlement).settlement;
          if (
            input.execution.binding._tag === "WorkspaceExecution" &&
            executionEpisode(input.execution) === undefined
          ) {
            return {
              _tag: "Failed",
              failure: {
                _tag: "ExecutionFailure",
                reason: "legacy ambiguous Workspace execution cannot be driven",
              },
            } as const;
          }
          const loopSteps =
            configuredLoopSteps !== undefined &&
            (yield* tx
              .transact(configuredLoopSteps.isAvailable())
              .pipe(Effect.mapError(failure)))
              ? configuredLoopSteps
              : undefined;
          const frontier = yield* recoverAgentLoopFrontier(
            input,
            loopSteps,
            providerTurns,
            invocationStore,
            p39Recovery,
            conversationCheckpointStore,
            decisionRequests,
            sessions,
            tx,
            failure,
            options,
          );
          if (frontier._tag === "Terminal") return frontier.outcome;
          const {
            firstLogicalStepNo,
            firstRepairAttempt,
            exactNotAdmittedRecovery,
          } = frontier;
          // P12 `08` §7: the driver reports the D1/D3/D4/D5/D6 observation
          // signals at the ProviderTurn / ToolInvocation / Specialist
          // boundaries. The gate never reads durable state (R = never).
          const now = clock.now;
          const leaseGeneration =
            input.context._tag === "ExecutionOrigin"
              ? input.context.fencingGeneration
              : undefined;
          const loopStepFence: AgentLoopStepFence | undefined =
            input.context._tag === "ExecutionOrigin" &&
            input.context.workerId !== undefined &&
            input.context.workerIncarnationId !== undefined
              ? {
                  executionId: input.execution.executionId,
                  workerId: input.context.workerId,
                  workerIncarnationId: input.context.workerIncarnationId,
                  fencingGeneration: input.context.fencingGeneration,
                }
              : undefined;
          const admit = (
            activity: ExecutionActivity,
            observation: RuntimeSafetyObservation,
          ): Effect.Effect<"Continue" | "Stop"> =>
            input.safetyGate.admitActivity(
              input.execution.executionId,
              activity,
              observation,
            );
          let progressedSinceBoundary = false;
          const admitProviderTurn = (
            operationKind: PortableOperationKind,
            compiledRequestHash: string,
          ) =>
            Effect.gen(function* () {
              const activity: ExecutionActivity = {
                _tag: "ProviderTurn",
                fingerprint: providerTurnSafetyFingerprint(
                  operationKind,
                  compiledRequestHash,
                ),
              };
              const decision = yield* admit(activity, {
                retryCount: 0,
                chainDepth: 0,
                durableProgress: progressedSinceBoundary,
                ...(leaseGeneration !== undefined
                  ? { inFlight: "begin" as const, leaseGeneration }
                  : {}),
                observedAt: yield* now(),
              });
              if (decision === "Continue") {
                progressedSinceBoundary = false;
              }
              return { activity, decision } as const;
            });
          const completeProviderTurn = (
            activity: ExecutionActivity,
            attemptNo?: number,
          ) =>
            Effect.gen(function* () {
              if (
                leaseGeneration === undefined &&
                (attemptNo === undefined || attemptNo === 0)
              ) {
                return "Continue" as const;
              }
              return yield* admit(activity, {
                ...(attemptNo === undefined ? {} : { retryCount: attemptNo }),
                inFlight: "end",
                ...(leaseGeneration !== undefined ? { leaseGeneration } : {}),
                observedAt: yield* now(),
              });
            });

          const boundModelDecision = yield* modelDecisionService.forExecution({
            execution: input.execution,
            agentExecutionState: input.agentExecutionState,
            context: input.context,
            ...(loopSteps === undefined ? {} : { loopSteps }),
            ...(loopStepFence === undefined ? {} : { loopStepFence }),
            ...(providerTurns === undefined ? {} : { providerTurns }),
            ...(input.cancellationSignal === undefined
              ? {}
              : { cancellationSignal: input.cancellationSignal }),
            admitProviderTurn,
            completeProviderTurn,
            now,
          });
          const currentControlBasis = boundModelDecision.currentControlBasis;

          for (
            let turn = firstLogicalStepNo, repairAttempt = firstRepairAttempt;
            turn < MAX_TURNS;
            turn += 1, repairAttempt = 0
          ) {
            if (loopStepFence !== undefined) {
              const pending = yield* tx
                .transact(inbox.listUnconsumed(input.execution.workspaceId))
                .pipe(Effect.mapError(failure));
              const workspaceInputExecution =
                input.execution.binding._tag === "WorkspaceExecution" &&
                (executionEpisode(input.execution)?._tag === "WorkEpisode" ||
                  executionEpisode(input.execution)?._tag === "InboxEpisode");
              // Child PASS notifications are addressed to the owning Parent
              // Workspace. They are consumable by a WorkEpisode or the
              // InboxEpisode admitted for that Workspace, both of which expose
              // the placement/accept_result control surface. A
              // RootConversation must not consume them before a workspace
              // execution is admitted; doing so loses the ready result from
              // the Work's durable frontier.
              const eligiblePending = workspaceInputExecution
                ? pending
                : pending.filter(
                    (entry) => !entry.entryKey.startsWith("child-result:"),
                  );
              for (const selected of selectPendingInputPromotions(
                eligiblePending,
                {
                  freshDrain: turn === 0,
                },
              )) {
                yield* inputPromotion
                  .promoteInbox({
                    workspaceId: input.execution.workspaceId,
                    entryKey: selected.entry.entryKey,
                    targetSessionId: input.execution.sessionId,
                    delivery: selected.delivery,
                    fence: loopStepFence,
                  })
                  .pipe(Effect.mapError(failure));
              }
            }
            const modelDecision = yield* boundModelDecision.decide({
              turn,
              repairAttempt,
              ...(exactNotAdmittedRecovery !== undefined &&
              exactNotAdmittedRecovery.logicalStepNo === turn &&
              exactNotAdmittedRecovery.repairAttempt === repairAttempt
                ? {
                    resumeExactActionStepIdentity: exactNotAdmittedRecovery,
                  }
                : {}),
            });
            if (modelDecision._tag === "Settle") {
              return commitSettlementProposal(modelDecision.settlement);
            }
            if (modelDecision._tag === "SubmittedDecisionBindingMismatch") {
              return modelDecision;
            }
            if (modelDecision._tag === "RecoveryBlocked") {
              return { _tag: "RecoveryBlocked" } as const;
            }
            const preparedTurn = modelDecision.turn;
            const decodedOutput = modelDecision.output;
            let currentLoopStep = modelDecision.loopStep;
            const actionProgression = yield* executeAgentLoopActions({
              input,
              preparedTurn,
              decodedOutput,
              turn,
              ...(currentLoopStep === undefined ? {} : { currentLoopStep }),
              ...(loopSteps === undefined ? {} : { loopSteps }),
              ...(providerTurns === undefined ? {} : { providerTurns }),
              inboxSequence: inbox,
              ...(loopStepFence === undefined ? {} : { loopStepFence }),
              tx,
              sessions,
              controlRegistry,
              ...(options.controlAuthorizer === undefined
                ? {}
                : { controlAuthorizer: options.controlAuthorizer }),
              ...(options.executableInvocationHandler === undefined
                ? {}
                : {
                    executableInvocationHandler:
                      options.executableInvocationHandler,
                  }),
              ...(exactNotAdmittedRecovery === undefined ||
              exactNotAdmittedRecovery.logicalStepNo !== turn ||
              exactNotAdmittedRecovery.repairAttempt !== repairAttempt
                ? {}
                : {
                    recoverExactNotAdmittedAction: exactNotAdmittedRecovery,
                  }),
              ...(options.recordReconciliationEscalation === undefined
                ? {}
                : {
                    recordReconciliationEscalation:
                      options.recordReconciliationEscalation,
                  }),
              currentControlBasis,
              admit,
              failure,
              now,
              ...(options.qualificationProbe === undefined
                ? {}
                : { qualificationProbe: options.qualificationProbe }),
            });
            if (actionProgression._tag === "Settle") {
              return commitSettlementProposal(actionProgression.settlement);
            }
            if (actionProgression._tag === "SandboxProviderUnavailable") {
              return actionProgression;
            }
            if (
              actionProgression._tag === "SandboxPolicyRequiredInterruption"
            ) {
              return actionProgression;
            }
            if (actionProgression._tag === "DecisionStale") {
              continue;
            }
            if (actionProgression._tag === "RecoveryBlocked") {
              return { _tag: "RecoveryBlocked" };
            }
            if (actionProgression._tag === "ApprovalRequired") {
              return actionProgression;
            }
            currentLoopStep = actionProgression.loopStep;
            progressedSinceBoundary =
              progressedSinceBoundary || actionProgression.durableProgress;
            const observations = actionProgression.observations;
            const finalization = yield* completeAgentLoopStep({
              input,
              decodedOutput,
              observations,
              conversation: modelDecision.conversation === true,
              turn,
              ...(currentLoopStep === undefined ? {} : { currentLoopStep }),
              ...(loopSteps === undefined ? {} : { loopSteps }),
              ...(loopStepFence === undefined ? {} : { loopStepFence }),
              tx,
              sessions,
              now,
              ...(options.qualificationProbe === undefined
                ? {}
                : { qualificationProbe: options.qualificationProbe }),
            }).pipe(Effect.mapError(foldAgentLoopStepCompletionError));
            if (finalization._tag === "Settle") {
              return commitSettlementProposal(finalization.settlement);
            }
          }
          return {
            _tag: "Failed",
            failure: { _tag: "ExecutionFailure", reason: "max turns reached" },
          };
        });

      return ExecutionDriverPort.of({ drive });
    }),
  );

export { Option };
