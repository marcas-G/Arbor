import { durableSnapshot } from "../../support/ah-durable-snapshot.js";
import { waitForPublic } from "../../support/public-client.js";
import type { Ah7CrashContext, Ah7RecoveredContext } from "./start-fixture.js";
import {
  isToolResultFor,
  readP4InvocationApprovalBinding,
  readReconciliationFacts,
} from "./support.js";

export const convergeAh7Recovery = async (
  ctx: Ah7CrashContext,
): Promise<Ah7RecoveredContext> => {
  const {
    fixture,
    hit,
    targetExecutionId,
    targetInvocationId,
    originalProviderTurnId,
    crashedSourceStep,
  } = ctx;
  const {
    noEffectRetryDenied,
    resumesUnadmittedIntent,
    profileDrift,
    mismatchedProofIsUnknown,
    reconciliationMode,
    reconciliationDrift,
    resourceChangeDuringReconcile,
  } = ctx.flags;
  let recovered: ReturnType<typeof durableSnapshot>;
  try {
    if (noEffectRetryDenied) {
      await waitForPublic(
        async () =>
          readP4InvocationApprovalBinding(
            fixture.databaseFile,
            targetExecutionId,
            targetInvocationId,
          ),
        (value) => value?.settlement_kind === "ReconciledNoEffect",
        reconciliationDrift === undefined ? 45_000 : 90_000,
      );
      recovered = await waitForPublic(
        async () => durableSnapshot(fixture.databaseFile),
        (value) =>
          value.toolInvocations.some(
            (invocation) =>
              invocation.invocation_id === hit?.invocationId &&
              invocation.settlement_kind === "ReconciledNoEffect",
          ) &&
          value.actions.some(
            (action) =>
              action.execution_id === targetExecutionId &&
              action.call_ref === hit?.callRef &&
              action.state === "TerminalRejected",
          ) &&
          value.toolResults.some((row) =>
            isToolResultFor(row, hit?.invocationId ?? "", hit?.callRef ?? ""),
          ) &&
          value.steps.some(
            (step) =>
              step.execution_id === targetExecutionId &&
              step.logical_step_no === 0 &&
              step.repair_attempt === 0 &&
              step.next_action_index === 1,
          ),
        reconciliationDrift === undefined ? 45_000 : 90_000,
      );
    } else {
      recovered = await waitForPublic(
        async () => durableSnapshot(fixture.databaseFile),
        (value) => {
          if (resumesUnadmittedIntent) {
            const successorStep = value.steps.find(
              (step) =>
                step.execution_id === targetExecutionId &&
                step.logical_step_no ===
                  Number(crashedSourceStep?.logical_step_no ?? -1) + 1,
            );
            return (
              value.actions.some(
                (action) =>
                  action.execution_id === targetExecutionId &&
                  action.call_ref === hit?.callRef &&
                  action.state ===
                    (resourceChangeDuringReconcile
                      ? "TerminalRejected"
                      : "Applied"),
              ) &&
              value.toolInvocations.some(
                (invocation) =>
                  invocation.invocation_id === hit?.invocationId &&
                  invocation.execution_id === targetExecutionId &&
                  invocation.settlement_kind === "Success",
              ) &&
              value.toolResults.some((row) =>
                isToolResultFor(
                  row,
                  hit?.invocationId ?? "",
                  hit?.callRef ?? "",
                ),
              ) &&
              successorStep !== undefined &&
              successorStep.provider_turn_id !== originalProviderTurnId &&
              value.providerTurns.some(
                (turn) =>
                  turn.provider_turn_id === successorStep.provider_turn_id &&
                  turn.settled_at !== null,
              ) &&
              value.outputs.filter(
                (output) =>
                  output.source_ref ===
                  `${successorStep.provider_turn_id}:assistant`,
              ).length === 1
            );
          }
          if (profileDrift !== undefined) {
            return (
              value.actions.some(
                (action) =>
                  action.execution_id === targetExecutionId &&
                  action.call_ref === hit?.callRef &&
                  action.state === "ReconciliationPending",
              ) &&
              value.executions.some(
                (execution) =>
                  execution.execution_id === targetExecutionId &&
                  execution.settlement_kind === "OutcomeUnknown",
              )
            );
          }
          if (mismatchedProofIsUnknown) {
            return value.actions.some(
              (action) =>
                action.execution_id === targetExecutionId &&
                action.call_ref === hit?.callRef &&
                action.state === "ReconciliationPending",
            );
          }
          if (
            reconciliationMode === "NotOccurred" ||
            reconciliationMode === "Occurred"
          ) {
            if (noEffectRetryDenied) {
              return (
                value.toolInvocations.some(
                  (invocation) =>
                    invocation.invocation_id === hit?.invocationId &&
                    invocation.settlement_kind === "ReconciledNoEffect",
                ) &&
                value.actions.some(
                  (action) =>
                    action.execution_id === targetExecutionId &&
                    action.call_ref === hit?.callRef &&
                    action.state === "TerminalRejected",
                ) &&
                value.toolResults.some((row) =>
                  isToolResultFor(
                    row,
                    hit?.invocationId ?? "",
                    hit?.callRef ?? "",
                  ),
                ) &&
                value.steps.some(
                  (step) =>
                    step.execution_id === targetExecutionId &&
                    step.logical_step_no === 0 &&
                    step.repair_attempt === 0 &&
                    step.next_action_index === 1,
                )
              );
            }
            return (
              value.actions.some(
                (action) =>
                  action.execution_id === targetExecutionId &&
                  action.call_ref === hit?.callRef &&
                  action.state === "Applied",
              ) &&
              value.toolInvocations.some(
                (invocation) =>
                  invocation.invocation_id === hit?.invocationId &&
                  invocation.settlement_kind ===
                    (noEffectRetryDenied ? "ReconciledNoEffect" : "Success"),
              ) &&
              value.toolResults.some((row) =>
                isToolResultFor(
                  row,
                  hit?.invocationId ?? "",
                  hit?.callRef ?? "",
                ),
              )
            );
          }
          return (
            value.actions.some(
              (action) =>
                action.execution_id === targetExecutionId &&
                action.call_ref === hit?.callRef &&
                action.state === "ReconciliationPending",
            ) &&
            value.executions.some(
              (execution) =>
                execution.execution_id === targetExecutionId &&
                execution.settlement_kind === "OutcomeUnknown",
            )
          );
        },
        45_000,
      );
    }
  } catch (error) {
    if (!noEffectRetryDenied) throw error;
    throw new Error(
      `NotOccurred retry-denial recovery did not settle: ${error instanceof Error ? error.message : String(error)}; invocation=${JSON.stringify(readP4InvocationApprovalBinding(fixture.databaseFile, targetExecutionId, hit.invocationId))}; facts=${JSON.stringify(readReconciliationFacts(fixture.databaseFile, hit.invocationId))}; runtimeProbes=${JSON.stringify(ctx.runtimeProbeEvents.filter((event) => event.invocationId === hit.invocationId).map((event) => ({ boundary: event.boundary, outcomeTag: event.outcomeTag, admissionResult: event.admissionResult })))}; daemon=${fixture.daemonErrors.join(" | ")}`,
    );
  }

  return Object.assign(ctx, { recovered });
};
