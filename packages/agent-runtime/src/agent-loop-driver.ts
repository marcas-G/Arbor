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
  type AgentLoopStepRecord,
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
  ProjectRepository,
  type ProviderExecutionPolicyOverrides,
  ProviderRuntime,
  ProviderTurnStore,
  RecoveryAttentionFactStore,
  type RuntimeSafetyGateService,
  type RuntimeSafetyObservation,
  type SecretRef,
  SessionRepository,
  TransactionPort,
  WorkRepository,
  WorkspaceKnowledgePort,
  WorkspacePlacementPort,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { executeAgentLoopActions } from "./agent-loop-actions.js";
import {
  MAX_TURNS,
  type ModelDecisionOutcome,
  safetyStop,
} from "./agent-loop-policy.js";
import { completeAgentLoopStep } from "./agent-loop-step-completion.js";
import {
  decodeExhaustedRepairDisposition,
  retryDispositionMatchesSuccessor,
} from "./agent-loop-step-recovery.js";
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
import type { AgentLoopQualificationProbe } from "./qualification-probe.js";
import { selectPendingInputPromotions } from "./safe-input-drain.js";

export interface AgentLoopStepCursor {
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
}

const sameStepIdentity = (
  left: AgentLoopStepRecord["identity"],
  right: AgentLoopStepRecord["identity"],
): boolean =>
  left.executionId === right.executionId &&
  left.logicalStepNo === right.logicalStepNo &&
  left.repairAttempt === right.repairAttempt;

const compareStepIdentity = (
  left: AgentLoopStepRecord,
  right: AgentLoopStepRecord,
): number =>
  left.identity.logicalStepNo - right.identity.logicalStepNo ||
  left.identity.repairAttempt - right.identity.repairAttempt;

/** Validate the entire durable predecessor/successor chain before choosing its
 * only resumable frontier. A valid history has one exact root, consecutive
 * repairs/steps, and every earlier row durably closed into the next row. */
export const selectInitialAgentLoopStepCursor = (
  steps: ReadonlyArray<AgentLoopStepRecord>,
): AgentLoopStepCursor | undefined => {
  if (steps.length === 0) return { logicalStepNo: 0, repairAttempt: 0 };

  const ordered = [...steps].sort(compareStepIdentity);
  const root = ordered[0];
  if (
    root === undefined ||
    root.identity.logicalStepNo !== 0 ||
    root.identity.repairAttempt !== 0 ||
    root.predecessor !== undefined
  ) {
    return undefined;
  }

  const identities = new Set<string>();
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index];
    if (
      current === undefined ||
      current.identity.executionId !== root.identity.executionId ||
      !Number.isSafeInteger(current.identity.logicalStepNo) ||
      current.identity.logicalStepNo < 0 ||
      !Number.isSafeInteger(current.identity.repairAttempt) ||
      current.identity.repairAttempt < 0 ||
      current.providerTurnId.length === 0
    ) {
      return undefined;
    }
    const key = `${current.identity.executionId}:${current.identity.logicalStepNo}:${current.identity.repairAttempt}`;
    if (identities.has(key)) return undefined;
    identities.add(key);

    if (index === 0) continue;
    const previous = ordered[index - 1];
    if (
      previous === undefined ||
      current.predecessor === undefined ||
      !sameStepIdentity(current.predecessor, previous.identity) ||
      previous.successor === undefined ||
      !sameStepIdentity(previous.successor, current.identity) ||
      previous.successor.providerTurnId !== current.providerTurnId
    ) {
      return undefined;
    }
    const isRepairSuccessor =
      current.identity.logicalStepNo === previous.identity.logicalStepNo &&
      current.identity.repairAttempt === previous.identity.repairAttempt + 1;
    const isNextStepSuccessor =
      current.identity.logicalStepNo === previous.identity.logicalStepNo + 1 &&
      current.identity.repairAttempt === 0;
    if (
      (previous.state === "OutputRejected" && !isRepairSuccessor) ||
      (previous.state === "NextStepReady" && !isNextStepSuccessor) ||
      (previous.state !== "OutputRejected" &&
        previous.state !== "NextStepReady")
    ) {
      return undefined;
    }
    if (
      previous.state === "OutputRejected" &&
      !retryDispositionMatchesSuccessor(previous, current)
    ) {
      return undefined;
    }
  }

  const current = ordered.at(-1);
  if (
    current === undefined ||
    current.successor !== undefined ||
    current.state === "NextStepReady" ||
    (current.state === "OutputRejected" &&
      decodeExhaustedRepairDisposition(current.repairDisposition) === undefined)
  ) {
    return undefined;
  }
  return {
    logicalStepNo: current.identity.logicalStepNo,
    repairAttempt: current.identity.repairAttempt,
  };
};

/** A Prepared row is still bound to the ProviderTurn manifest allocated for
 * that exact Execution/session/cursor; recovery must not trust the row state
 * to skip this binding check. */
export const isAgentLoopStepManifestBound = (
  step: AgentLoopStepRecord,
  executionId: Execution["executionId"],
  sessionId: Execution["sessionId"],
  persistedManifest: {
    readonly manifestId: string;
    readonly manifestJson: string;
  } | null,
): boolean => {
  if (persistedManifest === null || step.providerTurnId.length === 0) {
    return false;
  }
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(persistedManifest.manifestJson);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return false;
    }
    manifest = parsed as Record<string, unknown>;
  } catch {
    return false;
  }
  return (
    manifest.providerTurnId === step.providerTurnId &&
    manifest.executionId === executionId &&
    manifest.sessionId === sessionId &&
    manifest.logicalStepNo === step.identity.logicalStepNo &&
    manifest.repairAttempt === step.identity.repairAttempt &&
    (step.manifestId === undefined ||
      step.manifestId === persistedManifest.manifestId)
  );
};

export interface AgentLoopDriverOptions {
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
      const conversationCheckpointOption = yield* Effect.serviceOption(
        ConversationCheckpointStore,
      );
      const blobStoreOption = yield* Effect.serviceOption(BlobStorePort);
      const responseJobsOption = yield* Effect.serviceOption(
        ConversationResponseJobStore,
      );
      const responseAttemptsOption = yield* Effect.serviceOption(
        ConversationAttemptStore,
      );
      const executionRepositoryOption =
        yield* Effect.serviceOption(ExecutionRepository);
      const inboxOption = yield* Effect.serviceOption(InboxProjectionStore);
      const inputPromotionOption = yield* Effect.serviceOption(
        InputPromotionService,
      );
      const tx = yield* TransactionPort;
      const loopStepStoreOption =
        yield* Effect.serviceOption(AgentLoopStepStore);
      const providerTurnStoreOption =
        yield* Effect.serviceOption(ProviderTurnStore);
      const recoveryAttentionFactStoreOption = yield* Effect.serviceOption(
        RecoveryAttentionFactStore,
      );
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
      const workspaceKnowledgeOption = yield* Effect.serviceOption(
        WorkspaceKnowledgePort,
      );
      const workspacePlacementOption = yield* Effect.serviceOption(
        WorkspacePlacementPort,
      );
      const localPlansOption = yield* Effect.serviceOption(LocalPlanStore);
      const decisionRequestsOption =
        yield* Effect.serviceOption(DecisionRequestStore);
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
      }): Effect.Effect<ExecutionDriveOutcome, ExecutionDriverError> =>
        Effect.gen(function* () {
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
          // Resume from the latest durable P9 cursor, not turn zero. Without
          // this, a restart after a completed earlier step can re-open its
          // old executable output and repair later unresolved ToolCalls as
          // interrupted, even though a successor step is already persisted.
          let firstLogicalStepNo = 0;
          let firstRepairAttempt = 0;
          if (loopSteps !== undefined) {
            const persistedSteps = yield* tx
              .transact(loopSteps.listByExecution(input.execution.executionId))
              .pipe(Effect.mapError(failure));
            const cursor = selectInitialAgentLoopStepCursor(persistedSteps);
            if (cursor === undefined) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            firstLogicalStepNo = cursor.logicalStepNo;
            firstRepairAttempt = cursor.repairAttempt;
            if (persistedSteps.length > 0) {
              const current = persistedSteps.find(
                (step) =>
                  step.identity.logicalStepNo === cursor.logicalStepNo &&
                  step.identity.repairAttempt === cursor.repairAttempt,
              );
              if (
                current === undefined ||
                current.identity.executionId !== input.execution.executionId
              ) {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              if (providerTurns === undefined) {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              const priorManifest = yield* tx
                .transact(
                  providerTurns.findManifestByTurn(current.providerTurnId),
                )
                .pipe(Effect.mapError(failure));
              if (
                !isAgentLoopStepManifestBound(
                  current,
                  input.execution.executionId,
                  input.execution.sessionId,
                  priorManifest,
                )
              ) {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
            }
          }
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
              ...(Option.isSome(workspaceKnowledgeOption)
                ? { workspaceKnowledge: workspaceKnowledgeOption.value }
                : {}),
              ...(Option.isSome(workspacePlacementOption)
                ? { workspacePlacement: workspacePlacementOption.value }
                : {}),
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

          // P3 `06` §3: bounded `ModelOutputContractViolation` repair. A
          // violated output is NOT a provider transport failure: re-invoke
          // prepareTurn with an A4 repair instruction fragment (a fresh
          // ProviderTurn) and re-validate, up to the bounded attempt count.
          // On exhaustion the frozen settle rule applies (Failed, or
          // Interrupted for a safety/looping signal).
          const decideModelOutput = (
            turn: number,
            activity: ExecutionActivity,
            repairAttempt: number,
          ): Effect.Effect<ModelDecisionOutcome, ExecutionDriverError> =>
            runModelDecision(
              {
                input,
                agentBinding,
                capability,
                currentControlBasis,
                modelContext,
                providerRuntime,
                tx,
                sessions,
                humanMessages,
                ...(Option.isSome(conversationCheckpointOption)
                  ? {
                      conversationCheckpoints:
                        conversationCheckpointOption.value,
                    }
                  : {}),
                ...(Option.isSome(blobStoreOption)
                  ? { blobs: blobStoreOption.value }
                  : {}),
                turnProfileResolver,
                ...(Option.isSome(responseJobsOption)
                  ? { responseJobs: responseJobsOption.value }
                  : {}),
                ...(Option.isSome(responseAttemptsOption)
                  ? { responseAttempts: responseAttemptsOption.value }
                  : {}),
                ...(Option.isSome(executionRepositoryOption)
                  ? { executions: executionRepositoryOption.value }
                  : {}),
                works,
                ...(Option.isSome(localPlansOption)
                  ? { localPlans: localPlansOption.value }
                  : {}),
                ...(Option.isSome(decisionRequestsOption)
                  ? { decisionRequests: decisionRequestsOption.value }
                  : {}),
                workspaces,
                options,
                admit,
                failure,
                now,
                ...(loopSteps === undefined ? {} : { loopSteps }),
                ...(loopStepFence === undefined ? {} : { loopStepFence }),
                ...(providerTurns === undefined ? {} : { providerTurns }),
                ...(Option.isSome(recoveryAttentionFactStoreOption)
                  ? {
                      recoveryAttentionFacts:
                        recoveryAttentionFactStoreOption.value,
                    }
                  : {}),
                ...(leaseGeneration === undefined ? {} : { leaseGeneration }),
              },
              turn,
              activity,
              repairAttempt,
            );

          for (
            let turn = firstLogicalStepNo, repairAttempt = firstRepairAttempt;
            turn < MAX_TURNS;
            turn += 1, repairAttempt = 0
          ) {
            if (
              Option.isSome(inboxOption) &&
              Option.isSome(inputPromotionOption) &&
              loopStepFence !== undefined
            ) {
              const pending = yield* tx
                .transact(
                  inboxOption.value.listUnconsumed(input.execution.workspaceId),
                )
                .pipe(Effect.mapError(failure));
              for (const selected of selectPendingInputPromotions(pending, {
                freshDrain: turn === 0,
              })) {
                yield* inputPromotionOption.value
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
            const activity: ExecutionActivity = {
              _tag: "ProviderTurn",
              fingerprint: `turn-${turn}`,
            };
            // D4: durable progress since the previous turn boundary. The
            // driver holds the journal capability and reports the boolean;
            // the gate only counts it. D5: begin-bracket the provider call.
            const decision = yield* admit(activity, {
              retryCount: 0,
              chainDepth: 0,
              durableProgress: progressedSinceBoundary,
              ...(leaseGeneration !== undefined
                ? { inFlight: "begin" as const, leaseGeneration }
                : {}),
              observedAt: yield* now(),
            });
            if (decision === "Stop") {
              return safetyStop("RuntimeSafetyStop");
            }
            progressedSinceBoundary = false;

            const modelDecision = yield* decideModelOutput(
              turn,
              activity,
              repairAttempt,
            );
            if (modelDecision._tag === "Settle") {
              return modelDecision.settlement;
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
              ...(Option.isSome(inboxOption)
                ? { inboxSequence: inboxOption.value }
                : {}),
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
              return actionProgression.settlement;
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
              return finalization.settlement;
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
