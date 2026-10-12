import type {
  SubmittedDecisionBindingAttentionFact,
  SubmittedDecisionBindingFailureCode,
} from "@arbor/ports";

export interface SubmittedDecisionBindingAttentionDbRow {
  readonly attention_fact_id: unknown;
  readonly event_id: unknown;
  readonly project_id: unknown;
  readonly execution_id: unknown;
  readonly workspace_id: unknown;
  readonly logical_step_no: unknown;
  readonly repair_attempt: unknown;
  readonly provider_turn_id: unknown;
  readonly logical_action_id: unknown;
  readonly failure_code: unknown;
  readonly first_detected_at: unknown;
}

const failureCodes = [
  "DecisionRequestWorkspaceMismatch",
  "StepManifestMismatch",
  "SettledExecutionWithPendingDecisionAction",
] as const satisfies ReadonlyArray<SubmittedDecisionBindingFailureCode>;

export const decodeSubmittedDecisionBindingFailureCode = (
  value: unknown,
): SubmittedDecisionBindingFailureCode | undefined =>
  typeof value === "string" &&
  failureCodes.includes(value as SubmittedDecisionBindingFailureCode)
    ? (value as SubmittedDecisionBindingFailureCode)
    : undefined;

const isNonnegativeSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const isString = (value: unknown): value is string => typeof value === "string";

/** Decode SQLite rows without trusting query result casts. */
export const decodeSubmittedDecisionBindingAttentionFactRow = (
  row: SubmittedDecisionBindingAttentionDbRow,
): SubmittedDecisionBindingAttentionFact | undefined => {
  const failureCode = decodeSubmittedDecisionBindingFailureCode(
    row.failure_code,
  );
  if (
    failureCode === undefined ||
    !isString(row.attention_fact_id) ||
    !isString(row.event_id) ||
    !isString(row.project_id) ||
    !isString(row.execution_id) ||
    !isString(row.workspace_id) ||
    !isNonnegativeSafeInteger(row.logical_step_no) ||
    !isNonnegativeSafeInteger(row.repair_attempt) ||
    !isString(row.provider_turn_id) ||
    !isString(row.logical_action_id) ||
    !isString(row.first_detected_at)
  ) {
    return undefined;
  }
  return {
    attentionFactId: row.attention_fact_id,
    eventId: row.event_id,
    projectId: row.project_id as never,
    executionId: row.execution_id as never,
    workspaceId: row.workspace_id as never,
    logicalStepNo: row.logical_step_no,
    repairAttempt: row.repair_attempt,
    providerTurnId: row.provider_turn_id as never,
    logicalActionId: row.logical_action_id,
    failureCode,
    firstDetectedAt: row.first_detected_at,
  };
};
