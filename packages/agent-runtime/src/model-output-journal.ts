import type { CommandSubmissionContext, Execution } from "@arbor/domain";
import { executionEpisode } from "@arbor/domain";
import type { ModelOutput, PreparedModelTurn } from "@arbor/model-context";
import type {
  AgentLoopStepFence,
  AgentLoopStepRecord,
  AgentLoopStepStoreService,
  ExecutionDriverError,
  SessionEpochConflict,
  SessionRepositoryService,
  TransactionPortService,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect, Option } from "effect";
import { sessionFence } from "./agent-loop-policy.js";
import type { AgentLoopQualificationProbe } from "./qualification-probe.js";

export interface ModelOutputJournalDependencies {
  readonly input: {
    readonly execution: Execution;
    readonly context: CommandSubmissionContext;
  };
  readonly preparedTurn: PreparedModelTurn;
  readonly decodedOutput: ModelOutput;
  readonly currentLoopStep?: AgentLoopStepRecord;
  readonly loopSteps?: AgentLoopStepStoreService;
  readonly loopStepFence?: AgentLoopStepFence;
  readonly tx: TransactionPortService;
  readonly sessions: SessionRepositoryService;
  readonly failure: (cause: unknown) => ExecutionDriverError;
  readonly now: () => Effect.Effect<string>;
  readonly qualificationProbe?: AgentLoopQualificationProbe;
}

/** Conversation checkpoint epochs are RootWorkspace-owned and intentionally
 * do not advance the primary Work Session epoch. Other episodes retain the
 * exact Session/provider epoch binding. */
export const sessionTimelineEpochForAcceptedOutput = (input: {
  readonly execution: Execution;
  readonly sessionEpoch: number;
  readonly providerEpoch: number;
}): number | SessionEpochConflict => {
  if (
    executionEpisode(input.execution)?._tag === "ConversationResponseEpisode"
  ) {
    return input.sessionEpoch;
  }
  if (input.sessionEpoch !== input.providerEpoch) {
    return {
      _tag: "SessionEpochConflict",
      sessionId: input.execution.sessionId,
      expectedEpoch: input.providerEpoch,
      currentEpoch: input.sessionEpoch,
    };
  }
  return input.providerEpoch;
};

/**
 * Durably accepts one decoded provider result before any action can execute.
 * The model output and loop-step transition share one transaction on the
 * fenced path; legacy in-process callers retain their existing append path.
 */
export const recordAcceptedModelOutput = (
  dependencies: ModelOutputJournalDependencies,
): Effect.Effect<AgentLoopStepRecord | undefined, ExecutionDriverError> => {
  const {
    input,
    preparedTurn,
    decodedOutput,
    loopSteps,
    loopStepFence,
    tx,
    sessions,
    failure,
    now,
  } = dependencies;

  return Effect.gen(function* () {
    const modelOutputPayload = {
      providerTurnId: preparedTurn.manifest.providerTurnId,
      outputContractRef: preparedTurn.manifest.outputContractRef,
      decoderVersion: "decode-turn-v1",
      text: decodedOutput.text,
      finishReason: decodedOutput.finishReason,
      toolInvocations: decodedOutput.toolInvocations,
    };
    let currentLoopStep = dependencies.currentLoopStep;

    if (
      currentLoopStep !== undefined &&
      loopSteps !== undefined &&
      loopStepFence !== undefined
    ) {
      if (currentLoopStep.state === "ProviderResultAvailable") {
        const acceptedFrom = currentLoopStep;
        currentLoopStep = yield* tx
          .transact(
            Effect.gen(function* () {
              const typed = yield* sessions.supportsTypedTimeline();
              const sessionOption = yield* sessions.findById(
                input.execution.sessionId,
              );
              if (Option.isNone(sessionOption)) {
                return yield* Effect.fail(
                  failure({ _tag: "SessionContextMissing" }),
                );
              }
              const outputEpoch = sessionTimelineEpochForAcceptedOutput({
                execution: input.execution,
                sessionEpoch: Number(sessionOption.value.contextEpoch),
                providerEpoch: Number(preparedTurn.manifest.contextEpoch),
              });
              if (typeof outputEpoch !== "number") {
                return yield* Effect.fail(failure(outputEpoch));
              }
              const appended = typed
                ? yield* sessions.appendItemIdempotent(
                    input.execution.sessionId,
                    {
                      item: {
                        _tag: "AssistantMessage",
                        providerTurnId: preparedTurn.manifest.providerTurnId,
                        contentRef: `provider:${preparedTurn.manifest.providerTurnId}:assistant`,
                        text: decodedOutput.text,
                        finishReason: decodedOutput.finishReason,
                      },
                      contextEpoch: outputEpoch as never,
                      source: {
                        kind: "ProviderTurn",
                        ref: `${preparedTurn.manifest.providerTurnId}:assistant`,
                      },
                      contentHash: sha256Hex(
                        JSON.stringify({
                          text: decodedOutput.text,
                          finishReason: decodedOutput.finishReason,
                        }),
                      ),
                    },
                    loopStepFence,
                  )
                : yield* sessions.appendEntryIdempotent(
                    input.execution.sessionId,
                    {
                      kind: "ProviderTurn",
                      ref: preparedTurn.manifest.providerTurnId,
                    },
                    { entryKind: "ModelOutput", payload: modelOutputPayload },
                    sha256Hex(JSON.stringify(modelOutputPayload)),
                    loopStepFence,
                  );
              if (typed) {
                for (const invocation of decodedOutput.toolInvocations) {
                  const item = {
                    _tag: "ToolCall" as const,
                    providerTurnId: preparedTurn.manifest.providerTurnId,
                    callRef: invocation.callRef,
                    toolRef: invocation.toolName,
                    argumentsRef: `inline:${sha256Hex(invocation.argumentsJson)}`,
                    argumentsJson: invocation.argumentsJson,
                  };
                  yield* sessions.appendItemIdempotent(
                    input.execution.sessionId,
                    {
                      item,
                      contextEpoch: outputEpoch as never,
                      source: {
                        kind: "ProviderTurnCall",
                        ref: `${preparedTurn.manifest.providerTurnId}:${invocation.callRef}`,
                      },
                      contentHash: sha256Hex(JSON.stringify(item)),
                    },
                    loopStepFence,
                  );
                }
              }
              return yield* loopSteps.transition(
                {
                  identity: acceptedFrom.identity,
                  expectedRevision: acceptedFrom.revision,
                  expectedState: "ProviderResultAvailable",
                  next: {
                    ...acceptedFrom,
                    state: "OutputAccepted",
                    decodedOutputHash: sha256Hex(
                      JSON.stringify(modelOutputPayload),
                    ),
                    modelOutputSessionSequence: appended.sequence,
                    revision: acceptedFrom.revision + 1,
                    updatedAt: yield* now(),
                  },
                },
                loopStepFence,
              );
            }),
          )
          .pipe(Effect.mapError(failure));
        if (dependencies.qualificationProbe !== undefined) {
          yield* Effect.promise(
            () =>
              dependencies.qualificationProbe?.({
                boundary: "AH56AfterOutputAcceptedCommit",
                providerTurnId: preparedTurn.manifest.providerTurnId,
              }) ?? Promise.resolve(),
          );
        }
      }
    } else {
      yield* tx
        .transact(
          sessions.appendEntry(
            input.execution.sessionId,
            { entryKind: "ModelOutput", payload: modelOutputPayload },
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
      currentLoopStep.state === "OutputAccepted"
    ) {
      const acceptedStep = currentLoopStep;
      currentLoopStep = yield* tx
        .transact(
          loopSteps.transition(
            {
              identity: acceptedStep.identity,
              expectedRevision: acceptedStep.revision,
              expectedState: "OutputAccepted",
              next: {
                ...acceptedStep,
                state: "ActionsInProgress",
                revision: acceptedStep.revision + 1,
                updatedAt: yield* now(),
              },
            },
            loopStepFence,
          ),
        )
        .pipe(Effect.mapError(failure));
    }

    return currentLoopStep;
  });
};
