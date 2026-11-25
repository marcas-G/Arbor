import { InputPromotionService } from "@arbor/application";
import type {
  AgentBinding,
  AgentExecutionState,
  Execution,
  WakeReason,
} from "@arbor/domain";
import { executionEpisode } from "@arbor/domain";
import {
  ModelContext,
  makeTurnProfileResolver,
  type TurnProfileResolverService,
} from "@arbor/model-context";
import {
  type AgentLoopStepFence,
  AgentLoopStepStore,
  BlobStorePort,
  Clock,
  ConversationAttemptStore,
  ConversationCheckpointStore,
  ConversationResponseJobStore,
  DecisionRequestStore,
  EnvironmentRevisionStore,
  type ExecutionActivity,
  type ExecutionDriveOutcome,
  type ExecutionDriverError,
  ExecutionDriverPort,
  ExecutionRepository,
  HumanMessageStore,
  InboxProjectionStore,
  LocalPlanStore,
  ModelCapabilityPort,
  P39RecoveryEvidenceStore,
  type PortableOperationKind,
  ProjectRepository,
  type ProviderCancellationSignal,
  type ProviderExecutionPolicyOverrides,
  ProviderRuntime,
  ProviderTurnStore,
  RecoveryAttentionFactStore,
  type RuntimeSafetyGateService,
  type RuntimeSafetyObservation,
  type SecretRef,
  SessionRepository,
  ToolInvocationStore,
  TransactionPort,
  WorkRepository,
  WorkspaceKnowledgePort,
  WorkspacePlacementPort,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { executeAgentLoopActions } from "./agent-loop-actions.js";
import { recoverAgentLoopFrontier } from "./agent-loop-driver/recovery.js";
import { MAX_TURNS, type ModelDecisionOutcome } from "./agent-loop-policy.js";
import { completeAgentLoopStep } from "./agent-loop-step-completion.js";
import {
  type ControlToolRegistryService,
  type ExecutableInvocationHandler,
  makeControlToolRegistry,
} from "./control.js";
import type { ControlActionAuthorizerService } from "./control-authorization.js";
import { makeControlBasisResolver } from "./control-basis-resolver.js";
import { toExecutionDriverError } from "./execution-driver-failure.js";
import { runModelDecision } from "./model-decision.js";
import { recordAcceptedModelOutput } from "./model-output-journal.js";
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
  /** Durable StopExecution is relayed to the active Provider transport through
   * the standard AbortSignal contract. */
  readonly cancellationSignal?: ProviderCancellationSignal;
  /** P12 `03` §3: the credential reference the driver binds to a ProviderTurn.
   * Comes from Composition-Root config; the driver never hardcodes a raw ref.
   * The raw credential is resolved by ProviderRuntime at the execution
   * boundary and never reaches the Agent. */
  readonly secretRef?: SecretRef;
  /** Deployment-level execution limits resolved at the composition root.
   * Provider Runtime owns their final merge with system/provider defaults. */
  readonly executionPolicyOverrides?: ProviderExecutionPolicyOverrides;
  /** The typed control-tool registry. Composition supplies the live registry;
   * the default keeps Wait available for focused runtime tests. */
  readonly controlRegistry?: ControlToolRegistryService;
  readonly controlAuthorizer?: ControlActionAuthorizerService;
  readonly turnProfileResolver?: TurnProfileResolverService;
  readonly executableInvocationHandler?: ExecutableInvocationHandler;
  /** P9 durable recovery escalation for unknown external effects. */
  readonly recordReconciliationEscalation?: (input: {
    readonly execution: Execution;
    readonly fence: AgentLoopStepFence;
    readonly principal: import("@arbor/domain").Principal;
    readonly invocationRefs: ReadonlyArray<string>;
  }) => Effect.Effect<void, unknown>;
  /** Adapter identity recorded on manifests (P14 conversation audit). */
  readonly providerRef?: string;
  /** Exact protocol family used to bind P16 reasoning attachments. */
  readonly protocolFamily?: string;
  /** Presentation-only progress tap (conversation streaming): receives every
   * ProviderRuntimeProgress event tagged with the driving executionId. It
   * must never affect model/execution semantics (the provider runtime
   * already isolates observer throws). */
  readonly onProviderProgress?:
    | ((
        executionId: string,
        event: import("@arbor/ports").ProviderRuntimeProgress,
      ) => void)
    | undefined;
  readonly qualificationProbe?: AgentLoopQualificationProbe;
}
export const AgentLoopDriverLive = (
  options: AgentLoopDriverOptions = {},
): Layer.Layer<
  ExecutionDriverPort,
  never,
  | ModelContext
  | ProviderRuntime
  | ModelCapabilityPort
  | SessionRepository
  | TransactionPort
  | EnvironmentRevisionStore
  | HumanMessageStore
  | ProjectRepository
  | WorkRepository
  | WorkspaceRepository
  | InboxProjectionStore
  | InputPromotionService
  | ConversationCheckpointStore
  | BlobStorePort
  | ConversationResponseJobStore
  | ConversationAttemptStore
  | ExecutionRepository
  | RecoveryAttentionFactStore
  | WorkspaceKnowledgePort
  | WorkspacePlacementPort
  | LocalPlanStore
  | DecisionRequestStore
  | ToolInvocationStore
  | P39RecoveryEvidenceStore
  | Clock
> =>
  Layer.effect(
    ExecutionDriverPort,
    Effect.gen(function* () {
      const modelContext = yield* ModelContext;
      const providerRuntime = yield* ProviderRuntime;
      const capabilityPort = yield* ModelCapabilityPort;
      const sessions = yield* SessionRepository;
      const humanMessages = yield* HumanMessageStore;
      // E06 normalization (object 1, batch two): every service the
      // production composition always provides becomes a typed Layer
      // requirement. Only AgentLoopStepStore/ProviderTurnStore keep their
      // optionality — their absence carries schema-migration gating that
      // must stay fail-closed rather than become a type-level demand.
      const conversationCheckpointStore = yield* ConversationCheckpointStore;
      const blobStore = yield* BlobStorePort;
      const responseJobs = yield* ConversationResponseJobStore;
      const responseAttempts = yield* ConversationAttemptStore;
      const executions = yield* ExecutionRepository;
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
      const recoveryAttentionFacts = yield* RecoveryAttentionFactStore;
      const configuredLoopSteps = Option.isSome(loopStepStoreOption)
        ? loopStepStoreOption.value
        : undefined;
      const providerTurns = Option.isSome(providerTurnStoreOption)
        ? providerTurnStoreOption.value
        : undefined;
      const environmentRevisions = yield* EnvironmentRevisionStore;
      const projects = yield* ProjectRepository;
      const workspaces = yield* WorkspaceRepository;
      const works = yield* WorkRepository;
      const _workspaceKnowledge = yield* WorkspaceKnowledgePort;
      const _workspacePlacement = yield* WorkspacePlacementPort;
      const localPlans = yield* LocalPlanStore;
      const decisionRequests = yield* DecisionRequestStore;
      const clock = yield* Clock;
      const controlRegistry =
        options.controlRegistry ?? makeControlToolRegistry();
      const turnProfileResolver =
        options.turnProfileResolver ??
        makeTurnProfileResolver({
          toolCatalog: {
            visibleRefs: () => Effect.succeed([]),
            resolveForModel: (ref) =>
              Effect.fail({ _tag: "ToolNotRegistered", ref }),
          },
          controlCatalog: controlRegistry,
        });
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
          const agentBinding: AgentBinding =
            input.execution.binding._tag === "WorkspaceExecution"
              ? {
                  _tag: "ResponsibilityBoundAgentBinding",
                  workspaceId: input.execution.binding.workspaceId,
                }
              : input.execution.binding;
          const capability = yield* capabilityPort
            .resolve({
              binding: agentBinding,
              cognitiveMode: input.agentExecutionState.currentMode ?? "execute",
              requiredCapabilities: [],
            })
            .pipe(Effect.mapError(failure));
          // DID §8.19 / P3 `06` §4: capture and re-read the full trusted
          // control basis at every effectful action admission.
          const currentControlBasis = makeControlBasisResolver(
            {
              tx,
              projects,
              workspaces,
              works,
              environmentRevisions,
              failure,
            },
            input,
          );

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

          // P3 `06` §3: bounded `ModelOutputContractViolation` repair. A
          // violated output is NOT a provider transport failure: re-invoke
          // prepareTurn with an A4 repair instruction fragment (a fresh
          // ProviderTurn) and re-validate, up to the bounded attempt count.
          // On exhaustion the frozen settle rule applies (Failed, or
          // Interrupted for a safety/looping signal).
          const decideModelOutput = (
            turn: number,
            repairAttempt: number,
            resumeExactActionStepIdentity?: {
              readonly executionId: import("@arbor/domain").ExecutionId;
              readonly logicalStepNo: number;
              readonly repairAttempt: number;
            },
          ): Effect.Effect<ModelDecisionOutcome, ExecutionDriverError> =>
            runModelDecision(
              {
                input: {
                  execution: input.execution,
                  agentExecutionState: input.agentExecutionState,
                },
                agentBinding,
                capability,
                currentControlBasis,
                modelContext,
                providerRuntime,
                tx,
                sessions,
                humanMessages,
                conversationCheckpoints: conversationCheckpointStore,
                blobs: blobStore,
                turnProfileResolver,
                responseJobs,
                responseAttempts,
                executions,
                works,
                localPlans,
                decisionRequests,
                workspaces,
                options: {
                  ...options,
                  ...((input.cancellationSignal ??
                    options.cancellationSignal) === undefined
                    ? {}
                    : {
                        cancellationSignal:
                          input.cancellationSignal ??
                          options.cancellationSignal,
                      }),
                  ...(resumeExactActionStepIdentity === undefined
                    ? {}
                    : { resumeExactActionStepIdentity }),
                },
                admitProviderTurn,
                completeProviderTurn,
                failure,
                now,
                ...(loopSteps === undefined ? {} : { loopSteps }),
                ...(loopStepFence === undefined ? {} : { loopStepFence }),
                ...(providerTurns === undefined ? {} : { providerTurns }),
                recoveryAttentionFacts,
              },
              turn,
              repairAttempt,
            );

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
            const modelDecision = yield* decideModelOutput(
              turn,
              repairAttempt,
              exactNotAdmittedRecovery !== undefined &&
                exactNotAdmittedRecovery.logicalStepNo === turn &&
                exactNotAdmittedRecovery.repairAttempt === repairAttempt
                ? exactNotAdmittedRecovery
                : undefined,
            );
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
            let currentLoopStep = yield* recordAcceptedModelOutput({
              input,
              preparedTurn,
              decodedOutput,
              ...(modelDecision.loopStep === undefined
                ? {}
                : { currentLoopStep: modelDecision.loopStep }),
              ...(loopSteps === undefined ? {} : { loopSteps }),
              ...(providerTurns === undefined ? {} : { providerTurns }),

              ...(loopStepFence === undefined ? {} : { loopStepFence }),
              tx,
              sessions,
              failure,
              now,
              ...(options.qualificationProbe === undefined
                ? {}
                : { qualificationProbe: options.qualificationProbe }),
            });
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
              failure,
              now,
              ...(options.qualificationProbe === undefined
                ? {}
                : { qualificationProbe: options.qualificationProbe }),
            });
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
