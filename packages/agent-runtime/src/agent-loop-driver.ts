import { InputPromotionService } from "@arbor/application";
import type {
  AgentBinding,
  AgentExecutionState,
  Execution,
  ExecutionSettlement,
  WakeReason,
} from "@arbor/domain";
import { ModelContext } from "@arbor/model-context";
import {
  type AgentLoopStepFence,
  AgentLoopStepStore,
  Clock,
  EnvironmentRevisionStore,
  type ExecutionActivity,
  type ExecutionDriverError,
  ExecutionDriverPort,
  HumanMessageStore,
  InboxProjectionStore,
  ModelCapabilityPort,
  ProjectRepository,
  type ProviderExecutionPolicyOverrides,
  ProviderRuntime,
  ProviderTurnStore,
  type RuntimeSafetyGateService,
  type RuntimeSafetyObservation,
  type SecretRef,
  SessionRepository,
  TransactionPort,
  WorkRepository,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { executeAgentLoopActions } from "./agent-loop-actions.js";
import {
  isConversationExecution,
  MAX_TURNS,
  type ModelDecisionOutcome,
  safetyStop,
} from "./agent-loop-policy.js";
import { completeAgentLoopStep } from "./agent-loop-step-completion.js";
import {
  type ControlToolRegistryService,
  type ExecutableInvocationHandler,
  makeControlToolRegistry,
} from "./control.js";
import { makeControlBasisResolver } from "./control-basis-resolver.js";
import { runModelDecision } from "./model-decision.js";
import { recordAcceptedModelOutput } from "./model-output-journal.js";
import { selectPendingInputPromotions } from "./safe-input-drain.js";

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
  readonly executableInvocationHandler?: ExecutableInvocationHandler;
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
      const inboxOption = yield* Effect.serviceOption(InboxProjectionStore);
      const inputPromotionOption = yield* Effect.serviceOption(
        InputPromotionService,
      );
      const tx = yield* TransactionPort;
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
      const environmentRevisions = yield* EnvironmentRevisionStore;
      const projects = yield* ProjectRepository;
      const workspaces = yield* WorkspaceRepository;
      const works = yield* WorkRepository;
      const clock = yield* Clock;
      const controlRegistry =
        options.controlRegistry ?? makeControlToolRegistry();
      const failure = (cause: unknown): ExecutionDriverError => ({
        _tag: "ExecutionDriverError",
        cause,
      });

      const drive = (input: {
        readonly execution: Execution;
        readonly agentExecutionState: AgentExecutionState;
        readonly wakeReason: WakeReason;
        readonly context: import("@arbor/domain").CommandSubmissionContext;
        readonly safetyGate: RuntimeSafetyGateService;
      }): Effect.Effect<ExecutionSettlement, ExecutionDriverError> =>
        Effect.gen(function* () {
          const loopSteps =
            configuredLoopSteps !== undefined &&
            (yield* tx
              .transact(configuredLoopSteps.isAvailable())
              .pipe(Effect.mapError(failure)))
              ? configuredLoopSteps
              : undefined;
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
            .pipe(
              Effect.mapError(
                (cause): ExecutionDriverError => ({
                  _tag: "ExecutionDriverError",
                  cause,
                }),
              ),
            );
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

          // P3 `06` §3: bounded `ModelOutputContractViolation` repair. A
          // violated output is NOT a provider transport failure: re-invoke
          // prepareTurn with an A4 repair instruction fragment (a fresh
          // ProviderTurn) and re-validate, up to the bounded attempt count.
          // On exhaustion the frozen settle rule applies (Failed, or
          // Interrupted for a safety/looping signal).
          const decideModelOutput = (
            turn: number,
            activity: ExecutionActivity,
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
                ...(Option.isSome(inboxOption) &&
                Option.isNone(inputPromotionOption)
                  ? { inbox: inboxOption.value }
                  : {}),
                works,
                workspaces,
                options,
                admit,
                failure,
                now,
                ...(loopSteps === undefined ? {} : { loopSteps }),
                ...(loopStepFence === undefined ? {} : { loopStepFence }),
                ...(providerTurns === undefined ? {} : { providerTurns }),
                ...(leaseGeneration === undefined ? {} : { leaseGeneration }),
              },
              turn,
              activity,
            );

          let sawToolInvocation = false;
          let producedText = false;
          for (let turn = 0; turn < MAX_TURNS; turn += 1) {
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

            const modelDecision = yield* decideModelOutput(turn, activity);
            if (modelDecision._tag === "Settle") {
              return modelDecision.settlement;
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
              ...(loopStepFence === undefined ? {} : { loopStepFence }),
              tx,
              sessions,
              failure,
              now,
            });
            const actionProgression = yield* executeAgentLoopActions({
              input,
              preparedTurn,
              decodedOutput,
              turn,
              ...(currentLoopStep === undefined ? {} : { currentLoopStep }),
              ...(loopSteps === undefined ? {} : { loopSteps }),
              ...(loopStepFence === undefined ? {} : { loopStepFence }),
              tx,
              sessions,
              controlRegistry,
              ...(options.executableInvocationHandler === undefined
                ? {}
                : {
                    executableInvocationHandler:
                      options.executableInvocationHandler,
                  }),
              currentControlBasis,
              admit,
              failure,
              now,
            });
            if (actionProgression._tag === "Settle") {
              return actionProgression.settlement;
            }
            if (actionProgression._tag === "DecisionStale") {
              continue;
            }
            currentLoopStep = actionProgression.loopStep;
            progressedSinceBoundary =
              progressedSinceBoundary || actionProgression.durableProgress;
            const observations = actionProgression.observations;
            sawToolInvocation =
              sawToolInvocation || decodedOutput.toolInvocations.length > 0;
            producedText = producedText || decodedOutput.text.trim().length > 0;
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
            });
            if (finalization._tag === "Settle") {
              return finalization.settlement;
            }
          }
          if (
            isConversationExecution(input.execution) &&
            !sawToolInvocation &&
            producedText
          ) {
            return {
              _tag: "Completed",
              result: { _tag: "QueryCompleted" },
            };
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
