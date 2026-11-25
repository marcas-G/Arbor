import type {
  Execution,
  ExecutionSettlement,
  TerminalActionDenial,
  ToolInvocationId,
} from "@arbor/domain";
import {
  providerTurnInferenceId,
  workEpisode,
} from "@arbor/domain";
import {
  type ToolInvocation,
} from "@arbor/model-context";
import type {
  AgentLoopStepActionRecord,
  AgentLoopStepFence,
  AgentLoopStepRecord,
  BoundedObservation,
  ExecutionDriverError,
  LeaseFencingRejected,
} from "@arbor/ports";
import {
  SandboxPolicyDecisionStore,
  SandboxProviderUnavailableStore,
  sessionCausalBindingForWork,
  sha256Hex,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  MAX_TURNS,
  safetyStop,
  stopRequestedSettlement,
} from "./agent-loop-policy.js";
import {
  type AgentActionError,
  classifyToolRoute,
} from "./control.js";
import { checkFreshness, requirementForAction } from "./freshness.js";
import {
  agentActionSafetyFingerprint,
  isDurableSuccessfulActionProgress,
} from "./p12-safety-identity.js";
import {
  recoveryBindingIdentityFor,
  recoveryBindingPolicyRevisionsFor,
} from "./recovery-binding-source.js";

import type { AgentLoopActionDependencies, AgentLoopActionOutcome } from "./agent-loop-actions/types.js";
import { makeBlockedSettlement } from "./agent-loop-actions/blocked-settlement.js";
import { verifyCommittedStep } from "./agent-loop-actions/committed-step.js";

export {
  recoveryBindingIdentityFor,
  recoveryBindingPolicyRevisionsFor,
} from "./recovery-binding-source.js";
export { verifySandboxUnavailableStepActionResume } from "./sandbox-unavailable-recovery.js";

const actionRejectionObservation = (
  error: Extract<AgentActionError, { readonly _tag: "AgentActionRejected" }>,
): BoundedObservation => ({
  text: JSON.stringify({
    code: error.code,
    message: error.safeMessage,
    correction: error.correction,
  }),
  truncated: false,
});

const isLeaseFencingRejected = (
  cause: unknown,
): cause is LeaseFencingRejected =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  cause._tag === "LeaseFencingRejected";

export type { AgentLoopActionDependencies, AgentLoopActionOutcome } from "./agent-loop-actions/types.js";
export { makeBlockedSettlement } from "./agent-loop-actions/blocked-settlement.js";

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
    providerTurns,
    loopStepFence,
    tx,
    sessions,
    controlRegistry,
    controlAuthorizer,
    executableInvocationHandler,
    recoverExactNotAdmittedAction,
    currentControlBasis,
    admit,
    failure,
    now,
  } = dependencies;

  return Effect.gen(function* () {
    const sandboxUnavailableFacts = yield* Effect.serviceOption(
      SandboxProviderUnavailableStore,
    );
    const sandboxPolicyDecisions = yield* Effect.serviceOption(
      SandboxPolicyDecisionStore,
    );
    let currentLoopStep = dependencies.currentLoopStep;
    const workBinding = workEpisode(input.execution);
    const causalBinding =
      workBinding === null
        ? undefined
        : sessionCausalBindingForWork({
            projectId: input.execution.projectId,
            workspaceId: input.execution.workspaceId,
            workId: workBinding.workId,
            executionId: input.execution.executionId,
            causedByRef: String(preparedTurn.manifest.providerTurnId),
          });
    const observations: Array<{
      readonly source: "Runtime" | "Tool";
      readonly observation: BoundedObservation;
    }> = [];
    let durableProgress = false;

    // A committed step can advance only after exact ledger verification.
    if (currentLoopStep?.state === "StepEffectsCommitted") {
      const verification = yield* verifyCommittedStep(
        dependencies,
        currentLoopStep,
        sandboxUnavailableFacts,
        sandboxPolicyDecisions,
      );
      return {
        _tag: "Completed",
        loopStep: verification,
        observations,
        durableProgress,
      };
    }


    for (const [
      actionIndex,
      invocation,
    ] of decodedOutput.toolInvocations.entries()) {
      const classification = classifyToolRoute(
        preparedTurn.toolRoutes,
        controlRegistry,
        invocation.toolName,
      );
      if (classification._tag === "Invalid") {
        return {
          _tag: "Settle",
          settlement: safetyStop(classification.reason),
        };
      }
      const staleRegistration = classification._tag === "Stale";
      const route =
        classification._tag === "Stale"
          ? ({ _tag: classification.route } as const)
          : classification;

      let loopAction: AgentLoopStepActionRecord | undefined;
      if (
        currentLoopStep !== undefined &&
        loopSteps !== undefined &&
        loopStepFence !== undefined &&
        (currentLoopStep.state === "ActionsInProgress" ||
          (currentLoopStep.state === "NextStepReady" &&
            recoverExactNotAdmittedAction !== undefined &&
            recoverExactNotAdmittedAction.executionId ===
              currentLoopStep.identity.executionId &&
            recoverExactNotAdmittedAction.logicalStepNo ===
              currentLoopStep.identity.logicalStepNo &&
            recoverExactNotAdmittedAction.repairAttempt ===
              currentLoopStep.identity.repairAttempt &&
            recoverExactNotAdmittedAction.providerTurnId ===
              currentLoopStep.providerTurnId))
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
          const exactRecovery =
            loopAction.state === "Applied" &&
            route._tag === "Executable" &&
            recoverExactNotAdmittedAction !== undefined &&
            recoverExactNotAdmittedAction.logicalActionId ===
              loopAction.logicalActionId &&
            recoverExactNotAdmittedAction.actionIndex === actionIndex &&
            recoverExactNotAdmittedAction.callRef === invocation.callRef;
          if (!exactRecovery) continue;
        }
        if (
          dependencies.qualificationProbe !== undefined &&
          loopAction !== undefined
        ) {
          const pendingAction = loopAction;
          yield* Effect.promise(
            () =>
              dependencies.qualificationProbe?.({
                boundary: "AH7AfterActionIntentCommit",
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
      }

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
          currentLoopStep = yield* tx
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
            currentLoopStep !== undefined
          ) {
            const freshStep = yield* tx
              .transact(loopSteps.find(currentLoopStep.identity))
              .pipe(Effect.mapError(failure));
            if (Option.isSome(freshStep)) {
              currentLoopStep = freshStep.value;
              const freshActions = yield* tx
                .transact(loopSteps.listActions(currentLoopStep.identity))
                .pipe(Effect.mapError(failure));
              loopAction = freshActions.find(
                (candidate) => candidate.actionIndex === actionIndex,
              );
            }
          }
          if (
            loopAction === undefined ||
            currentLoopStep === undefined ||
            loopSteps === undefined ||
            loopStepFence === undefined
          ) {
            return false;
          }
          const pendingAction = loopAction;
          const actionsStep = currentLoopStep;
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
            currentLoopStep.state !== "ActionsInProgress" &&
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
                    logicalActionId: loopAction?.logicalActionId,
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

      const activityDecision = yield* admit(
        {
          _tag: "ToolInvocation",
          fingerprint: agentActionSafetyFingerprint(
            route._tag,
            invocation.toolName,
            invocation.argumentsJson,
          ),
        },
        { chainDepth: 1, observedAt: yield* now() },
      );
      if (staleRegistration) {
        const settlement = safetyStop("StaleToolRegistration");
        yield* persistActionRejection(settlement, "StaleToolRegistration");
        return { _tag: "Settle", settlement };
      }
      if (activityDecision === "Stop") {
        const stopRequested = stopRequestedSettlement(input.execution);
        const settlement = stopRequested ?? safetyStop("RuntimeSafetyStop");
        yield* persistActionRejection(
          settlement,
          stopRequested === undefined
            ? "RuntimeSafetyStop"
            : "ExecutionStopping",
          "Interrupted",
        );
        return {
          _tag: "Settle",
          settlement,
        };
      }

      if (route._tag === "Executable") {
        if (executableInvocationHandler === undefined) {
          const settlement = safetyStop("ExecutableToolHandlerUnavailable");
          yield* persistActionRejection(settlement, "HandlerUnavailable");
          return {
            _tag: "Settle",
            settlement,
          };
        }
        const recoveryBindingIdentity = recoveryBindingIdentityFor({
          step: currentLoopStep,
          action: loopAction,
          executionId: input.execution.executionId,
          providerTurnId: preparedTurn.manifest.providerTurnId,
          actionIndex,
          callRef: invocation.callRef,
        });
        const recoveryBindingPolicyRevisions =
          recoveryBindingPolicyRevisionsFor(preparedTurn.manifest.controlBasis);
        const executed = yield* Effect.match(
          executableInvocationHandler.handle({
            invocation,
            execution: input.execution,
            context: input.context,
            controlBasis: preparedTurn.manifest.controlBasis,
            ...(loopAction === undefined
              ? {}
              : {
                  action: {
                    logicalStepNo: loopAction.identity.logicalStepNo,
                    repairAttempt: loopAction.identity.repairAttempt,
                    actionIndex: loopAction.actionIndex,
                    logicalActionId: loopAction.logicalActionId,
                  },
                }),
            ...(recoveryBindingIdentity === undefined
              ? {}
              : { recoveryBindingIdentity }),
            ...(recoveryBindingPolicyRevisions === undefined
              ? {}
              : { recoveryBindingPolicyRevisions }),
            ...(loopStepFence === undefined
              ? {}
              : { executionFence: loopStepFence }),
            providerTurnId: preparedTurn.manifest.providerTurnId,
            ...(loopAction === undefined
              ? {}
              : { logicalActionId: loopAction.logicalActionId }),
          }),
          {
            onFailure: (cause) => ({ ok: false as const, cause }),
            onSuccess: (outcome) => ({ ok: true as const, outcome }),
          },
        );
        if (!executed.ok) {
          if (executed.cause._tag === "AgentActionRecoveryBlocked") {
            return { _tag: "RecoveryBlocked" };
          }
          if (
            executed.cause._tag === "AgentActionOperationalFailure" &&
            isLeaseFencingRejected(executed.cause.cause)
          ) {
            return yield* Effect.fail(failure(executed.cause.cause));
          }
          const stopSettlement = stopRequestedSettlement(input.execution);
          if (stopSettlement !== undefined) {
            yield* persistActionRejection(
              stopSettlement,
              "ExecutionStopping",
              "Interrupted",
            );
            return { _tag: "Settle", settlement: stopSettlement };
          }
          if (executed.cause._tag === "AgentActionRejected") {
            const disposition = `ModelUsable:${executed.cause.code}`;
            const observation = actionRejectionObservation(executed.cause);
            const persisted = yield* persistActionObservation(
              "Runtime",
              observation,
              { status: "Failed", disposition },
            );
            if (!persisted) {
              observations.push({ source: "Runtime", observation });
            }
            // A persisted corrective failure is model-visible, but it is not
            // successful progress for the shared P12 D2/D4 signal.
            continue;
          }
          const settlement = safetyStop("ExecutableToolInvocationRejected");
          yield* persistActionRejection(
            settlement,
            "HandlerRejected",
            "Denied",
            {
              _tag: "HandlerRejected",
              routeKind: "Executable",
            },
          );
          return {
            _tag: "Settle",
            settlement,
          };
        }
        if (executed.outcome._tag === "SandboxProviderUnavailable") {
          return {
            _tag: "SandboxProviderUnavailable",
            outcome: executed.outcome.outcome,
          };
        }
        if (executed.outcome._tag === "SandboxPolicyRequiredInterruption") {
          return { _tag: "SandboxPolicyRequiredInterruption" };
        }
        if (executed.outcome._tag === "Settle") {
          yield* persistActionSettlement(executed.outcome.settlement);
          return {
            _tag: "Settle",
            settlement: executed.outcome.settlement,
          };
        }
        if (executed.outcome._tag === "ApprovalRequired") {
          return {
            _tag: "ApprovalRequired",
            approvalId: executed.outcome.approvalId,
            revision: executed.outcome.revision,
          };
        }
        if (executed.outcome.status === "Interrupted") {
          if (
            executed.outcome.reconciliationFactRef !== undefined &&
            executed.outcome.disposition === "ExecutionStopping"
          ) {
            const settlement: ExecutionSettlement = {
              _tag: "Interrupted",
              result: { _tag: "StopRequested" },
            };
            yield* persistTerminalAction({
              settlement,
              actionState: "TerminalRejected",
              status: "Interrupted",
              disposition: "ExecutionStopping",
              outputText: executed.outcome.observation.text,
              truncated: executed.outcome.observation.truncated,
              ...(executed.outcome.resultRef === undefined
                ? {}
                : { modelOutputRef: executed.outcome.resultRef }),
              ...(executed.outcome.artifactRefs === undefined
                ? {}
                : { artifactRefs: executed.outcome.artifactRefs }),
              ...(executed.outcome.invocationId === undefined
                ? {}
                : { invocationId: executed.outcome.invocationId }),
              reconciliationFactRef: executed.outcome.reconciliationFactRef,
            });
            return { _tag: "Settle", settlement };
          }
          const settlement: ExecutionSettlement = {
            _tag: "Interrupted",
            result: { _tag: "StopRequested" },
          };
          const disposition =
            executed.outcome.disposition ?? "ExecutionStopping";
          yield* persistActionRejection(settlement, disposition, "Interrupted");
          return { _tag: "Settle", settlement };
        }
        const persisted = yield* persistActionObservation(
          executed.outcome.source,
          executed.outcome.observation,
          {
            ...(executed.outcome.status === undefined
              ? {}
              : { status: executed.outcome.status }),
            ...(executed.outcome.disposition === undefined
              ? {}
              : { disposition: executed.outcome.disposition }),
            ...(executed.outcome.resultRef === undefined
              ? {}
              : { resultRef: executed.outcome.resultRef }),
            ...(executed.outcome.artifactRefs === undefined
              ? {}
              : { artifactRefs: executed.outcome.artifactRefs }),
            ...(executed.outcome.invocationId === undefined
              ? {}
              : { invocationId: executed.outcome.invocationId }),
            ...(executed.outcome.terminalDenial === undefined
              ? {}
              : { terminalDenial: executed.outcome.terminalDenial }),
            ...(executed.outcome.reconciliationFactRef === undefined
              ? {}
              : {
                  reconciliationFactRef: executed.outcome.reconciliationFactRef,
                }),
          },
        );
        if (!persisted) {
          observations.push({
            source: executed.outcome.source,
            observation: executed.outcome.observation,
          });
        }
        durableProgress =
          durableProgress ||
          isDurableSuccessfulActionProgress({
            persistenceCommitted: persisted,
            status: executed.outcome.status ?? "Succeeded",
          });
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
        if (decodedAction.cause._tag === "InvalidControlArguments") {
          const disposition =
            "ModelCorrectable:InvalidControlArguments" as const;
          const observation = {
            text: JSON.stringify({
              code: "invalid_control_arguments",
              toolName: decodedAction.cause.toolName,
              reason: decodedAction.cause.reason,
              correction:
                "Correct the arguments for this control action and try again with a new tool call.",
            }),
            truncated: false,
          };
          const persisted = yield* persistActionObservation(
            "Runtime",
            observation,
            { status: "Failed", disposition },
          );
          if (!persisted) {
            observations.push({ source: "Runtime", observation });
          }
          continue;
        }
        const settlement = safetyStop(
          `ControlToolDecodeFailed:${decodedAction.cause._tag}`,
        );
        yield* persistActionRejection(settlement, "DecodeRejected");
        return {
          _tag: "Settle",
          settlement,
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
          const successorProviderTurnId = providerTurnInferenceId(
            input.execution.executionId,
            turn + 1,
          );
          yield* tx
            .transact(
              Effect.gen(function* () {
                const staleResult = yield* appendTerminalResult(
                  invocation,
                  route,
                  {
                    status: "Denied",
                    disposition: "DecisionStale",
                    outputText: `${invocation.toolName} skipped because the decision basis became stale`,
                  },
                  loopStepFence,
                );
                yield* loopSteps.transitionAction(
                  {
                    identity: staleAction.identity,
                    actionIndex: staleAction.actionIndex,
                    expectedRevision: staleAction.revision,
                    expectedState: "Pending",
                    next: {
                      ...staleAction,
                      state: "SkippedStale",
                      resultRef: staleResult.resultRef,
                      disposition: { _tag: "DecisionStale" },
                      observationSourceRef: staleResult.observationSourceRef,
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
                  const skippedStaleResult = yield* appendTerminalResult(
                    skippedInvocation,
                    skippedRoute,
                    {
                      status: "Denied",
                      disposition: "DecisionStale",
                      outputText: `${skippedInvocation.toolName} skipped because the decision basis became stale`,
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
                        resultRef: skippedStaleResult.resultRef,
                        disposition: { _tag: "DecisionStale" },
                        observationSourceRef:
                          skippedStaleResult.observationSourceRef,
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

      const authorization =
        controlAuthorizer === undefined
          ? {
              _tag: "Authorized" as const,
              authorityRef: "legacy-test-only",
              actionDigest: sha256Hex(
                JSON.stringify(decodedAction.value.action),
              ),
              controlBasisDigest: sha256Hex(JSON.stringify(current)),
            }
          : yield* controlAuthorizer.authorize({
              action: decodedAction.value.action,
              invocation,
              ...(loopAction === undefined
                ? {}
                : { logicalActionId: loopAction.logicalActionId }),
              execution: input.execution,
              context: input.context,
              controlBasis: current,
            });
      if (authorization._tag === "ApprovalRequired") {
        return {
          _tag: "ApprovalRequired",
          approvalId: authorization.approvalId,
          revision: authorization.revision,
        };
      }
      if (authorization._tag === "RecoveryBlocked") {
        return { _tag: "RecoveryBlocked" };
      }
      if (authorization._tag === "Denied") {
        const observation = {
          text: JSON.stringify({
            code: "control_action_denied",
            reason: authorization.reason,
            correction: "RequestHumanApprovalOrChooseAlternative",
          }),
          truncated: false,
        };
        const persisted = yield* persistActionObservation(
          "Runtime",
          observation,
          { status: "Denied", disposition: "AuthorizationDenied" },
        );
        if (!persisted) observations.push({ source: "Runtime", observation });
        // Authorization denial is a durable, corrective outcome, not
        // successful progress for D2/D4.
        continue;
      }

      const handled = yield* Effect.match(
        controlRegistry.handle({
          action: decodedAction.value.action,
          invocation,
          execution: input.execution,
          context: input.context,
          ...(loopAction === undefined
            ? {}
            : {
                logicalActionId: loopAction.logicalActionId,
                actionContext: {
                  identity: loopAction.identity,
                  actionIndex: loopAction.actionIndex,
                  providerTurnId: preparedTurn.manifest.providerTurnId,
                  callRef: invocation.callRef,
                  contextEpoch: preparedTurn.manifest.contextEpoch,
                },
                ...(loopStepFence === undefined ? {} : { loopStepFence }),
                ...(dependencies.qualificationProbe === undefined
                  ? {}
                  : { qualificationProbe: dependencies.qualificationProbe }),
              }),
          ...(authorization.assignWorkEvidence === undefined
            ? {}
            : { assignWorkEvidence: authorization.assignWorkEvidence }),
          ...(authorization.assignWorkReplay === true
            ? { assignWorkReplay: true }
            : {}),
          ...(authorization.assignWorkCommandReplay === undefined
            ? {}
            : {
                assignWorkCommandReplay: authorization.assignWorkCommandReplay,
              }),
        }),
        {
          onFailure: (cause) => ({ ok: false as const, cause }),
          onSuccess: (outcome) => ({ ok: true as const, outcome }),
        },
      );
      if (!handled.ok) {
        if (handled.cause._tag === "AgentActionRecoveryBlocked") {
          return { _tag: "RecoveryBlocked" };
        }
        if (handled.cause._tag === "AgentActionRejected") {
          const disposition = `ModelUsable:${handled.cause.code}`;
          const observation = actionRejectionObservation(handled.cause);
          const persisted = yield* persistActionObservation(
            "Runtime",
            observation,
            { status: "Failed", disposition },
          );
          if (!persisted) {
            observations.push({ source: "Runtime", observation });
          }
          continue;
        }
        const settlement = safetyStop("ControlActionHandlerRejected");
        yield* persistActionRejection(settlement, "HandlerRejected");
        return {
          _tag: "Settle",
          settlement,
        };
      }
      if (
        authorization.approvalId !== undefined &&
        controlAuthorizer !== undefined
      ) {
        const consumption =
          handled.outcome._tag === "Observation"
            ? handled.outcome.approvalConsumption
            : undefined;
        const expectedRevision = authorization.approvalRevision ?? 0;
        const commandBoundAssignWork =
          decodedAction.value.action._tag === "AssignWork" &&
          authorization.assignWorkEvidence?._tag === "ActionApproval";
        const commandConsumptionMatches =
          consumption !== undefined &&
          consumption.approvalId === authorization.approvalId &&
          consumption.consumedRevision === expectedRevision + 1;
        const consumed =
          commandBoundAssignWork && !commandConsumptionMatches
            ? false
            : yield* controlAuthorizer.consumeApproval({
                approvalId: authorization.approvalId,
                approvalRevision: expectedRevision,
                actionDigest: authorization.actionDigest,
                controlBasisDigest: authorization.controlBasisDigest,
                consumedBy: commandConsumptionMatches
                  ? consumption.commandId
                  : (loopAction?.logicalActionId ??
                    `lac_${sha256Hex(
                      JSON.stringify({
                        executionId: input.execution.executionId,
                        providerTurnId: preparedTurn.manifest.providerTurnId,
                        callRef: invocation.callRef,
                        routeKind: route._tag,
                        actionKind: invocation.toolName,
                      }),
                    )}`),
                ...(commandConsumptionMatches
                  ? { alreadyConsumedByCommandId: consumption.commandId }
                  : {}),
              });
        if (!consumed) {
          const settlement = safetyStop("ControlApprovalConsumptionRejected");
          yield* persistActionRejection(
            settlement,
            "ApprovalConsumptionRejected",
          );
          return { _tag: "Settle", settlement };
        }
      }
      if (handled.outcome._tag === "Settle") {
        yield* persistActionSettlement(
          handled.outcome.settlement,
          handled.outcome.durableSettlementEffect,
        );
        return {
          _tag: "Settle",
          settlement: handled.outcome.settlement,
        };
      }
      if (
        handled.outcome._tag === "Observation" &&
        handled.outcome.durableActionCommit !== undefined
      ) {
        currentLoopStep = handled.outcome.durableActionCommit.loopStep;
        observations.push({
          source: handled.outcome.source,
          observation: handled.outcome.observation,
        });
        durableProgress = true;
        continue;
      }
      if (handled.outcome._tag === "BlockedWorkEpisodeRequest") {
        const blocked = yield* makeBlockedSettlement(
          dependencies,
          handled.outcome.request,
          currentLoopStep,
        );
        if (blocked === null) {
          const observation: BoundedObservation = {
            text: JSON.stringify({
              code: "undispositioned_action_failure",
              message:
                "Blocked requires exact current-Execution TerminalRejected executable actions, a paired Denied result, and a matching pinned manifest. Use a later successful action to recover each denial or provide a valid Blocked disposition.",
            }),
            truncated: false,
          };
          const persisted = yield* persistActionObservation(
            "Runtime",
            observation,
            {
              status: "Failed",
              disposition: "UndispositionedActionFailure",
            },
          );
          if (!persisted) observations.push({ source: "Runtime", observation });
          continue;
        }
        yield* persistActionSettlement(blocked);
        return { _tag: "Settle", settlement: blocked };
      }
      if (
        route._tag === "Control" &&
        loopAction !== undefined &&
        dependencies.qualificationProbe !== undefined
      ) {
        const pendingAction = loopAction;
        yield* Effect.promise(
          () =>
            dependencies.qualificationProbe?.({
              boundary: "AH10AfterControlHandlerReturnBeforeObservationCommit",
              providerTurnId: preparedTurn.manifest.providerTurnId,
              executionId: input.execution.executionId,
              logicalActionId: pendingAction.logicalActionId,
              callRef: invocation.callRef,
              actionIndex,
            }) ?? Promise.resolve(),
        );
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
      durableProgress =
        durableProgress ||
        isDurableSuccessfulActionProgress({
          persistenceCommitted: persisted,
          status: "Succeeded",
        });
    }

    return {
      _tag: "Completed",
      ...(currentLoopStep === undefined ? {} : { loopStep: currentLoopStep }),
      observations,
      durableProgress,
    };
  });
};
