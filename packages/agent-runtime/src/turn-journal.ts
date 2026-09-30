import type { CommandSubmissionContext, Execution } from "@arbor/domain";
import type { ModelOutput, PreparedModelTurn } from "@arbor/model-context";
import type {
  AgentLoopStepFence,
  AgentLoopStepRecord,
  AgentLoopStepStoreService,
  ExecutionDriverError,
  SessionRepositoryService,
  TransactionPortService,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect } from "effect";
import { sessionFence } from "./driver-policy.js";

export interface TurnJournalDependencies {
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
}

/**
 * Durably accepts one decoded provider result before any action can execute.
 * The model output and loop-step transition share one transaction on the
 * fenced path; legacy in-process callers retain their existing append path.
 */
export const acceptTurnOutput = (
  dependencies: TurnJournalDependencies,
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
              const appended = yield* sessions.appendEntryIdempotent(
                input.execution.sessionId,
                {
                  kind: "ProviderTurn",
                  ref: preparedTurn.manifest.providerTurnId,
                },
                { entryKind: "ModelOutput", payload: modelOutputPayload },
                sha256Hex(JSON.stringify(modelOutputPayload)),
                loopStepFence,
              );
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
