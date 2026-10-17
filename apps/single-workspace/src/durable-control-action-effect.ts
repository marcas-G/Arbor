import type {
  AgentActionHandlerInput,
  AgentActionOutcome,
} from "@arbor/agent-runtime";
import type {
  AgentLoopStepStoreService,
  ClockService,
  SessionRepositoryService,
  TransactionPortService,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect, Option } from "effect";

export interface DurableControlEffect {
  readonly observation: { readonly text: string; readonly truncated: false };
  readonly canonicalRefs?: ReadonlyArray<string>;
}

/**
 * Commit a control's direct durable effect together with its P9 ActionResult,
 * sourced Session item, and action/cursor progression. If any fenced write
 * fails, TransactionPort rolls the direct effect back with the P9 handoff.
 */
export const commitDurableControlActionEffect = <A>(input: {
  readonly handlerInput: AgentActionHandlerInput;
  readonly expectedToolName: string;
  readonly tx: TransactionPortService;
  readonly loopSteps: AgentLoopStepStoreService;
  readonly sessions: Pick<SessionRepositoryService, "appendItemIdempotent">;
  readonly clock: ClockService;
  readonly effect: () => Effect.Effect<
    { readonly value: A; readonly result: DurableControlEffect },
    unknown,
    import("@arbor/ports").TransactionScope
  >;
}): Effect.Effect<
  { readonly value: A; readonly outcome: AgentActionOutcome },
  unknown
> =>
  Effect.gen(function* () {
    const { handlerInput } = input;
    const context = handlerInput.actionContext;
    const fence = handlerInput.loopStepFence;
    const logicalActionId = handlerInput.logicalActionId;
    if (
      context === undefined ||
      fence === undefined ||
      logicalActionId === undefined
    ) {
      return yield* Effect.fail(
        new Error(
          "durable control effect requires its exact P9 action binding",
        ),
      );
    }
    const updatedAt = yield* input.clock.now();
    const committed = yield* input.tx.transact(
      Effect.gen(function* () {
        const reportSuppressed = (stage: string) =>
          handlerInput.qualificationProbe === undefined
            ? Effect.void
            : Effect.promise(
                () =>
                  handlerInput.qualificationProbe?.({
                    boundary: "AH7StaleDirectControlEffectSuppressed",
                    providerTurnId: context.providerTurnId,
                    executionId: handlerInput.execution.executionId,
                    logicalActionId,
                    actionKind: input.expectedToolName,
                    routeKind: "Control",
                    callRef: context.callRef,
                    actionIndex: context.actionIndex,
                    stage,
                  }) ?? Promise.resolve(),
              );
        const step = yield* input.loopSteps.find(context.identity);
        if (
          Option.isNone(step) ||
          step.value.state !== "ActionsInProgress" ||
          step.value.providerTurnId !== context.providerTurnId
        ) {
          yield* reportSuppressed("P9StepNoLongerActionable");
          return yield* Effect.fail({
            _tag: "LeaseFencingRejected" as const,
            executionId: fence.executionId,
            generation: fence.fencingGeneration,
          });
        }
        const actions = yield* input.loopSteps.listActions(context.identity);
        const action = actions.find(
          (candidate) =>
            candidate.actionIndex === context.actionIndex &&
            candidate.callRef === context.callRef &&
            candidate.logicalActionId === logicalActionId &&
            candidate.routeKind === "Control" &&
            candidate.actionKind === input.expectedToolName,
        );
        if (action === undefined || action.state !== "Pending") {
          yield* reportSuppressed(
            action === undefined
              ? "P9ActionMissing"
              : `P9Action${action.state}`,
          );
          return yield* Effect.fail({
            _tag: "LeaseFencingRejected" as const,
            executionId: fence.executionId,
            generation: fence.fencingGeneration,
          });
        }

        const applied = yield* input.effect();
        const resultRef = `result_${sha256Hex(
          JSON.stringify({
            source: "Runtime",
            observation: applied.result.observation,
            status: "Succeeded",
            disposition: "Applied",
          }),
        )}`;
        const observationSourceRef = `observation_${handlerInput.execution.executionId}_${sha256Hex(
          JSON.stringify({
            providerTurnId: context.providerTurnId,
            callRef: context.callRef,
            resultRef,
          }),
        )}`;
        const item = {
          _tag: "ControlResult" as const,
          callRef: context.callRef,
          actionKind: input.expectedToolName,
          status: "Succeeded" as const,
          disposition: "Applied",
          outputText: applied.result.observation.text,
          truncated: false,
          canonicalRefs: applied.result.canonicalRefs ?? [],
          observationRef: observationSourceRef,
        };
        yield* input.sessions.appendItemIdempotent(
          handlerInput.execution.sessionId,
          {
            item,
            contextEpoch: context.contextEpoch,
            source: { kind: "AgentLoopAction", ref: observationSourceRef },
            contentHash: sha256Hex(JSON.stringify(item)),
          },
          fence,
        );
        yield* input.loopSteps.transitionAction(
          {
            identity: context.identity,
            actionIndex: context.actionIndex,
            expectedRevision: action.revision,
            expectedState: "Pending",
            next: {
              ...action,
              state: "Applied",
              resultRef,
              disposition: { _tag: "Applied", status: "Succeeded" },
              observationSourceRef,
              revision: action.revision + 1,
              updatedAt,
            },
          },
          fence,
        );
        const loopStep = yield* input.loopSteps.transition(
          {
            identity: context.identity,
            expectedRevision: step.value.revision,
            expectedState: "ActionsInProgress",
            next: {
              ...step.value,
              nextActionIndex: Math.max(
                step.value.nextActionIndex,
                context.actionIndex + 1,
              ),
              revision: step.value.revision + 1,
              updatedAt,
            },
          },
          fence,
        );
        if (handlerInput.qualificationProbe !== undefined) {
          yield* Effect.promise(
            () =>
              handlerInput.qualificationProbe?.({
                boundary: "AH7BeforeActionResultCommit",
                providerTurnId: context.providerTurnId,
                executionId: handlerInput.execution.executionId,
                logicalActionId,
                actionKind: input.expectedToolName,
                routeKind: "Control",
                callRef: context.callRef,
                actionIndex: context.actionIndex,
              }) ?? Promise.resolve(),
          );
        }
        return { value: applied.value, loopStep, result: applied.result };
      }),
    );
    if (handlerInput.qualificationProbe !== undefined) {
      yield* Effect.promise(
        () =>
          handlerInput.qualificationProbe?.({
            boundary: "AH7AfterActionResultCommit",
            providerTurnId: context.providerTurnId,
            executionId: handlerInput.execution.executionId,
            logicalActionId,
            actionKind: input.expectedToolName,
            routeKind: "Control",
            callRef: context.callRef,
            actionIndex: context.actionIndex,
          }) ?? Promise.resolve(),
      );
    }
    return {
      value: committed.value,
      outcome: {
        _tag: "Observation",
        source: "Runtime",
        observation: committed.result.observation,
        durableActionCommit: { loopStep: committed.loopStep },
      },
    };
  });
