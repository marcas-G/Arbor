import type { ExecutionSettlement } from "@arbor/domain";
import type { ToolInvocation } from "@arbor/model-context";
import type {
  AgentLoopStepActionRecord,
  AgentLoopStepRecord,
  BoundedObservation,
} from "@arbor/ports";
import { Effect } from "effect";
import { safetyStop, stopRequestedSettlement } from "../agent-loop-policy.js";
import {
  recoveryBindingIdentityFor,
  recoveryBindingPolicyRevisionsFor,
} from "../recovery-binding-source.js";
import { isDurableSuccessfulActionProgress } from "../safety-identity.js";
import {
  actionRejectionObservation,
  isLeaseFencingRejected,
} from "./action-errors.js";
import type { ExecutableActionError } from "./errors.js";
import type { makeActionLedger } from "./ledger.js";
import type {
  AgentLoopActionDependencies,
  AgentLoopActionOutcome,
} from "./types.js";

export type ExecutableActionResult =
  | Exclude<AgentLoopActionOutcome, { readonly _tag: "Completed" }>
  | { readonly _tag: "Continue"; readonly durableProgress: boolean };

/** Dispatch exactly one executable invocation, sharing the orchestrator's ledger. */
export const executeExecutableAction = (
  dependencies: AgentLoopActionDependencies,
  invocation: ToolInvocation,
  actionIndex: number,
  currentLoopStep: AgentLoopStepRecord | undefined,
  loopAction: AgentLoopStepActionRecord | undefined,
  observations: Array<{
    readonly source: "Runtime" | "Tool";
    readonly observation: BoundedObservation;
  }>,
  durableProgress: boolean,
  ledger: ReturnType<typeof makeActionLedger>,
): Effect.Effect<ExecutableActionResult, ExecutableActionError> => {
  const { input, preparedTurn, loopStepFence, executableInvocationHandler } =
    dependencies;
  const {
    persistActionRejection,
    persistActionObservation,
    persistActionSettlement,
    persistTerminalAction,
  } = ledger;

  return Effect.gen(function* () {
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
    const recoveryBindingPolicyRevisions = recoveryBindingPolicyRevisionsFor(
      preparedTurn.manifest.controlBasis,
    );
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
        return yield* Effect.fail(executed.cause.cause);
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
        return { _tag: "Continue", durableProgress };
      }
      const settlement = safetyStop("ExecutableToolInvocationRejected");
      yield* persistActionRejection(settlement, "HandlerRejected", "Denied", {
        _tag: "HandlerRejected",
        routeKind: "Executable",
      });
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
      const disposition = executed.outcome.disposition ?? "ExecutionStopping";
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
    return { _tag: "Continue", durableProgress };
  });
};
