import type { ProviderTurnId } from "@arbor/domain";
import type {
  AgentLoopStepIdentity,
  AgentLoopStepRecord,
  ExecutionDriverError,
  SessionRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import type { ModelDecisionOutcome } from "../agent-loop-policy.js";
import { decodeExhaustedRepairDisposition } from "../agent-loop-step-recovery.js";
import type {
  runSummaryCompaction,
  SummaryCompactionInput,
} from "../compaction-coordinator.js";
import type { ModelDecisionDependencies } from "./contract.js";
import type { StepRecoveryError } from "./errors.js";
import { recoverConversationOverflow } from "./recovery/conversation-overflow.js";
import type { OverflowRecoveryState } from "./recovery/overflow-state.js";
import { recoverWorkOverflow } from "./recovery/work-overflow.js";

type StepRecoveryDependencies = Pick<
  ModelDecisionDependencies,
  | "input"
  | "capability"
  | "tx"
  | "loopSteps"
  | "loopStepFence"
  | "providerTurns"
  | "sessions"
  | "options"
  | "now"
  | "conversationCheckpoints"
>;

export type StepRecoveryResult =
  | {
      readonly _tag: "Ready";
      readonly loopStep: AgentLoopStepRecord | undefined;
      readonly overflow: OverflowRecoveryState;
    }
  | { readonly _tag: "Restart"; readonly overflow: OverflowRecoveryState }
  | { readonly _tag: "Complete"; readonly outcome: ModelDecisionOutcome };

export const recoverDecisionStep = (
  dependencies: StepRecoveryDependencies,
  phase: {
    readonly turn: number;
    readonly repairAttempt: number;
    readonly providerTurnId: ProviderTurnId;
    readonly loopStepIdentity: AgentLoopStepIdentity;
    readonly overflow: OverflowRecoveryState;
    readonly isConversationResponseExecution: boolean;
    readonly currentBindingFingerprint: string;
    readonly providerNativeSupported: boolean;
    readonly compactionDependencies: Parameters<typeof runSummaryCompaction>[1];
    readonly readExecutionTimeline: () => ReturnType<
      SessionRepositoryService["listRecentEntries"]
    >;
    readonly loadWorkCompactionPinning: () => Effect.Effect<
      Pick<
        SummaryCompactionInput,
        "pinnedInstructions" | "pinnedInstructionFragments" | "controlBasis"
      >,
      ExecutionDriverError
    >;
  },
): Effect.Effect<StepRecoveryResult, StepRecoveryError> => {
  const {
    input,
    capability,
    tx,
    loopSteps,
    loopStepFence,
    providerTurns,
    sessions,
    options,
    now,
  } = dependencies;
  const {
    turn,
    repairAttempt,
    providerTurnId,
    loopStepIdentity,
    isConversationResponseExecution,
    currentBindingFingerprint,
    providerNativeSupported,
    compactionDependencies,
    readExecutionTimeline,
    loadWorkCompactionPinning,
  } = phase;
  return Effect.gen(function* () {
    let overflow = phase.overflow;
    let loopStep: AgentLoopStepRecord | undefined;
    if (loopSteps !== undefined && loopStepFence !== undefined) {
      loopStep = yield* tx.transact(
        Effect.gen(function* () {
          const existing = yield* loopSteps.find(loopStepIdentity);
          if (Option.isSome(existing)) return existing.value;
          return yield* loopSteps.createPrepared(
            {
              identity: loopStepIdentity,
              providerTurnId,
              state: "Prepared",
              nextActionIndex: 0,
              revision: 0,
              updatedAt: yield* now(),
            },
            loopStepFence,
          );
        }),
      );
      if (loopStep.state === "OutputRejected") {
        const settlement = decodeExhaustedRepairDisposition(
          loopStep.repairDisposition,
        );
        if (
          settlement === undefined ||
          loopStep.successor !== undefined ||
          loopStep.providerTurnId !== providerTurnId ||
          loopStep.identity.logicalStepNo !== turn ||
          loopStep.identity.repairAttempt !== repairAttempt
        ) {
          return yield* Effect.fail<StepRecoveryError>({
            _tag: "AgentLoopStepReplayBindingMismatch",
          });
        }
        const exhaustedStep = loopStep;
        loopStep = yield* tx.transact(
          loopSteps.transition(
            {
              identity: exhaustedStep.identity,
              expectedRevision: exhaustedStep.revision,
              expectedState: "OutputRejected",
              next: {
                ...exhaustedStep,
                state: "SettlementProposed",
                settlement,
                revision: exhaustedStep.revision + 1,
                updatedAt: yield* now(),
              },
            },
            loopStepFence,
          ),
        );
        return {
          _tag: "Complete" as const,
          outcome: { _tag: "Settle" as const, settlement },
        };
      }
      if (
        overflow.overflowRecoveryAttempt === 0 &&
        loopStep.state === "Prepared" &&
        providerTurns !== undefined &&
        overflow.resumeOverflowCompactionProviderTurnId === undefined
      ) {
        // Overflow recovery is relevant only when the original inference
        // already has durable ContextLimitExceeded failure evidence. This
        // keeps ordinary Prepared steps from requiring the v1.23 chain
        // table, while a real overflow with missing chain storage still
        // fails closed when the chain read below is attempted.
        const originalInference = yield* tx.transact(
          providerTurns.findSettledResult(loopStep.providerTurnId),
        );
        if (
          originalInference._tag === "SettledFailure" &&
          originalInference.failureKind === "ContextLimitExceeded"
        ) {
          const providerTurnLinks = yield* tx.transact(
            loopSteps.listProviderTurnLinks(loopStepIdentity),
          );
          const inferenceLinks = providerTurnLinks.filter(
            (link) => link.role === "Inference",
          );
          const compactionLinks = providerTurnLinks.filter(
            (link) => link.role === "OverflowCompaction",
          );
          const replacementLinks = providerTurnLinks.filter(
            (link) => link.role === "OverflowReplacement",
          );
          if (isConversationResponseExecution) {
            return yield* recoverConversationOverflow(
              {
                input,
                capability,
                tx,
                loopSteps,
                loopStepFence,
                providerTurns,
                now,
                ...(dependencies.conversationCheckpoints === undefined
                  ? {}
                  : {
                      conversationCheckpoints:
                        dependencies.conversationCheckpoints,
                    }),
              },
              {
                turn,
                loopStepIdentity,
                loopStep,
                originalInference,
                providerTurnLinks,
                inferenceLinks,
                compactionLinks,
                replacementLinks,
                overflow,
              },
            );
          }
          const workOverflow = yield* recoverWorkOverflow(
            {
              input,
              capability,
              tx,
              loopSteps,
              loopStepFence,
              providerTurns,
              sessions,
              options,
              now,
            },
            {
              turn,
              loopStepIdentity,
              loopStep,
              originalInference,
              providerTurnLinks,
              inferenceLinks,
              compactionLinks,
              replacementLinks,
              overflow,
              currentBindingFingerprint,
              providerNativeSupported,
              compactionDependencies,
              readExecutionTimeline,
              loadWorkCompactionPinning,
            },
          );
          if (workOverflow._tag !== "Ready") return workOverflow;
          overflow = workOverflow.overflow;
        }
      }
      if (
        loopStep.state === "SettlementProposed" &&
        loopStep.settlement !== undefined
      ) {
        return {
          _tag: "Complete" as const,
          outcome: { _tag: "Settle" as const, settlement: loopStep.settlement },
        };
      }
    }
    return { _tag: "Ready" as const, loopStep, overflow };
  });
};
