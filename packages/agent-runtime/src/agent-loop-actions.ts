import { providerTurnInferenceId, workEpisode } from "@arbor/domain";
import type {
  AgentLoopStepActionRecord,
  BoundedObservation,
} from "@arbor/ports";
import { sessionCausalBindingForWork, sha256Hex } from "@arbor/ports";
import { Effect, Option } from "effect";
import { actionRejectionObservation } from "./agent-loop-actions/action-errors.js";
import { makeBlockedSettlement } from "./agent-loop-actions/blocked-settlement.js";
import { verifyCommittedStep } from "./agent-loop-actions/committed-step.js";
import type { AgentLoopActionPhaseError } from "./agent-loop-actions/errors.js";
import {
  type ExecutableActionResult,
  executeExecutableAction,
} from "./agent-loop-actions/executable.js";
import { makeActionLedger } from "./agent-loop-actions/ledger.js";
import type {
  AgentLoopActionDependencies,
  AgentLoopActionOutcome,
} from "./agent-loop-actions/types.js";
import {
  MAX_TURNS,
  safetyStop,
  stopRequestedSettlement,
} from "./agent-loop-policy.js";
import { classifyToolRoute } from "./control.js";
import { checkFreshness, requirementForAction } from "./freshness.js";
import {
  agentActionSafetyFingerprint,
  isDurableSuccessfulActionProgress,
} from "./p12-safety-identity.js";

export { makeBlockedSettlement } from "./agent-loop-actions/blocked-settlement.js";
export type {
  ActionLedgerError,
  AgentLoopActionPhaseError,
  BlockedSettlementError,
  CommittedStepVerificationError,
  ExecutableActionError,
} from "./agent-loop-actions/errors.js";
export { foldAgentLoopActionPhaseError } from "./agent-loop-actions/errors.js";
export type {
  AgentLoopActionDependencies,
  AgentLoopActionOutcome,
  ReconciliationEscalationRecorderError,
} from "./agent-loop-actions/types.js";
export {
  recoveryBindingIdentityFor,
  recoveryBindingPolicyRevisionsFor,
} from "./recovery-binding-source.js";
export { verifySandboxUnavailableStepActionResume } from "./sandbox-unavailable-recovery.js";

/**
 * Owns one decoded turn's action phase. This boundary deliberately includes
 * both executable and control routes because they share the same durable
 * action ledger, idempotency rules, freshness admission, and early-settlement
 * semantics. The driver only consumes the resulting progression state.
 */
export const executeAgentLoopActions = (
  dependencies: AgentLoopActionDependencies,
): Effect.Effect<AgentLoopActionOutcome, AgentLoopActionPhaseError> => {
  const {
    input,
    preparedTurn,
    decodedOutput,
    turn,
    loopSteps,
    loopStepFence,
    tx,
    controlRegistry,
    controlAuthorizer,
    recoverExactNotAdmittedAction,
    currentControlBasis,
    admit,
    now,
  } = dependencies;

  return Effect.gen(function* () {
    const sandboxUnavailableFacts = Option.fromUndefinedOr(
      dependencies.sandboxUnavailableFacts,
    );
    const sandboxPolicyDecisions = Option.fromUndefinedOr(
      dependencies.sandboxPolicyDecisions,
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
        const existingActions = yield* tx.transact(
          loopSteps.listActions(currentLoopStep.identity),
        );
        loopAction = existingActions.find(
          (candidate) => candidate.actionIndex === actionIndex,
        );
        if (loopAction === undefined) {
          loopAction = yield* tx.transact(
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
          );
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

      const ledger = makeActionLedger(
        dependencies,
        {
          get currentLoopStep() {
            return currentLoopStep;
          },
          set currentLoopStep(value) {
            currentLoopStep = value;
          },
          get loopAction() {
            return loopAction;
          },
          set loopAction(value) {
            loopAction = value;
          },
        },
        invocation,
        actionIndex,
        route,
        causalBinding,
      );
      const {
        appendTerminalResult,
        persistActionSettlement,
        persistActionRejection,
        persistActionObservation,
      } = ledger;

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
        const result: ExecutableActionResult = yield* executeExecutableAction(
          dependencies,
          invocation,
          actionIndex,
          currentLoopStep,
          loopAction,
          observations,
          durableProgress,
          ledger,
        );
        if (result._tag !== "Continue") return result;
        durableProgress = result.durableProgress;
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
          yield* tx.transact(
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
          );
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
