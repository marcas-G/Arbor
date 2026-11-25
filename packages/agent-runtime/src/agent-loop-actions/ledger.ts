import type { ExecutionSettlement, TerminalActionDenial, ToolInvocationId } from "@arbor/domain";
import type { ToolInvocation } from "@arbor/model-context";
import type {
  AgentLoopStepActionRecord,
  AgentLoopStepFence,
  AgentLoopStepRecord,
  BoundedObservation,
  ExecutionDriverError,
  LeaseFencingRejected,
  sessionCausalBindingForWork,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect, Option } from "effect";
import { classifyToolRoute } from "../control.js";
import type { AgentLoopActionDependencies } from "./types.js";

/** The orchestrator owns the cursor; ledger operations update the same cursor. */
export interface ActionLedgerCursor {
  currentLoopStep: AgentLoopStepRecord | undefined;
  loopAction: AgentLoopStepActionRecord | undefined;
}

type ActionRoute = { readonly _tag: "Executable" } | { readonly _tag: "Control" };

export const makeActionLedger = (
  dependencies: AgentLoopActionDependencies,
  cursor: ActionLedgerCursor,
  invocation: ToolInvocation,
  actionIndex: number,
  route: ActionRoute,
  causalBinding: ReturnType<typeof sessionCausalBindingForWork> | undefined,
) => {
  const { input, preparedTurn, decodedOutput, loopSteps, loopStepFence, tx, sessions, controlRegistry, recoverExactNotAdmittedAction, failure, now } = dependencies;

  const appendTerminalResult = (
    targetInvocation: ToolInvocation,
    targetRoute:
      | { readonly _tag: "Executable" }
      | { readonly _tag: "Control" },
    terminal: {
      readonly status: import("@arbor/ports").PortableToolResultStatus;
      readonly disposition: string;
      readonly outputText: string;
      readonly truncated?: boolean;
      readonly canonicalRefs?: ReadonlyArray<string>;
      readonly modelOutputRef?: string;
      readonly artifactRefs?: ReadonlyArray<string>;
      readonly invocationId?: ToolInvocationId;
      readonly reconciliationFactRef?: string;
    },
    fence: AgentLoopStepFence,
  ) =>
    Effect.gen(function* () {
      const resultRef = `result_${sha256Hex(
        JSON.stringify({
          callRef: targetInvocation.callRef,
          status: terminal.status,
          disposition: terminal.disposition,
          outputText: terminal.outputText,
        }),
      )}`;
      const observationSourceRef = `observation_${input.execution.executionId}_${sha256Hex(
        JSON.stringify({
          providerTurnId: preparedTurn.manifest.providerTurnId,
          callRef: targetInvocation.callRef,
          resultRef,
        }),
      )}`;
      if (yield* sessions.supportsTypedTimeline()) {
        const item =
          targetRoute._tag === "Executable"
            ? {
                _tag: "ToolResult" as const,
                callRef: targetInvocation.callRef,
                toolName: targetInvocation.toolName,
                ...(terminal.invocationId === undefined
                  ? {}
                  : { invocationId: terminal.invocationId }),
                ...(terminal.reconciliationFactRef === undefined
                  ? {}
                  : {
                      reconciliationFactRef: terminal.reconciliationFactRef,
                    }),
                ...(terminal.reconciliationFactRef === undefined
                  ? {}
                  : { disposition: terminal.disposition }),
                status: terminal.status,
                observationRef: observationSourceRef,
                modelOutputRef: terminal.modelOutputRef ?? resultRef,
                outputText: terminal.outputText,
                truncated: terminal.truncated ?? false,
                artifactRefs: terminal.artifactRefs ?? [],
              }
            : {
                _tag: "ControlResult" as const,
                callRef: targetInvocation.callRef,
                actionKind: targetInvocation.toolName,
                status: terminal.status,
                disposition: terminal.disposition,
                outputText: terminal.outputText,
                truncated: false,
                canonicalRefs: terminal.canonicalRefs ?? [],
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
            ...(causalBinding === undefined ? {} : { causalBinding }),
          },
          fence,
        );
      } else {
        const payload = {
          source: targetRoute._tag === "Executable" ? "Tool" : "Runtime",
          observation: {
            text: terminal.outputText,
            truncated: terminal.truncated ?? false,
          },
          ...(terminal.reconciliationFactRef === undefined
            ? {}
            : { reconciliationFactRef: terminal.reconciliationFactRef }),
          ...(terminal.modelOutputRef === undefined
            ? {}
            : { modelOutputRef: terminal.modelOutputRef }),
          ...(terminal.artifactRefs === undefined
            ? {}
            : { artifactRefs: terminal.artifactRefs }),
        } as const;
        yield* sessions.appendEntryIdempotent(
          input.execution.sessionId,
          { kind: "AgentLoopAction", ref: observationSourceRef },
          { entryKind: "Observation", payload },
          sha256Hex(JSON.stringify(payload)),
          fence,
          causalBinding,
        );
      }
      return { resultRef, observationSourceRef };
    });

  const persistTerminalAction = (terminal: {
    readonly settlement: ExecutionSettlement;
    readonly durableSettlementEffect?: Effect.Effect<
      void,
      unknown,
      import("@arbor/ports").TransactionScope
    >;
    readonly actionState:
      | "Applied"
      | "TerminalRejected"
      | "ReconciliationPending";
    readonly status: import("@arbor/ports").PortableToolResultStatus;
    readonly disposition: string;
    readonly outputText: string;
    readonly terminalDenial?: TerminalActionDenial;
    readonly truncated?: boolean;
    readonly modelOutputRef?: string;
    readonly artifactRefs?: ReadonlyArray<string>;
    readonly invocationId?: ToolInvocationId;
    readonly reconciliationFactRef?: string;
  }): Effect.Effect<void, ExecutionDriverError> =>
    Effect.gen(function* () {
      if (
        cursor.loopAction === undefined ||
        cursor.currentLoopStep === undefined ||
        loopSteps === undefined ||
        loopStepFence === undefined ||
        cursor.currentLoopStep.state !== "ActionsInProgress"
      ) {
        return;
      }
      const pendingAction = cursor.loopAction;
      const actionsStep = cursor.currentLoopStep;
      const settlementRef = `settlement_${sha256Hex(
        JSON.stringify(terminal.settlement),
      )}`;
      if (dependencies.qualificationProbe !== undefined) {
        yield* Effect.promise(
          () =>
            dependencies.qualificationProbe?.({
              boundary: "AH9BeforeTerminalActionCommit",
              providerTurnId: preparedTurn.manifest.providerTurnId,
              executionId: input.execution.executionId,
              logicalActionId: pendingAction.logicalActionId,
              actionKind: invocation.toolName,
              routeKind: route._tag,
              callRef: invocation.callRef,
              actionIndex,
            }) ?? Promise.resolve(),
        );
      }
      if (
        terminal.actionState === "ReconciliationPending" &&
        terminal.status === "OutcomeUnknown" &&
        dependencies.qualificationProbe !== undefined
      ) {
        yield* Effect.promise(
          () =>
            dependencies.qualificationProbe?.({
              boundary: "AH7BeforeActionResultCommit",
              providerTurnId: preparedTurn.manifest.providerTurnId,
              executionId: input.execution.executionId,
              logicalActionId: pendingAction.logicalActionId,
              callRef: invocation.callRef,
              actionIndex,
            }) ?? Promise.resolve(),
        );
      }
      cursor.currentLoopStep = yield* tx
        .transact(
          Effect.gen(function* () {
            if (terminal.durableSettlementEffect !== undefined) {
              const persistedActions = yield* loopSteps.listActions(
                pendingAction.identity,
              );
              const persistedAction = persistedActions.find(
                (candidate) =>
                  candidate.actionIndex === pendingAction.actionIndex &&
                  candidate.logicalActionId ===
                    pendingAction.logicalActionId &&
                  candidate.callRef === pendingAction.callRef,
              );
              if (
                persistedAction === undefined ||
                persistedAction.state !== "Pending"
              ) {
                if (dependencies.qualificationProbe !== undefined) {
                  yield* Effect.promise(
                    () =>
                      dependencies.qualificationProbe?.({
                        boundary: "AH7StaleDirectControlEffectSuppressed",
                        providerTurnId:
                          preparedTurn.manifest.providerTurnId,
                        executionId: input.execution.executionId,
                        logicalActionId: pendingAction.logicalActionId,
                        actionKind: invocation.toolName,
                        routeKind: "Control",
                        callRef: invocation.callRef,
                        actionIndex,
                        stage:
                          persistedAction === undefined
                            ? "P9ActionMissing"
                            : `P9Action${persistedAction.state}`,
                      }) ?? Promise.resolve(),
                  );
                }
                return yield* Effect.fail<LeaseFencingRejected>({
                  _tag: "LeaseFencingRejected",
                  executionId: loopStepFence.executionId,
                  generation: loopStepFence.fencingGeneration,
                });
              }
            }
            const terminalResult = yield* appendTerminalResult(
              invocation,
              route,
              {
                status: terminal.status,
                disposition: terminal.disposition,
                outputText: terminal.outputText,
                ...(terminal.truncated === undefined
                  ? {}
                  : { truncated: terminal.truncated }),
                canonicalRefs: [settlementRef],
                ...(terminal.modelOutputRef === undefined
                  ? {}
                  : { modelOutputRef: terminal.modelOutputRef }),
                ...(terminal.artifactRefs === undefined
                  ? {}
                  : { artifactRefs: terminal.artifactRefs }),
                ...(terminal.invocationId === undefined
                  ? {}
                  : { invocationId: terminal.invocationId }),
                ...(terminal.reconciliationFactRef === undefined
                  ? {}
                  : {
                      reconciliationFactRef: terminal.reconciliationFactRef,
                    }),
              },
              loopStepFence,
            );
            if (terminal.durableSettlementEffect !== undefined) {
              yield* terminal.durableSettlementEffect;
              if (dependencies.qualificationProbe !== undefined) {
                yield* Effect.promise(
                  () =>
                    dependencies.qualificationProbe?.({
                      boundary: "AH7BeforeActionResultCommit",
                      providerTurnId: preparedTurn.manifest.providerTurnId,
                      executionId: input.execution.executionId,
                      logicalActionId: pendingAction.logicalActionId,
                      actionKind: invocation.toolName,
                      routeKind: "Control",
                      callRef: invocation.callRef,
                      actionIndex,
                    }) ?? Promise.resolve(),
                );
              }
            }
            yield* loopSteps.transitionAction(
              {
                identity: pendingAction.identity,
                actionIndex: pendingAction.actionIndex,
                expectedRevision: pendingAction.revision,
                expectedState: "Pending",
                next: {
                  ...pendingAction,
                  state: terminal.actionState,
                  resultRef: terminalResult.resultRef,
                  settlementRef,
                  disposition: {
                    _tag: terminal.disposition,
                    status: terminal.status,
                    ...(terminal.terminalDenial === undefined
                      ? {}
                      : { terminalDenial: terminal.terminalDenial }),
                  },
                  observationSourceRef: terminalResult.observationSourceRef,
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
              const skippedClassification = classifyToolRoute(
                preparedTurn.toolRoutes,
                controlRegistry,
                skippedInvocation.toolName,
              );
              if (skippedClassification._tag === "Invalid") continue;
              const skippedRoute =
                skippedClassification._tag === "Stale"
                  ? ({ _tag: skippedClassification.route } as const)
                  : skippedClassification;
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
              const skippedResult = yield* appendTerminalResult(
                skippedInvocation,
                skippedRoute,
                {
                  status: "Interrupted",
                  disposition: "SkippedEarlySettlement",
                  outputText: `${skippedInvocation.toolName} skipped because an earlier action settled the execution`,
                  canonicalRefs: [settlementRef],
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
                    resultRef: skippedResult.resultRef,
                    settlementRef,
                    disposition: { _tag: "SkippedEarlySettlement" },
                    observationSourceRef:
                      skippedResult.observationSourceRef,
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
                  settlement: terminal.settlement,
                  revision: actionsStep.revision + 1,
                  updatedAt: yield* now(),
                },
              },
              loopStepFence,
            );
          }),
        )
        .pipe(Effect.mapError(failure));
      if (
        terminal.actionState === "ReconciliationPending" &&
        terminal.status === "OutcomeUnknown" &&
        dependencies.qualificationProbe !== undefined
      ) {
        yield* Effect.promise(
          () =>
            dependencies.qualificationProbe?.({
              boundary: "AH7AfterActionResultCommit",
              providerTurnId: preparedTurn.manifest.providerTurnId,
              executionId: input.execution.executionId,
              logicalActionId: pendingAction.logicalActionId,
              callRef: invocation.callRef,
              actionIndex,
            }) ?? Promise.resolve(),
        );
      }
      if (dependencies.qualificationProbe !== undefined) {
        yield* Effect.promise(
          () =>
            dependencies.qualificationProbe?.({
              boundary: "AH9AfterTerminalActionCommit",
              providerTurnId: preparedTurn.manifest.providerTurnId,
              executionId: input.execution.executionId,
              logicalActionId: pendingAction.logicalActionId,
              actionKind: invocation.toolName,
              routeKind: route._tag,
              callRef: invocation.callRef,
              actionIndex,
            }) ?? Promise.resolve(),
        );
      }
    });

  const persistActionSettlement = (
    settlement: ExecutionSettlement,
    durableSettlementEffect?: Effect.Effect<
      void,
      unknown,
      import("@arbor/ports").TransactionScope
    >,
  ): Effect.Effect<void, ExecutionDriverError> =>
    Effect.gen(function* () {
      if (
        settlement._tag === "OutcomeUnknown" &&
        loopStepFence !== undefined &&
        dependencies.recordReconciliationEscalation !== undefined
      ) {
        yield* dependencies
          .recordReconciliationEscalation({
            execution: input.execution,
            fence: loopStepFence,
            principal: input.context.principal,
            invocationRefs: settlement.reconciliation.invocationRefs,
          })
          .pipe(Effect.mapError(failure));
      }
      yield* persistTerminalAction({
        settlement,
        actionState:
          settlement._tag === "OutcomeUnknown"
            ? "ReconciliationPending"
            : "Applied",
        status:
          settlement._tag === "OutcomeUnknown"
            ? "OutcomeUnknown"
            : settlement._tag === "Interrupted"
              ? "Interrupted"
              : settlement._tag === "Failed"
                ? "Failed"
                : "Succeeded",
        disposition: `ExecutionSettlement:${settlement._tag}`,
        outputText: `Control action settled the execution (${settlement._tag})`,
        ...(durableSettlementEffect === undefined
          ? {}
          : { durableSettlementEffect }),
      });
    });

  const persistActionRejection = (
    settlement: ExecutionSettlement,
    disposition: string,
    status: import("@arbor/ports").PortableToolResultStatus = "Denied",
    terminalDenial?: TerminalActionDenial,
  ): Effect.Effect<void, ExecutionDriverError> =>
    persistTerminalAction({
      settlement,
      actionState: "TerminalRejected",
      status,
      disposition,
      outputText: `${invocation.toolName} rejected by runtime (${disposition})`,
      ...(terminalDenial === undefined ? {} : { terminalDenial }),
    });

  const persistActionObservation = (
    source: "Runtime" | "Tool",
    observation: BoundedObservation,
    resultMetadata: {
      readonly status?: import("@arbor/ports").PortableToolResultStatus;
      readonly disposition?: string;
      readonly resultRef?: string;
      readonly artifactRefs?: ReadonlyArray<string>;
      readonly invocationId?: import("@arbor/domain").ToolInvocationId;
      readonly terminalDenial?: TerminalActionDenial;
      readonly reconciliationFactRef?: string;
    } = {},
  ): Effect.Effect<boolean, ExecutionDriverError> =>
    Effect.gen(function* () {
      // Recovery can settle the P4 invocation before this P3 process has
      // observed the corresponding fenced step transition. Refresh the
      // exact step/action tuple before treating a stale in-memory cursor
      // as an inability to project the terminal ToolResult.
      if (
        loopSteps !== undefined &&
        typeof loopSteps.find === "function" &&
        loopStepFence !== undefined &&
        cursor.currentLoopStep !== undefined
      ) {
        const freshStep = yield* tx
          .transact(loopSteps.find(cursor.currentLoopStep.identity))
          .pipe(Effect.mapError(failure));
        if (Option.isSome(freshStep)) {
          cursor.currentLoopStep = freshStep.value;
          const freshActions = yield* tx
            .transact(loopSteps.listActions(cursor.currentLoopStep.identity))
            .pipe(Effect.mapError(failure));
          cursor.loopAction = freshActions.find(
            (candidate) => candidate.actionIndex === actionIndex,
          );
        }
      }
      if (
        cursor.loopAction === undefined ||
        cursor.currentLoopStep === undefined ||
        loopSteps === undefined ||
        loopStepFence === undefined
      ) {
        return false;
      }
      const pendingAction = cursor.loopAction;
      const actionsStep = cursor.currentLoopStep;
      const status = resultMetadata.status ?? "Succeeded";
      const disposition = resultMetadata.disposition ?? "Applied";
      const recoveringAppliedAction =
        pendingAction.state === "Applied" &&
        actionsStep.state === "NextStepReady" &&
        recoverExactNotAdmittedAction !== undefined &&
        recoverExactNotAdmittedAction.logicalActionId ===
          pendingAction.logicalActionId &&
        recoverExactNotAdmittedAction.actionIndex ===
          pendingAction.actionIndex &&
        recoverExactNotAdmittedAction.callRef === pendingAction.callRef &&
        status === "Denied" &&
        resultMetadata.terminalDenial?._tag === "P4NoEffectDenied";
      if (
        cursor.currentLoopStep.state !== "ActionsInProgress" &&
        !recoveringAppliedAction
      ) {
        return false;
      }
      const payload = {
        source,
        observation,
        status,
        disposition,
        ...(resultMetadata.terminalDenial === undefined
          ? {}
          : { terminalDenial: resultMetadata.terminalDenial }),
      };
      const resultRef = `result_${sha256Hex(JSON.stringify(payload))}`;
      const denialSettlementRef =
        status === "Denied" && resultMetadata.terminalDenial !== undefined
          ? `settlement_${sha256Hex(
              JSON.stringify({
                logicalActionId: cursor.loopAction?.logicalActionId,
                resultRef,
                terminalDenial: resultMetadata.terminalDenial,
              }),
            )}`
          : undefined;
      const observationSourceRef = `observation_${input.execution.executionId}_${sha256Hex(
        JSON.stringify({
          providerTurnId: preparedTurn.manifest.providerTurnId,
          callRef: invocation.callRef,
          resultRef,
        }),
      )}`;
      cursor.currentLoopStep = yield* tx
        .transact(
          Effect.gen(function* () {
            if (yield* sessions.supportsTypedTimeline()) {
              const item =
                route._tag === "Executable"
                  ? {
                      _tag: "ToolResult" as const,
                      callRef: invocation.callRef,
                      toolName: invocation.toolName,
                      ...(resultMetadata.invocationId === undefined
                        ? {}
                        : { invocationId: resultMetadata.invocationId }),
                      ...(resultMetadata.reconciliationFactRef === undefined
                        ? {}
                        : {
                            reconciliationFactRef:
                              resultMetadata.reconciliationFactRef,
                          }),
                      ...(resultMetadata.reconciliationFactRef === undefined
                        ? {}
                        : { disposition }),
                      status,
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
                      status,
                      disposition,
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
                  ...(causalBinding === undefined ? {} : { causalBinding }),
                },
                loopStepFence,
              );
            } else {
              const durablePayload = {
                ...payload,
                ...(resultMetadata.reconciliationFactRef === undefined
                  ? {}
                  : {
                      reconciliationFactRef:
                        resultMetadata.reconciliationFactRef,
                    }),
              };
              yield* sessions.appendEntryIdempotent(
                input.execution.sessionId,
                { kind: "AgentLoopAction", ref: observationSourceRef },
                { entryKind: "Observation", payload: durablePayload },
                sha256Hex(JSON.stringify(durablePayload)),
                loopStepFence,
                causalBinding,
              );
            }
            yield* loopSteps.transitionAction(
              {
                identity: pendingAction.identity,
                actionIndex: pendingAction.actionIndex,
                expectedRevision: pendingAction.revision,
                expectedState: pendingAction.state,
                next: {
                  ...pendingAction,
                  state:
                    route._tag === "Executable" && status === "Denied"
                      ? "TerminalRejected"
                      : "Applied",
                  resultRef,
                  ...(denialSettlementRef === undefined
                    ? {}
                    : { settlementRef: denialSettlementRef }),
                  disposition: {
                    _tag: disposition,
                    status,
                    ...(resultMetadata.terminalDenial === undefined
                      ? {}
                      : { terminalDenial: resultMetadata.terminalDenial }),
                  },
                  observationSourceRef,
                  revision: pendingAction.revision + 1,
                  updatedAt: yield* now(),
                },
              },
              loopStepFence,
            );
            if (actionsStep.state === "NextStepReady") {
              return actionsStep;
            }
            const advancedStep = yield* loopSteps.transition(
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
            if (dependencies.qualificationProbe !== undefined) {
              yield* Effect.promise(
                () =>
                  dependencies.qualificationProbe?.({
                    boundary: "AH7BeforeActionResultCommit",
                    providerTurnId: preparedTurn.manifest.providerTurnId,
                    executionId: input.execution.executionId,
                    logicalActionId: pendingAction.logicalActionId,
                    callRef: invocation.callRef,
                    actionIndex,
                  }) ?? Promise.resolve(),
              );
            }
            return advancedStep;
          }),
        )
        .pipe(Effect.mapError(failure));
      if (dependencies.qualificationProbe !== undefined) {
        yield* Effect.promise(
          () =>
            dependencies.qualificationProbe?.({
              boundary: "AH7AfterActionResultCommit",
              providerTurnId: preparedTurn.manifest.providerTurnId,
              executionId: input.execution.executionId,
              logicalActionId: pendingAction.logicalActionId,
              callRef: invocation.callRef,
              actionIndex,
            }) ?? Promise.resolve(),
        );
      }
      return true;
    });

  return { appendTerminalResult, persistTerminalAction, persistActionSettlement, persistActionRejection, persistActionObservation };
};
