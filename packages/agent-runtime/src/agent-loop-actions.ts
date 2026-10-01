import type {
  CommandSubmissionContext,
  Execution,
  ExecutionSettlement,
} from "@arbor/domain";
import type {
  ControlBasis,
  ModelOutput,
  PreparedModelTurn,
} from "@arbor/model-context";
import type {
  AgentLoopStepActionRecord,
  AgentLoopStepFence,
  AgentLoopStepRecord,
  AgentLoopStepStoreService,
  BoundedObservation,
  ExecutionActivity,
  ExecutionDriverError,
  RuntimeSafetyObservation,
  SessionRepositoryService,
  TransactionPortService,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect } from "effect";
import { MAX_TURNS, safetyStop } from "./agent-loop-policy.js";
import {
  type ControlToolRegistryService,
  classifyToolRoute,
  type ExecutableInvocationHandler,
} from "./control.js";
import { checkFreshness, requirementForAction } from "./freshness.js";

export interface AgentLoopActionDependencies {
  readonly input: {
    readonly execution: Execution;
    readonly context: CommandSubmissionContext;
  };
  readonly preparedTurn: PreparedModelTurn;
  readonly decodedOutput: ModelOutput;
  readonly turn: number;
  readonly currentLoopStep?: AgentLoopStepRecord;
  readonly loopSteps?: AgentLoopStepStoreService;
  readonly loopStepFence?: AgentLoopStepFence;
  readonly tx: TransactionPortService;
  readonly sessions: SessionRepositoryService;
  readonly controlRegistry: ControlToolRegistryService;
  readonly executableInvocationHandler?: ExecutableInvocationHandler;
  readonly currentControlBasis: () => Effect.Effect<
    ControlBasis,
    ExecutionDriverError
  >;
  readonly admit: (
    activity: ExecutionActivity,
    observation: RuntimeSafetyObservation,
  ) => Effect.Effect<"Continue" | "Stop">;
  readonly failure: (cause: unknown) => ExecutionDriverError;
  readonly now: () => Effect.Effect<string>;
}

export type AgentLoopActionOutcome =
  | {
      readonly _tag: "Completed";
      readonly loopStep?: AgentLoopStepRecord;
      readonly observations: ReadonlyArray<{
        readonly source: "Runtime" | "Tool";
        readonly observation: BoundedObservation;
      }>;
      readonly durableProgress: boolean;
    }
  | { readonly _tag: "DecisionStale" }
  | { readonly _tag: "Settle"; readonly settlement: ExecutionSettlement };

/**
 * Owns one decoded turn's action phase. This boundary deliberately includes
 * both executable and control routes because they share the same durable
 * action ledger, idempotency rules, freshness admission, and early-settlement
 * semantics. The driver only consumes the resulting progression state.
 */
export const executeAgentLoopActions = (
  dependencies: AgentLoopActionDependencies,
): Effect.Effect<AgentLoopActionOutcome, ExecutionDriverError> => {
  const {
    input,
    preparedTurn,
    decodedOutput,
    turn,
    loopSteps,
    loopStepFence,
    tx,
    sessions,
    controlRegistry,
    executableInvocationHandler,
    currentControlBasis,
    admit,
    failure,
    now,
  } = dependencies;

  return Effect.gen(function* () {
    let currentLoopStep = dependencies.currentLoopStep;
    const observations: Array<{
      readonly source: "Runtime" | "Tool";
      readonly observation: BoundedObservation;
    }> = [];
    let durableProgress = false;

    for (const [
      actionIndex,
      invocation,
    ] of decodedOutput.toolInvocations.entries()) {
      const route = classifyToolRoute(
        preparedTurn.toolRoutes,
        controlRegistry,
        invocation.toolName,
      );
      if (route._tag === "Invalid") {
        return { _tag: "Settle", settlement: safetyStop(route.reason) };
      }

      let loopAction: AgentLoopStepActionRecord | undefined;
      if (
        currentLoopStep !== undefined &&
        loopSteps !== undefined &&
        loopStepFence !== undefined &&
        currentLoopStep.state === "ActionsInProgress"
      ) {
        const existingActions = yield* tx
          .transact(loopSteps.listActions(currentLoopStep.identity))
          .pipe(Effect.mapError(failure));
        loopAction = existingActions.find(
          (candidate) => candidate.actionIndex === actionIndex,
        );
        if (loopAction === undefined) {
          loopAction = yield* tx
            .transact(
              loopSteps.createAction(
                {
                  identity: currentLoopStep.identity,
                  actionIndex,
                  logicalActionId: `lac_${sha256Hex(
                    JSON.stringify({
                      executionId: input.execution.executionId,
                      providerTurnId: preparedTurn.manifest.providerTurnId,
                      callRef: invocation.callRef,
                      routeKind: route._tag,
                      actionKind: invocation.toolName,
                    }),
                  )}`,
                  callRef: invocation.callRef,
                  routeKind: route._tag,
                  actionKind: invocation.toolName,
                  inputHash: sha256Hex(invocation.argumentsJson),
                  state: "Pending",
                  revision: 0,
                  updatedAt: yield* now(),
                },
                loopStepFence,
              ),
            )
            .pipe(Effect.mapError(failure));
        } else if (loopAction.state !== "Pending") {
          continue;
        }
      }

      const persistActionSettlement = (
        settlement: ExecutionSettlement,
      ): Effect.Effect<void, ExecutionDriverError> =>
        Effect.gen(function* () {
          if (
            loopAction === undefined ||
            currentLoopStep === undefined ||
            loopSteps === undefined ||
            loopStepFence === undefined ||
            currentLoopStep.state !== "ActionsInProgress"
          ) {
            return;
          }
          const pendingAction = loopAction;
          const actionsStep = currentLoopStep;
          const settlementRef = `settlement_${sha256Hex(
            JSON.stringify(settlement),
          )}`;
          currentLoopStep = yield* tx
            .transact(
              Effect.gen(function* () {
                yield* loopSteps.transitionAction(
                  {
                    identity: pendingAction.identity,
                    actionIndex: pendingAction.actionIndex,
                    expectedRevision: pendingAction.revision,
                    expectedState: "Pending",
                    next: {
                      ...pendingAction,
                      state:
                        settlement._tag === "OutcomeUnknown"
                          ? "ReconciliationPending"
                          : "Applied",
                      settlementRef,
                      revision: pendingAction.revision + 1,
                      updatedAt: yield* now(),
                    },
                  },
                  loopStepFence,
                );
                for (
                  let skippedIndex = actionIndex + 1;
                  skippedIndex < decodedOutput.toolInvocations.length;
                  skippedIndex += 1
                ) {
                  const skippedInvocation =
                    decodedOutput.toolInvocations[skippedIndex];
                  if (skippedInvocation === undefined) continue;
                  const skippedRoute = classifyToolRoute(
                    preparedTurn.toolRoutes,
                    controlRegistry,
                    skippedInvocation.toolName,
                  );
                  if (skippedRoute._tag === "Invalid") continue;
                  const pending = yield* loopSteps.createAction(
                    {
                      identity: actionsStep.identity,
                      actionIndex: skippedIndex,
                      logicalActionId: `lac_${sha256Hex(
                        JSON.stringify({
                          executionId: input.execution.executionId,
                          providerTurnId: preparedTurn.manifest.providerTurnId,
                          callRef: skippedInvocation.callRef,
                          routeKind: skippedRoute._tag,
                          actionKind: skippedInvocation.toolName,
                        }),
                      )}`,
                      callRef: skippedInvocation.callRef,
                      routeKind: skippedRoute._tag,
                      actionKind: skippedInvocation.toolName,
                      inputHash: sha256Hex(skippedInvocation.argumentsJson),
                      state: "Pending",
                      revision: 0,
                      updatedAt: yield* now(),
                    },
                    loopStepFence,
                  );
                  yield* loopSteps.transitionAction(
                    {
                      identity: pending.identity,
                      actionIndex: pending.actionIndex,
                      expectedRevision: pending.revision,
                      expectedState: "Pending",
                      next: {
                        ...pending,
                        state: "SkippedEarlySettlement",
                        settlementRef,
                        revision: pending.revision + 1,
                        updatedAt: yield* now(),
                      },
                    },
                    loopStepFence,
                  );
                }
                return yield* loopSteps.transition(
                  {
                    identity: actionsStep.identity,
                    expectedRevision: actionsStep.revision,
                    expectedState: "ActionsInProgress",
                    next: {
                      ...actionsStep,
                      state: "SettlementProposed",
                      nextActionIndex: decodedOutput.toolInvocations.length,
                      settlement,
                      revision: actionsStep.revision + 1,
                      updatedAt: yield* now(),
                    },
                  },
                  loopStepFence,
                );
              }),
            )
            .pipe(Effect.mapError(failure));
        });

      const persistActionObservation = (
        source: "Runtime" | "Tool",
        observation: BoundedObservation,
        resultMetadata: {
          readonly status?: import("@arbor/ports").PortableToolResultStatus;
          readonly resultRef?: string;
          readonly artifactRefs?: ReadonlyArray<string>;
        } = {},
      ): Effect.Effect<boolean, ExecutionDriverError> =>
        Effect.gen(function* () {
          if (
            loopAction === undefined ||
            currentLoopStep === undefined ||
            loopSteps === undefined ||
            loopStepFence === undefined ||
            currentLoopStep.state !== "ActionsInProgress"
          ) {
            return false;
          }
          const pendingAction = loopAction;
          const actionsStep = currentLoopStep;
          const payload = { source, observation };
          const resultRef = `result_${sha256Hex(JSON.stringify(payload))}`;
          const observationSourceRef = `observation_${sha256Hex(
            JSON.stringify({
              providerTurnId: preparedTurn.manifest.providerTurnId,
              callRef: invocation.callRef,
              resultRef,
            }),
          )}`;
          currentLoopStep = yield* tx
            .transact(
              Effect.gen(function* () {
                if (yield* sessions.supportsTypedTimeline()) {
                  const item =
                    route._tag === "Executable"
                      ? {
                          _tag: "ToolResult" as const,
                          callRef: invocation.callRef,
                          toolName: invocation.toolName,
                          status: resultMetadata.status ?? "Succeeded",
                          observationRef: observationSourceRef,
                          modelOutputRef: resultMetadata.resultRef ?? resultRef,
                          outputText: observation.text,
                          truncated: observation.truncated,
                          artifactRefs: resultMetadata.artifactRefs ?? [],
                        }
                      : {
                          _tag: "ControlResult" as const,
                          callRef: invocation.callRef,
                          actionKind: invocation.toolName,
                          status: resultMetadata.status ?? "Succeeded",
                          disposition: "Applied",
                          outputText: observation.text,
                          truncated: observation.truncated,
                          canonicalRefs: [],
                          observationRef: observationSourceRef,
                        };
                  yield* sessions.appendItemIdempotent(
                    input.execution.sessionId,
                    {
                      item,
                      contextEpoch: preparedTurn.manifest.contextEpoch,
                      source: {
                        kind: "AgentLoopAction",
                        ref: observationSourceRef,
                      },
                      contentHash: sha256Hex(JSON.stringify(item)),
                    },
                    loopStepFence,
                  );
                } else {
                  yield* sessions.appendEntryIdempotent(
                    input.execution.sessionId,
                    { kind: "AgentLoopAction", ref: observationSourceRef },
                    { entryKind: "Observation", payload },
                    sha256Hex(JSON.stringify(payload)),
                    loopStepFence,
                  );
                }
                yield* loopSteps.transitionAction(
                  {
                    identity: pendingAction.identity,
                    actionIndex: pendingAction.actionIndex,
                    expectedRevision: pendingAction.revision,
                    expectedState: "Pending",
                    next: {
                      ...pendingAction,
                      state: "Applied",
                      resultRef,
                      observationSourceRef,
                      revision: pendingAction.revision + 1,
                      updatedAt: yield* now(),
                    },
                  },
                  loopStepFence,
                );
                return yield* loopSteps.transition(
                  {
                    identity: actionsStep.identity,
                    expectedRevision: actionsStep.revision,
                    expectedState: "ActionsInProgress",
                    next: {
                      ...actionsStep,
                      nextActionIndex: Math.max(
                        actionsStep.nextActionIndex,
                        actionIndex + 1,
                      ),
                      revision: actionsStep.revision + 1,
                      updatedAt: yield* now(),
                    },
                  },
                  loopStepFence,
                );
              }),
            )
            .pipe(Effect.mapError(failure));
          return true;
        });

      const activityDecision = yield* admit(
        {
          _tag: "ToolInvocation",
          fingerprint: `tool:${invocation.toolName}:${invocation.callRef}`,
        },
        { chainDepth: 1, observedAt: yield* now() },
      );
      if (activityDecision === "Stop") {
        return {
          _tag: "Settle",
          settlement: safetyStop("RuntimeSafetyStop"),
        };
      }

      if (route._tag === "Executable") {
        if (executableInvocationHandler === undefined) {
          return {
            _tag: "Settle",
            settlement: safetyStop("ExecutableToolHandlerUnavailable"),
          };
        }
        const executed = yield* Effect.match(
          executableInvocationHandler.handle({
            invocation,
            execution: input.execution,
            context: input.context,
            controlBasis: preparedTurn.manifest.controlBasis,
          }),
          {
            onFailure: (cause) => ({ ok: false as const, cause }),
            onSuccess: (outcome) => ({ ok: true as const, outcome }),
          },
        );
        if (!executed.ok) {
          return {
            _tag: "Settle",
            settlement: safetyStop("ExecutableToolInvocationRejected"),
          };
        }
        if (executed.outcome._tag === "Settle") {
          yield* persistActionSettlement(executed.outcome.settlement);
          return {
            _tag: "Settle",
            settlement: executed.outcome.settlement,
          };
        }
        const persisted = yield* persistActionObservation(
          executed.outcome.source,
          executed.outcome.observation,
          {
            ...(executed.outcome.status === undefined
              ? {}
              : { status: executed.outcome.status }),
            ...(executed.outcome.resultRef === undefined
              ? {}
              : { resultRef: executed.outcome.resultRef }),
            ...(executed.outcome.artifactRefs === undefined
              ? {}
              : { artifactRefs: executed.outcome.artifactRefs }),
          },
        );
        if (!persisted) {
          observations.push({
            source: executed.outcome.source,
            observation: executed.outcome.observation,
          });
        }
        durableProgress = true;
        continue;
      }

      const decodedAction = yield* Effect.match(
        controlRegistry.decode(invocation),
        {
          onFailure: (cause) => ({ ok: false as const, cause }),
          onSuccess: (value) => ({ ok: true as const, value }),
        },
      );
      if (!decodedAction.ok) {
        return {
          _tag: "Settle",
          settlement: safetyStop(
            `ControlToolDecodeFailed:${decodedAction.cause._tag}`,
          ),
        };
      }

      const current = yield* currentControlBasis();
      const freshness = checkFreshness(
        preparedTurn.manifest.controlBasis,
        current,
        requirementForAction(decodedAction.value.action),
      );
      if (freshness !== null) {
        if (
          loopAction !== undefined &&
          currentLoopStep !== undefined &&
          loopSteps !== undefined &&
          loopStepFence !== undefined &&
          currentLoopStep.state === "ActionsInProgress" &&
          turn + 1 < MAX_TURNS
        ) {
          const staleAction = loopAction;
          const staleStep = currentLoopStep;
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
                yield* loopSteps.transitionAction(
                  {
                    identity: staleAction.identity,
                    actionIndex: staleAction.actionIndex,
                    expectedRevision: staleAction.revision,
                    expectedState: "Pending",
                    next: {
                      ...staleAction,
                      state: "SkippedStale",
                      disposition: { _tag: "DecisionStale" },
                      revision: staleAction.revision + 1,
                      updatedAt: yield* now(),
                    },
                  },
                  loopStepFence,
                );
                for (
                  let skippedIndex = actionIndex + 1;
                  skippedIndex < decodedOutput.toolInvocations.length;
                  skippedIndex += 1
                ) {
                  const skippedInvocation =
                    decodedOutput.toolInvocations[skippedIndex];
                  if (skippedInvocation === undefined) continue;
                  const skippedRoute = classifyToolRoute(
                    preparedTurn.toolRoutes,
                    controlRegistry,
                    skippedInvocation.toolName,
                  );
                  if (skippedRoute._tag === "Invalid") continue;
                  const pending = yield* loopSteps.createAction(
                    {
                      identity: staleStep.identity,
                      actionIndex: skippedIndex,
                      logicalActionId: `lac_${sha256Hex(
                        JSON.stringify({
                          executionId: input.execution.executionId,
                          providerTurnId: preparedTurn.manifest.providerTurnId,
                          callRef: skippedInvocation.callRef,
                          routeKind: skippedRoute._tag,
                          actionKind: skippedInvocation.toolName,
                        }),
                      )}`,
                      callRef: skippedInvocation.callRef,
                      routeKind: skippedRoute._tag,
                      actionKind: skippedInvocation.toolName,
                      inputHash: sha256Hex(skippedInvocation.argumentsJson),
                      state: "Pending",
                      revision: 0,
                      updatedAt: yield* now(),
                    },
                    loopStepFence,
                  );
                  yield* loopSteps.transitionAction(
                    {
                      identity: pending.identity,
                      actionIndex: pending.actionIndex,
                      expectedRevision: pending.revision,
                      expectedState: "Pending",
                      next: {
                        ...pending,
                        state: "SkippedStale",
                        disposition: { _tag: "DecisionStale" },
                        revision: pending.revision + 1,
                        updatedAt: yield* now(),
                      },
                    },
                    loopStepFence,
                  );
                }
                yield* loopSteps.transition(
                  {
                    identity: staleStep.identity,
                    expectedRevision: staleStep.revision,
                    expectedState: "ActionsInProgress",
                    next: {
                      ...staleStep,
                      state: "NextStepReady",
                      nextActionIndex: decodedOutput.toolInvocations.length,
                      successor: {
                        ...successorIdentity,
                        providerTurnId: successorProviderTurnId,
                      },
                      nextStepReason: "DecisionStale",
                      revision: staleStep.revision + 1,
                      updatedAt: yield* now(),
                    },
                  },
                  loopStepFence,
                );
                yield* loopSteps.ensureSuccessor(
                  staleStep.identity,
                  {
                    identity: successorIdentity,
                    predecessor: staleStep.identity,
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
        return { _tag: "DecisionStale" };
      }

      const handled = yield* Effect.match(
        controlRegistry.handle({
          action: decodedAction.value.action,
          invocation,
          execution: input.execution,
          context: input.context,
        }),
        {
          onFailure: (cause) => ({ ok: false as const, cause }),
          onSuccess: (outcome) => ({ ok: true as const, outcome }),
        },
      );
      if (!handled.ok) {
        return {
          _tag: "Settle",
          settlement: safetyStop("ControlActionHandlerRejected"),
        };
      }
      if (handled.outcome._tag === "Settle") {
        yield* persistActionSettlement(handled.outcome.settlement);
        return {
          _tag: "Settle",
          settlement: handled.outcome.settlement,
        };
      }
      const persisted = yield* persistActionObservation(
        handled.outcome.source,
        handled.outcome.observation,
      );
      if (!persisted) {
        observations.push({
          source: handled.outcome.source,
          observation: handled.outcome.observation,
        });
      }
      durableProgress = true;
    }

    return {
      _tag: "Completed",
      ...(currentLoopStep === undefined ? {} : { loopStep: currentLoopStep }),
      observations,
      durableProgress,
    };
  });
};
