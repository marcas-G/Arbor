import {
  providerTurnOverflowReplacementId as makeOverflowReplacementProviderTurnId,
  type ProviderTurnId,
  providerTurnNativeCompactionId,
  providerTurnSummaryCompactionId,
} from "@arbor/domain";
import type {
  AgentLoopStepFence,
  AgentLoopStepIdentity,
  AgentLoopStepProviderTurnLink,
  AgentLoopStepRecord,
  AgentLoopStepStoreService,
  ProviderTurnStoreService,
  SettledProviderTurnResult,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { isValidOverflowCompactionLinkPair } from "../../agent-loop-step-recovery.js";
import type { ModelDecisionDependencies } from "../contract.js";
import type { ConversationOverflowError } from "./errors.js";
import type { OverflowRecoveryState } from "./overflow-state.js";

type ConversationOverflowDependencies = Pick<
  ModelDecisionDependencies,
  "input" | "capability" | "tx" | "conversationCheckpoints" | "now"
> & {
  readonly loopSteps: AgentLoopStepStoreService;
  readonly loopStepFence: AgentLoopStepFence;
  readonly providerTurns: ProviderTurnStoreService;
};

/** Recover conversation overflow against its own checkpoint owner, not the
 * Work Session epoch. Return the process-local continuation to the driver. */
export const recoverConversationOverflow = (
  dependencies: ConversationOverflowDependencies,
  phase: {
    readonly turn: number;
    readonly loopStepIdentity: AgentLoopStepIdentity;
    readonly loopStep: AgentLoopStepRecord;
    readonly originalInference: Extract<
      SettledProviderTurnResult,
      { readonly _tag: "SettledFailure" }
    >;
    readonly providerTurnLinks: ReadonlyArray<AgentLoopStepProviderTurnLink>;
    readonly inferenceLinks: ReadonlyArray<AgentLoopStepProviderTurnLink>;
    readonly compactionLinks: ReadonlyArray<AgentLoopStepProviderTurnLink>;
    readonly replacementLinks: ReadonlyArray<AgentLoopStepProviderTurnLink>;
    readonly overflow: OverflowRecoveryState;
  },
): Effect.Effect<
  { readonly _tag: "Restart"; readonly overflow: OverflowRecoveryState },
  ConversationOverflowError
> => {
  const {
    input,
    capability,
    tx,
    loopSteps,
    loopStepFence,
    providerTurns,
    now,
  } = dependencies;
  const {
    turn,
    loopStepIdentity,
    loopStep,
    originalInference,
    providerTurnLinks,
    inferenceLinks,
    compactionLinks,
    replacementLinks,
  } = phase;
  const activeLoopStep = loopStep;
  return Effect.gen(function* () {
    let {
      overflowRecoveryAttempt,
      replayPersistedContextLimit,
      resumeOverflowCompactionProviderTurnId,
      resumeOverflowNativeCompaction,
      overflowReplacementProviderTurnId,
    } = phase.overflow;
    const recoveryState = (): OverflowRecoveryState => ({
      ...phase.overflow,
      overflowRecoveryAttempt,
      replayPersistedContextLimit,
      resumeOverflowCompactionProviderTurnId,
      resumeOverflowNativeCompaction,
      overflowReplacementProviderTurnId,
    });
    if (
      dependencies.conversationCheckpoints === undefined ||
      loopStepFence === undefined
    ) {
      return yield* Effect.fail<ConversationOverflowError>({
        _tag: "ConversationCheckpointRuntimeUnavailable",
      });
    }
    const ownerOption = yield* tx.transact(
      dependencies.conversationCheckpoints.findOwner(
        input.execution.workspaceId,
      ),
    );
    const owner = Option.isSome(ownerOption) ? ownerOption.value : undefined;
    const ownerEpoch = Number(owner?.contextEpoch ?? 0);
    const inference = originalInference.turn;
    if (
      inference.providerTurnId !== loopStep.providerTurnId ||
      inference.executionId !== input.execution.executionId ||
      inference.sessionId !== input.execution.sessionId ||
      inference.modelRef !== capability.modelRef ||
      ownerEpoch < Number(inference.contextEpoch) ||
      ownerEpoch > Number(inference.contextEpoch) + 1
    ) {
      return yield* Effect.fail<ConversationOverflowError>({
        _tag: "AgentLoopStepReplayBindingMismatch",
      });
    }
    const nativeSupported =
      capability.portableRequestCompatibility?.operationKinds.includes(
        "CompactionNative",
      ) === true;
    let linkedCompactionProviderTurnId: ProviderTurnId;
    if (providerTurnLinks.length === 0) {
      if (ownerEpoch !== Number(inference.contextEpoch)) {
        return yield* Effect.fail<ConversationOverflowError>({
          _tag: "AgentLoopStepReplayBindingMismatch",
        });
      }
      const compactionProviderTurnId = nativeSupported
        ? providerTurnNativeCompactionId(
            input.execution.executionId,
            turn,
            inference.contextEpoch,
          )
        : providerTurnSummaryCompactionId(
            input.execution.executionId,
            turn,
            inference.contextEpoch,
          );
      const [compactionReceipt, replacementReceipt] = yield* Effect.all(
        [
          tx.transact(
            providerTurns.findSettledResult(compactionProviderTurnId),
          ),
          tx.transact(
            providerTurns.findSettledResult(
              makeOverflowReplacementProviderTurnId(
                input.execution.executionId,
                turn,
              ),
            ),
          ),
        ],
        { concurrency: 1 },
      );
      if (
        compactionReceipt._tag !== "NotFound" ||
        replacementReceipt._tag !== "NotFound"
      ) {
        return yield* Effect.fail<ConversationOverflowError>({
          _tag: "AgentLoopStepReplayBindingMismatch",
        });
      }
      linkedCompactionProviderTurnId = compactionProviderTurnId;
      yield* tx.transact(
        Effect.gen(function* () {
          const createdAt = yield* now();
          yield* loopSteps.ensureProviderTurnLink(
            {
              identity: loopStepIdentity,
              overflowOrdinal: 0,
              role: "Inference",
              providerTurnId: activeLoopStep.providerTurnId,
              contextEpoch: inference.contextEpoch,
              state: "SettledFailure",
              createdAt,
            },
            loopStepFence,
          );
          yield* loopSteps.ensureProviderTurnLink(
            {
              identity: loopStepIdentity,
              overflowOrdinal: 0,
              role: "OverflowCompaction",
              providerTurnId: compactionProviderTurnId,
              predecessorProviderTurnId: activeLoopStep.providerTurnId,
              contextEpoch: inference.contextEpoch,
              state: "Prepared",
              createdAt,
            },
            loopStepFence,
          );
        }),
      );
    } else {
      const inferenceLink = inferenceLinks[0];
      const compactionLink = compactionLinks[0];
      if (
        (providerTurnLinks.length !== 2 && providerTurnLinks.length !== 3) ||
        replacementLinks.length > 1 ||
        inferenceLinks.length !== 1 ||
        compactionLinks.length !== 1 ||
        inferenceLink === undefined ||
        compactionLink === undefined ||
        !isValidOverflowCompactionLinkPair(
          providerTurnLinks,
          loopStep.providerTurnId,
          [
            providerTurnSummaryCompactionId(
              input.execution.executionId,
              turn,
              inference.contextEpoch,
            ),
            providerTurnNativeCompactionId(
              input.execution.executionId,
              turn,
              inference.contextEpoch,
            ),
          ],
        ) ||
        Number(compactionLink.contextEpoch) !== Number(inference.contextEpoch)
      ) {
        return yield* Effect.fail<ConversationOverflowError>({
          _tag: "AgentLoopStepReplayBindingMismatch",
        });
      }
      linkedCompactionProviderTurnId = compactionLink.providerTurnId;
    }
    if (ownerEpoch === Number(inference.contextEpoch) + 1) {
      if (
        owner?.producerProviderTurnId !== linkedCompactionProviderTurnId ||
        owner.producerExecutionId !== input.execution.executionId
      ) {
        return yield* Effect.fail<ConversationOverflowError>({
          _tag: "AgentLoopStepReplayBindingMismatch",
        });
      }
      const replacementProviderTurnId = makeOverflowReplacementProviderTurnId(
        input.execution.executionId,
        turn,
      );
      const existingReplacement = replacementLinks[0];
      if (
        existingReplacement !== undefined &&
        (existingReplacement.providerTurnId !== replacementProviderTurnId ||
          existingReplacement.predecessorProviderTurnId !==
            linkedCompactionProviderTurnId ||
          Number(existingReplacement.contextEpoch) !== ownerEpoch)
      ) {
        return yield* Effect.fail<ConversationOverflowError>({
          _tag: "AgentLoopStepReplayBindingMismatch",
        });
      }
      yield* tx.transact(
        loopSteps.ensureProviderTurnLink(
          {
            identity: loopStepIdentity,
            overflowOrdinal: 0,
            role: "OverflowReplacement",
            providerTurnId: replacementProviderTurnId,
            predecessorProviderTurnId: linkedCompactionProviderTurnId,
            contextEpoch: owner.contextEpoch,
            state: "Prepared",
            createdAt: yield* now(),
          },
          loopStepFence,
        ),
      );
      overflowReplacementProviderTurnId = replacementProviderTurnId;
      overflowRecoveryAttempt = 1;
      return { _tag: "Restart" as const, overflow: recoveryState() };
    }
    if (ownerEpoch !== Number(inference.contextEpoch)) {
      return yield* Effect.fail<ConversationOverflowError>({
        _tag: "AgentLoopStepReplayBindingMismatch",
      });
    }
    if (replacementLinks.length !== 0) {
      return yield* Effect.fail<ConversationOverflowError>({
        _tag: "AgentLoopStepReplayBindingMismatch",
      });
    }
    const compactionManifest = yield* tx.transact(
      providerTurns.findManifestByTurn(linkedCompactionProviderTurnId),
    );
    const compactionReceipt = yield* tx.transact(
      providerTurns.findSettledResult(linkedCompactionProviderTurnId),
    );
    const existingContract =
      compactionReceipt._tag === "Unsettled" ||
      compactionReceipt._tag === "SettledSuccess" ||
      compactionReceipt._tag === "SettledFailure"
        ? compactionReceipt.turn.outputContractRef
        : undefined;
    if (compactionManifest !== null && compactionReceipt._tag === "NotFound") {
      return yield* Effect.fail<ConversationOverflowError>({
        _tag: "AgentLoopStepReplayBindingMismatch",
      });
    }
    resumeOverflowNativeCompaction =
      existingContract === "provider-native-compaction-v1" ||
      (existingContract === undefined && nativeSupported);
    resumeOverflowCompactionProviderTurnId = linkedCompactionProviderTurnId;
    replayPersistedContextLimit = true;
    return { _tag: "Restart" as const, overflow: recoveryState() };
  });
};
