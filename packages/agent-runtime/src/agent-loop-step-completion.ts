import type {
  CommandSubmissionContext,
  Execution,
  ExecutionSettlement,
} from "@arbor/domain";
import { conversationResponseEpisode, executionEpisode } from "@arbor/domain";
import type { ModelOutput } from "@arbor/model-context";
import type {
  AgentLoopStepFence,
  AgentLoopStepRecord,
  AgentLoopStepStoreService,
  BoundedObservation,
  ExecutionDriverError,
  SessionRepositoryService,
  TransactionPortService,
} from "@arbor/ports";
import { Effect } from "effect";
import { MAX_TURNS, sessionFence } from "./agent-loop-policy.js";
import type { AgentLoopQualificationProbe } from "./qualification-probe.js";

export interface AgentLoopStepCompletionDependencies {
  readonly input: {
    readonly execution: Execution;
    readonly context: CommandSubmissionContext;
  };
  readonly decodedOutput: ModelOutput;
  readonly observations: ReadonlyArray<{
    readonly source: "Runtime" | "Tool";
    readonly observation: BoundedObservation;
  }>;
  readonly conversation: boolean;
  readonly turn: number;
  readonly currentLoopStep?: AgentLoopStepRecord;
  readonly loopSteps?: AgentLoopStepStoreService;
  readonly loopStepFence?: AgentLoopStepFence;
  readonly tx: TransactionPortService;
  readonly sessions: SessionRepositoryService;
  readonly failure: (cause: unknown) => ExecutionDriverError;
  readonly now: () => Effect.Effect<string>;
  readonly qualificationProbe?: AgentLoopQualificationProbe;
}

export type AgentLoopStepCompletion =
  | { readonly _tag: "Continue" }
  | { readonly _tag: "Settle"; readonly settlement: ExecutionSettlement };

/**
 * Commits post-action observations and advances the durable loop-step state.
 * It is the sole owner of the `ActionsInProgress -> StepEffectsCommitted ->
 * NextStepReady|SettlementProposed` progression.
 */
export const completeAgentLoopStep = (
  dependencies: AgentLoopStepCompletionDependencies,
): Effect.Effect<AgentLoopStepCompletion, ExecutionDriverError> => {
  const {
    input,
    decodedOutput,
    observations,
    conversation,
    turn,
    loopSteps,
    loopStepFence,
    tx,
    sessions,
    failure,
    now,
    qualificationProbe,
  } = dependencies;

  return Effect.gen(function* () {
    let currentLoopStep = dependencies.currentLoopStep;
    for (const entry of observations) {
      yield* tx
        .transact(
          sessions.appendEntry(
            input.execution.sessionId,
            { entryKind: "Observation", payload: entry },
            input.context._tag === "ExecutionOrigin"
              ? sessionFence(input.execution.executionId, input.context)
              : undefined,
          ),
        )
        .pipe(Effect.mapError(failure));
    }

    if (
      currentLoopStep !== undefined &&
      loopSteps !== undefined &&
      loopStepFence !== undefined &&
      currentLoopStep.state === "ActionsInProgress" &&
      currentLoopStep.nextActionIndex >= decodedOutput.toolInvocations.length
    ) {
      const actionsCompleteStep = currentLoopStep;
      if (qualificationProbe !== undefined) {
        yield* Effect.promise(() =>
          qualificationProbe({
            boundary: "AH11BeforeStepEffectsCommit",
            providerTurnId: actionsCompleteStep.providerTurnId,
            executionId: input.execution.executionId,
          }),
        );
      }
      currentLoopStep = yield* tx
        .transact(
          loopSteps.transition(
            {
              identity: actionsCompleteStep.identity,
              expectedRevision: actionsCompleteStep.revision,
              expectedState: "ActionsInProgress",
              next: {
                ...actionsCompleteStep,
                state: "StepEffectsCommitted",
                revision: actionsCompleteStep.revision + 1,
                updatedAt: yield* now(),
              },
            },
            loopStepFence,
          ),
        )
        .pipe(Effect.mapError(failure));
      if (qualificationProbe !== undefined) {
        yield* Effect.promise(() =>
          qualificationProbe({
            boundary: "AH11AfterStepEffectsCommit",
            providerTurnId: actionsCompleteStep.providerTurnId,
            executionId: input.execution.executionId,
          }),
        );
      }
    }

    // A claimed human message settles on its first text-only answer: one
    // provider call per response episode (P14/WAVE1 S04).
    if (
      conversation &&
      decodedOutput.toolInvocations.length === 0 &&
      decodedOutput.text.trim().length > 0
    ) {
      const episode = conversationResponseEpisode(input.execution);
      if (episode === null) {
        return {
          _tag: "Settle",
          settlement: {
            _tag: "Failed",
            failure: {
              _tag: "ExecutionFailure",
              reason: "conversation response lacks exact episode binding",
            },
          },
        };
      }
      const settlement: ExecutionSettlement = {
        _tag: "Completed",
        result: {
          _tag: "ConversationResponseProduced",
          messageId: episode.messageId,
        },
      };
      if (
        currentLoopStep !== undefined &&
        loopSteps !== undefined &&
        loopStepFence !== undefined &&
        currentLoopStep.state === "StepEffectsCommitted"
      ) {
        yield* tx
          .transact(
            loopSteps.transition(
              {
                identity: currentLoopStep.identity,
                expectedRevision: currentLoopStep.revision,
                expectedState: "StepEffectsCommitted",
                next: {
                  ...currentLoopStep,
                  state: "SettlementProposed",
                  settlement,
                  revision: currentLoopStep.revision + 1,
                  updatedAt: yield* now(),
                },
              },
              loopStepFence,
            ),
          )
          .pipe(Effect.mapError(failure));
      }
      return { _tag: "Settle", settlement };
    }

    // Placement is a terminal RootConversation action. The durable Work is
    // now the owner of execution; do not ask the model for another placement
    // turn (which can loop on assign_work and hold the Workspace main lease).
    // Persist a bounded, non-CoT status line so the response job can settle
    // authoritatively and the scheduler can admit the WorkEpisode next tick.
    if (
      conversation &&
      decodedOutput.toolInvocations.some(
        (invocation) => invocation.toolName === "assign_work",
      ) &&
      observations.some((entry) =>
        entry.observation.text.includes("WorkAssigned("),
      )
    ) {
      const statusText = "已建立 Work，后续由该 Work 继续执行并提交验证结果。";
      yield* tx
        .transact(
          sessions.appendEntry(
            input.execution.sessionId,
            {
              entryKind: "ModelOutput",
              payload: {
                providerTurnId: "runtime-placement-summary",
                outputContractRef: "conversation-placement-summary-v1",
                decoderVersion: "runtime-v1",
                text: statusText,
                finishReason: "Stop",
                toolInvocations: [],
              },
            },
            input.context._tag === "ExecutionOrigin"
              ? sessionFence(input.execution.executionId, input.context)
              : undefined,
          ),
        )
        .pipe(Effect.mapError(failure));
      const episode = conversationResponseEpisode(input.execution);
      if (episode === null) {
        return {
          _tag: "Settle",
          settlement: {
            _tag: "Failed",
            failure: {
              _tag: "ExecutionFailure",
              reason: "conversation response lacks exact episode binding",
            },
          },
        };
      }
      return {
        _tag: "Settle",
        settlement: {
          _tag: "Completed",
          result: {
            _tag: "ConversationResponseProduced",
            messageId: episode.messageId,
          },
        },
      };
    }

    const episode = executionEpisode(input.execution);
    if (
      episode?._tag === "InboxEpisode" &&
      decodedOutput.toolInvocations.length === 0 &&
      decodedOutput.text.trim().length > 0
    ) {
      const settlement: ExecutionSettlement = {
        _tag: "Completed",
        result: {
          _tag: "InboxInputHandled",
          entryKey: episode.entryKey,
        },
      };
      if (
        currentLoopStep !== undefined &&
        loopSteps !== undefined &&
        loopStepFence !== undefined &&
        currentLoopStep.state === "StepEffectsCommitted"
      ) {
        yield* tx
          .transact(
            loopSteps.transition(
              {
                identity: currentLoopStep.identity,
                expectedRevision: currentLoopStep.revision,
                expectedState: "StepEffectsCommitted",
                next: {
                  ...currentLoopStep,
                  state: "SettlementProposed",
                  settlement,
                  revision: currentLoopStep.revision + 1,
                  updatedAt: yield* now(),
                },
              },
              loopStepFence,
            ),
          )
          .pipe(Effect.mapError(failure));
      }
      return { _tag: "Settle", settlement };
    }

    if (
      turn + 1 < MAX_TURNS &&
      currentLoopStep !== undefined &&
      loopSteps !== undefined &&
      loopStepFence !== undefined &&
      currentLoopStep.state === "StepEffectsCommitted"
    ) {
      const predecessor = currentLoopStep;
      const successorIdentity = {
        executionId: input.execution.executionId,
        logicalStepNo: turn + 1,
        repairAttempt: 0,
      } as const;
      const successorProviderTurnId =
        `ptn_${input.execution.executionId}_${turn + 1}` as never;
      yield* tx
        .transact(
          Effect.gen(function* () {
            yield* loopSteps.transition(
              {
                identity: predecessor.identity,
                expectedRevision: predecessor.revision,
                expectedState: "StepEffectsCommitted",
                next: {
                  ...predecessor,
                  state: "NextStepReady",
                  successor: {
                    ...successorIdentity,
                    providerTurnId: successorProviderTurnId,
                  },
                  nextStepReason: "Continue",
                  revision: predecessor.revision + 1,
                  updatedAt: yield* now(),
                },
              },
              loopStepFence,
            );
            yield* loopSteps.ensureSuccessor(
              predecessor.identity,
              {
                identity: successorIdentity,
                predecessor: predecessor.identity,
                providerTurnId: successorProviderTurnId,
                state: "Prepared",
                nextActionIndex: 0,
                revision: 0,
                updatedAt: yield* now(),
              },
              loopStepFence,
            );
          }),
        )
        .pipe(Effect.mapError(failure));
    }

    return { _tag: "Continue" };
  });
};
