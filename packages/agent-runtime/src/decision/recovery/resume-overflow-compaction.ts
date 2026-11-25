import {
  ContextEpochNumber,
  type ExecutionSettlement,
  parse,
  providerTurnNativeCompactionId,
  providerTurnOverflowReplacementId as makeOverflowReplacementProviderTurnId,
  providerTurnSummaryCompactionId,
} from "@arbor/domain";
import type { AgentLoopStepIdentity, AgentLoopStepRecord, ExecutionDriverError, PortableInputItem } from "@arbor/ports";
import { Effect } from "effect";
import { type ModelDecisionOutcome, safetyStop } from "../../agent-loop-policy.js";
import { runConversationCheckpointCompaction } from "../../checkpoint/conversation/compaction.js";
import { runCompaction, type SummaryCompactionInput } from "../../compaction-coordinator.js";
import type { AgentStepContext } from "../../step-context.js";
import type { ModelDecisionDependencies } from "../contract.js";
import type { ConversationDecisionContextResult } from "../conversation-context.js";
import type { OverflowRecoveryState } from "./overflow-state.js";

type ResumeDependencies = Pick<
  ModelDecisionDependencies,
  "input" | "capability" | "tx" | "loopSteps" | "loopStepFence" |
  "providerTurns" | "options" | "failure" | "now" | "conversationCheckpoints" | "blobs"
>;

type ResumeResult =
  | ModelDecisionOutcome
  | { readonly _tag: "Proceed" }
  | {
      readonly _tag: "Restart";
      readonly overflow: OverflowRecoveryState;
      readonly compactionAttempts: number;
    };

/** Resume a previously linked compaction before inference preparation.
 * Use the same durable turn identity and fence as the interrupted attempt. */
export const resumePinnedOverflowCompaction = (
  dependencies: ResumeDependencies,
  phase: {
    readonly turn: number;
    readonly loopStepIdentity: AgentLoopStepIdentity;
    readonly loopStep: AgentLoopStepRecord | undefined;
    readonly conversation: Extract<ConversationDecisionContextResult, { readonly _tag: "Ready" }>;
    readonly stepContext: AgentStepContext;
    readonly inputItems: ReadonlyArray<PortableInputItem>;
    readonly messageContextRefs: ReadonlyArray<string>;
    readonly currentBindingFingerprint: string;
    readonly providerNativeSupported: boolean;
    readonly compactionDependencies: Parameters<typeof runCompaction>[1];
    readonly compactionWorkPinning: Pick<SummaryCompactionInput, "pinnedInstructions" | "pinnedInstructionFragments" | "controlBasis">;
    readonly compactionAttempts: number;
    readonly overflow: OverflowRecoveryState;
    readonly proposeSettlement: (
      settlement: ExecutionSettlement,
    ) => Effect.Effect<ModelDecisionOutcome, ExecutionDriverError>;
  },
): Effect.Effect<ResumeResult, ExecutionDriverError> => {
  const { input, capability, tx, loopSteps, loopStepFence, providerTurns, options, failure, now } = dependencies;
  const {
    turn, loopStepIdentity, loopStep, stepContext, inputItems, messageContextRefs,
    currentBindingFingerprint, providerNativeSupported, compactionDependencies,
    compactionWorkPinning, compactionAttempts, proposeSettlement,
  } = phase;
  const {
    conversationExecution, conversationOwner, conversationProjection,
    conversationCurrentJob, exactConversation,
  } = phase.conversation;
  return Effect.gen(function* () {
    let {
      overflowRecoveryAttempt,
      replayPersistedContextLimit,
      resumeOverflowCompactionProviderTurnId,
      resumeOverflowNativeCompaction,
      resumeOverflowNativeCompactionInput,
      overflowReplacementProviderTurnId,
    } = phase.overflow;
    const recoveryState = (): OverflowRecoveryState => ({
      overflowRecoveryAttempt,
      replayPersistedContextLimit,
      resumeOverflowCompactionProviderTurnId,
      resumeOverflowNativeCompaction,
      resumeOverflowNativeCompactionInput,
      overflowReplacementProviderTurnId,
    });
    if (resumeOverflowCompactionProviderTurnId !== undefined) {
      if (
        loopStep === undefined ||
        loopSteps === undefined ||
        loopStepFence === undefined
      ) {
        return yield* Effect.fail(
          failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
        );
      }
      const expectedCompactionProviderTurnId = resumeOverflowNativeCompaction
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
      if (
        resumeOverflowCompactionProviderTurnId !==
        expectedCompactionProviderTurnId
      ) {
        return yield* Effect.fail(
          failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
        );
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
                failure({ _tag: "ConversationCheckpointRuntimeUnavailable" }),
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
                logicalStepNo: loopStep?.identity.logicalStepNo ?? turn,
                ...(resumeOverflowCompactionProviderTurnId === undefined
                  ? {}
                  : {
                      providerTurnId: resumeOverflowCompactionProviderTurnId,
                    }),
                owner: conversationOwner,
                sources,
                coveredThrough,
                currentMessageId: exactConversation?.messageId ?? "",
                currentResponseJob: conversationCurrentJob,
                checkpointKind:
                  resumeOverflowNativeCompaction && providerNativeSupported
                    ? "ProviderNative"
                    : "Summary",
                bindingFingerprint: currentBindingFingerprint,
                modelRef: capability.modelRef,
                ...(options.secretRef === undefined
                  ? {}
                  : { secretRef: options.secretRef }),
                fence: loopStepFence,
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
              fence: loopStepFence,
              nativeSupported:
                resumeOverflowNativeCompaction && providerNativeSupported,
              ...(resumeOverflowNativeCompactionInput === undefined
                ? {}
                : { nativeRecovery: resumeOverflowNativeCompactionInput }),
            },
            compactionDependencies,
          ).pipe(Effect.mapError(failure));
      if ("_tag" in compacted) {
        return yield* proposeSettlement(safetyStop("RuntimeSafetyStop"));
      }
      if (
        compacted.providerTurnId !== resumeOverflowCompactionProviderTurnId ||
        Number(compacted.newEpoch) !== Number(stepContext.contextEpoch) + 1
      ) {
        return yield* Effect.fail(
          failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
        );
      }
      const replacementProviderTurnId = makeOverflowReplacementProviderTurnId(
        input.execution.executionId,
        turn,
      );
      yield* tx
        .transact(
          loopSteps.ensureProviderTurnLink(
            {
              identity: loopStepIdentity,
              overflowOrdinal: 0,
              role: "OverflowReplacement",
              providerTurnId: replacementProviderTurnId,
              predecessorProviderTurnId:
                resumeOverflowCompactionProviderTurnId,
              contextEpoch: parse(ContextEpochNumber)(
                Number(stepContext.contextEpoch) + 1,
              ),
              state: "Prepared",
              createdAt: yield* now(),
            },
            loopStepFence,
          ),
        )
        .pipe(Effect.mapError(failure));
      overflowRecoveryAttempt = 1;
      overflowReplacementProviderTurnId = replacementProviderTurnId;
      replayPersistedContextLimit = false;
      resumeOverflowNativeCompaction = false;
      resumeOverflowNativeCompactionInput = undefined;
      resumeOverflowCompactionProviderTurnId = undefined;
      return { _tag: "Restart" as const, overflow: recoveryState(), compactionAttempts };
    }
    return { _tag: "Proceed" as const };
  });
};
