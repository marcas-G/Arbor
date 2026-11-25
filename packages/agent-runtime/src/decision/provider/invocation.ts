import {
  type ExecutionSettlement,
  type ProviderTurnId,
  providerTurnNativeCompactionId,
  providerTurnOverflowReplacementId as makeOverflowReplacementProviderTurnId,
  providerTurnSummaryCompactionId,
} from "@arbor/domain";
import type { InstructionFragment, TurnPreparation } from "@arbor/model-context";
import type {
  AgentLoopStepRecord,
  ExecutionDriverError,
  PortableInputItem,
  ProviderRunInput,
} from "@arbor/ports";
import { PROVIDER_TURN_ADMISSION_EXECUTION_STOPPING } from "@arbor/ports";
import { Effect } from "effect";
import {
  isProviderExecutionTimeout,
  isProviderFailure,
  isProviderTurnBindingChanged,
  type ModelDecisionOutcome,
  providerExecutionTimeoutSettlement,
  providerFailureSettlement,
  providerTurnBindingChangedSettlement,
  safetyStop,
} from "../../agent-loop-policy.js";
import { runConversationCheckpointCompaction } from "../../checkpoint/conversation/compaction.js";
import { runCompaction, type SummaryCompactionInput } from "../../compaction-coordinator.js";
import type { AgentStepContext } from "../../step-context.js";
import type { ModelDecisionDependencies } from "../contract.js";
import type { ConversationDecisionContextResult } from "../conversation-context.js";
import type { OverflowRecoveryState } from "../recovery/overflow-state.js";
import { processSuccessfulProviderResult, type ProviderDecisionResult } from "./result.js";

type InvocationDependencies = Pick<
  ModelDecisionDependencies,
  "input" | "capability" | "providerRuntime" | "tx" | "loopSteps" |
  "loopStepFence" | "providerTurns" | "options" | "admitProviderTurn" |
  "completeProviderTurn" | "failure" | "now" | "conversationCheckpoints" | "blobs"
>;

/** Admit the exact prepared request, bracket the call, and recover its result.
 * Provider activities and fenced transitions remain in their original order. */
export const invokePreparedProviderTurn = (
  dependencies: InvocationDependencies,
  phase: {
    readonly turn: number;
    readonly repairAttempt: number;
    readonly repairFragments: ReadonlyArray<InstructionFragment>;
    readonly providerTurnId: ProviderTurnId;
    readonly loopStep: AgentLoopStepRecord | undefined;
    readonly preparation: Extract<TurnPreparation, { readonly _tag: "Ready" }>;
    readonly turnInput: ProviderRunInput;
    readonly overflow: OverflowRecoveryState;
    readonly conversation: Extract<ConversationDecisionContextResult, { readonly _tag: "Ready" }>;
    readonly stepContext: AgentStepContext;
    readonly inputItems: ReadonlyArray<PortableInputItem>;
    readonly messageContextRefs: ReadonlyArray<string>;
    readonly currentBindingFingerprint: string;
    readonly compactionDependencies: Parameters<typeof runCompaction>[1];
    readonly compactionWorkPinning: Pick<
      SummaryCompactionInput,
      "pinnedInstructions" | "pinnedInstructionFragments" | "controlBasis"
    >;
    readonly proposeSettlement: (
      settlement: ExecutionSettlement,
    ) => Effect.Effect<ModelDecisionOutcome, ExecutionDriverError>;
  },
): Effect.Effect<ProviderDecisionResult, ExecutionDriverError> => {
  const {
    input, capability, providerRuntime, tx, loopSteps, loopStepFence,
    providerTurns, options, admitProviderTurn, completeProviderTurn, failure, now,
  } = dependencies;
  const {
    turn, repairAttempt, repairFragments, providerTurnId, preparation, turnInput,
    stepContext, inputItems, messageContextRefs, currentBindingFingerprint,
    compactionDependencies, compactionWorkPinning, proposeSettlement,
  } = phase;
  const {
    conversationExecution, conversationOwner, conversationProjection,
    conversationCurrentJob, exactConversation,
  } = phase.conversation;
  return Effect.gen(function* () {
    const loopStep = phase.loopStep;
    let {
      overflowRecoveryAttempt, replayPersistedContextLimit,
      overflowReplacementProviderTurnId,
    } = phase.overflow;
    const recoveryState = (): OverflowRecoveryState => ({
      ...phase.overflow,
      overflowRecoveryAttempt, replayPersistedContextLimit,
      overflowReplacementProviderTurnId,
    });
    const providerAdmission = replayPersistedContextLimit
      ? undefined
      : yield* admitProviderTurn(
          preparation.turn.manifest.operationKind ?? "Inference",
          preparation.turn.manifest.compiledRequestHash,
        );
    if (providerAdmission?.decision === "Stop") {
      return yield* proposeSettlement(safetyStop("RuntimeSafetyStop"));
    }
    const providerResult = replayPersistedContextLimit
      ? {
          ok: false as const,
          cause: {
            _tag: "ProviderFailure" as const,
            kind: "ContextLimitExceeded" as const,
          },
        }
      : yield* Effect.match(providerRuntime.runTurn(turnInput), {
          onFailure: (cause) => ({ ok: false as const, cause }),
          onSuccess: (value) => ({ ok: true as const, value }),
        });
    if (!providerResult.ok) {
      if (providerAdmission !== undefined) {
        const endDecision = yield* completeProviderTurn(
          providerAdmission.activity,
        );
        if (endDecision === "Stop") {
          return yield* proposeSettlement(safetyStop("RuntimeSafetyStop"));
        }
      }
      if (isProviderTurnBindingChanged(providerResult.cause)) {
        return yield* proposeSettlement(
          providerTurnBindingChangedSettlement(),
        );
      }
      if (
        isProviderFailure(providerResult.cause) &&
        providerResult.cause.safeDiagnostic ===
          PROVIDER_TURN_ADMISSION_EXECUTION_STOPPING
      ) {
        return yield* proposeSettlement({
          _tag: "Interrupted",
          result: { _tag: "StopRequested" },
        });
      }
      if (isProviderExecutionTimeout(providerResult.cause)) {
        return yield* proposeSettlement(
          providerExecutionTimeoutSettlement(providerResult.cause),
        );
      }
      if (
        typeof providerResult.cause === "object" &&
        providerResult.cause !== null &&
        "_tag" in providerResult.cause &&
        providerResult.cause._tag === "ProviderFailure" &&
        "kind" in providerResult.cause &&
        providerResult.cause.kind === "ContextLimitExceeded" &&
        overflowRecoveryAttempt === 0 &&
        loopStepFence !== undefined &&
        loopStep !== undefined &&
        loopSteps !== undefined
      ) {
        const overflowStep = loopStep;
        const overflowFence = loopStepFence;
        const overflowSteps = loopSteps;
        const observedAt = yield* now();
        if (providerTurns !== undefined) {
          const existingTurn = yield* tx
            .transact(providerTurns.findUnsettledByTurn(providerTurnId))
            .pipe(Effect.mapError(failure));
          if (existingTurn !== null) {
            yield* tx
              .transact(
                Effect.gen(function* () {
                  yield* providerTurns.failTurn(providerTurnId, observedAt);
                  if (options.qualificationProbe !== undefined) {
                    yield* Effect.promise(async () => {
                      await options.qualificationProbe?.({
                        boundary: "AH18BeforeInferenceFailTurnCommit",
                        executionId: String(input.execution.executionId),
                        providerTurnId: String(providerTurnId),
                      });
                    });
                  }
                }),
              )
              .pipe(Effect.mapError(failure));
          }
        }
        const nativeSupported =
          capability.portableRequestCompatibility?.operationKinds.includes(
            "CompactionNative",
          ) === true;
        const compactTurnId = nativeSupported
          ? providerTurnNativeCompactionId(
              input.execution.executionId,
              turn,
              stepContext.contextEpoch,
            )
          : providerTurnSummaryCompactionId(
              input.execution.executionId,
              turn,
              stepContext.contextEpoch,
            );
        if (!replayPersistedContextLimit) {
          const compactionProviderTurnId = compactTurnId;
          const linkProbeIdentity = {
            executionId: String(input.execution.executionId),
            providerTurnId: String(compactionProviderTurnId),
          };
          yield* tx
            .transact(
              Effect.gen(function* () {
                yield* overflowSteps.ensureProviderTurnLink(
                  {
                    identity: overflowStep.identity,
                    overflowOrdinal: 0,
                    role: "Inference",
                    providerTurnId,
                    contextEpoch: stepContext.contextEpoch,
                    state: "SettledFailure",
                    createdAt: observedAt,
                  },
                  overflowFence,
                );
                yield* overflowSteps.ensureProviderTurnLink(
                  {
                    identity: overflowStep.identity,
                    overflowOrdinal: 0,
                    role: "OverflowCompaction",
                    providerTurnId: compactTurnId,
                    predecessorProviderTurnId: providerTurnId,
                    contextEpoch: stepContext.contextEpoch,
                    state: "Prepared",
                    createdAt: observedAt,
                  },
                  overflowFence,
                );
                if (options.qualificationProbe !== undefined) {
                  yield* Effect.promise(async () => {
                    await options.qualificationProbe?.({
                      boundary: "AH18BeforeOverflowLinksCommit",
                      ...linkProbeIdentity,
                    });
                  });
                }
              }),
            )
            .pipe(Effect.mapError(failure));
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(async () => {
              await options.qualificationProbe?.({
                boundary: "AH18AfterOverflowLinksCommit",
                ...linkProbeIdentity,
              });
            });
          }
        }
        const compacted = conversationExecution
          ? yield* Effect.gen(function* () {
              if (
                conversationOwner === undefined ||
                conversationProjection === undefined ||
                conversationCurrentJob === undefined ||
                dependencies.conversationCheckpoints === undefined ||
                dependencies.blobs === undefined ||
                providerTurns === undefined
              ) {
                return yield* Effect.fail(
                  failure({
                    _tag: "ConversationCheckpointRuntimeUnavailable",
                  }),
                );
              }
              const sources = [
                ...conversationProjection.coveredAnswered,
                ...conversationProjection.uncoveredAnswered,
              ];
              const latest = sources.at(-1);
              const coveredThrough =
                latest === undefined
                  ? conversationProjection.checkpoint.coveredThrough
                  : {
                      createdAt: latest.message.createdAt,
                      messageId: latest.message.messageId,
                    };
              return yield* runConversationCheckpointCompaction(
                {
                  execution: input.execution,
                  logicalStepNo: overflowStep.identity.logicalStepNo,
                  providerTurnId: compactTurnId,
                  owner: conversationOwner,
                  sources,
                  coveredThrough,
                  currentMessageId: exactConversation?.messageId ?? "",
                  currentResponseJob: conversationCurrentJob,
                  checkpointKind: nativeSupported
                    ? "ProviderNative"
                    : "Summary",
                  bindingFingerprint: currentBindingFingerprint,
                  modelRef: capability.modelRef,
                  ...(options.secretRef === undefined
                    ? {}
                    : { secretRef: options.secretRef }),
                  fence: overflowFence,
                  updatedAt: yield* now(),
                  ...(options.qualificationProbe === undefined
                    ? {}
                    : { qualificationProbe: options.qualificationProbe }),
                },
                {
                  ...compactionDependencies,
                  checkpointStore: dependencies.conversationCheckpoints,
                  providerTurns,
                  blobs: dependencies.blobs,
                  tx,
                },
              ).pipe(Effect.mapError(failure));
            })
          : yield* runCompaction(
              {
                execution: input.execution,
                logicalStepNo: loopStep?.identity.logicalStepNo ?? turn,
                ...(loopStep === undefined
                  ? {}
                  : {
                      sourceAgentLoopStep: {
                        executionId: String(loopStep.identity.executionId),
                        logicalStepNo: loopStep.identity.logicalStepNo,
                        repairAttempt: loopStep.identity.repairAttempt,
                        providerTurnId: String(loopStep.providerTurnId),
                      },
                    }),
                currentEpoch: stepContext.contextEpoch,
                modelRef: capability.modelRef,
                ...(options.secretRef === undefined
                  ? {}
                  : { secretRef: options.secretRef }),
                bindingFingerprint: stepContext.bindingFingerprint,
                inputFrontier: stepContext.inputFrontier,
                contextRefs: messageContextRefs,
                inputItems,
                ...compactionWorkPinning,
                fence: overflowFence,
                nativeSupported,
              },
              compactionDependencies,
            ).pipe(Effect.mapError(failure));
        if ("_tag" in compacted) {
          return yield* proposeSettlement(safetyStop("RuntimeSafetyStop"));
        }
        overflowReplacementProviderTurnId =
          makeOverflowReplacementProviderTurnId(
            input.execution.executionId,
            turn,
          );
        yield* tx
          .transact(
            overflowSteps.ensureProviderTurnLink(
              {
                identity: overflowStep.identity,
                overflowOrdinal: 0,
                role: "OverflowReplacement",
                providerTurnId: overflowReplacementProviderTurnId,
                predecessorProviderTurnId: compacted.providerTurnId,
                contextEpoch: compacted.newEpoch,
                state: "Prepared",
                createdAt: yield* now(),
              },
              overflowFence,
            ),
          )
          .pipe(Effect.mapError(failure));
        overflowRecoveryAttempt = 1;
        replayPersistedContextLimit = false;
        return { _tag: "Restart" as const, overflow: recoveryState(), repairAttempt, repairFragments };
      }
      if (isProviderFailure(providerResult.cause)) {
        return yield* proposeSettlement(
          providerFailureSettlement(providerResult.cause),
        );
      }
      return yield* Effect.fail(failure(providerResult.cause));
    }
    return yield* processSuccessfulProviderResult(dependencies, {
      turn,
      repairAttempt,
      providerTurnId,
      loopStep,
      preparation,
      providerRun: providerResult.value,
      providerAdmission,
      conversationExecution,
      overflow: recoveryState(),
    });
  });
};
