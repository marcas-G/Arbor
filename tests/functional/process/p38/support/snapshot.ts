// Shared P38 snapshot reader and row types — moved verbatim from
// p38-executable-approval-public.functional.test.ts (B5 split).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ExecutableApprovalRow {
  readonly approval_id: string;
  readonly execution_id: string;
  readonly project_id: string;
  readonly workspace_id: string;
  readonly subject_ref: string;
  readonly logical_step_no: number;
  readonly repair_attempt: number;
  readonly action_index: number;
  readonly logical_action_id: string;
  readonly call_ref: string;
  readonly tool_invocation_id: string;
  readonly side_effect_semantics: string;
  readonly action_digest: string;
  readonly target_resource_space_ids_json: string;
  readonly expires_at: string;
  readonly state: string;
  readonly revision: number;
  readonly cancelled_at: string | null;
  readonly cancellation_reason: string | null;
  readonly consumed_at: string | null;
  readonly consumed_by: string | null;
}

export interface ApprovalSnapshot {
  readonly execution:
    | {
        readonly stop_requested_at: string | null;
        readonly settlement_kind: string | null;
        readonly settlement_json: string | null;
      }
    | undefined;
  readonly approval: ExecutableApprovalRow | undefined;
  readonly inboxConsumedAt: string | null | undefined;
  readonly approvalEvents: ReadonlyArray<{
    readonly event_type: string;
    readonly payload_json: string;
  }>;
  readonly executionStopEventCount: number;
  readonly step:
    | {
        readonly provider_turn_id: string;
        readonly state: string;
      }
    | undefined;
  readonly action: { readonly state: string } | undefined;
  readonly invocation:
    | {
        readonly invocation_id: string;
        readonly approval_id: string | null;
        readonly effect_admission_state: string;
        readonly settlement_kind: string | null;
        readonly settlement_json: string | null;
      }
    | undefined;
  readonly effectCount: number;
  readonly matchingInvocationCount: number;
  readonly executionApprovalCount: number;
  readonly recoveryBinding:
    | {
        readonly recovery_binding_state: string;
        readonly recovery_binding_sha256: string | null;
        readonly canonical_binding_json: string | null;
        readonly binding_sha256: string | null;
      }
    | undefined;
  readonly attempt0:
    | {
        readonly attempt_no: number;
        readonly admission_state: string;
        readonly admission_source: string;
        readonly admission_time_precision: string;
        readonly binding_sha256: string | null;
      }
    | undefined;
}

export const readApprovalSnapshot = (
  databaseFile: string,
  workspaceDirectory: string,
  approvalId: string,
  effectLog: string,
): ApprovalSnapshot => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const approval = db
      .prepare(
        `SELECT approval_id, execution_id, project_id, workspace_id, subject_ref,
                logical_step_no, repair_attempt, action_index, logical_action_id,
                call_ref, tool_invocation_id, side_effect_semantics, action_digest,
                target_resource_space_ids_json, expires_at, state,
                revision, cancelled_at, cancellation_reason, consumed_at,
                consumed_by
           FROM action_approvals
          WHERE approval_id = ? AND route_kind = 'Executable' AND binding_proven = 1`,
      )
      .get(approvalId) as ExecutableApprovalRow | undefined;
    const step =
      approval === undefined
        ? undefined
        : (db
            .prepare(
              `SELECT provider_turn_id, state FROM agent_loop_steps
                WHERE execution_id = ? AND logical_step_no = ? AND repair_attempt = ?`,
            )
            .get(
              approval.execution_id,
              approval.logical_step_no,
              approval.repair_attempt,
            ) as ApprovalSnapshot["step"]);
    const execution =
      approval === undefined
        ? undefined
        : (db
            .prepare(
              `SELECT stop_requested_at, settlement_kind, settlement_json
                 FROM executions WHERE execution_id = ?`,
            )
            .get(approval.execution_id) as ApprovalSnapshot["execution"]);
    const inboxRow =
      approval === undefined
        ? undefined
        : (db
            .prepare(
              `SELECT consumed_at FROM inbox_entries
                WHERE workspace_id = ? AND entry_key = ?`,
            )
            .get(approval.workspace_id, `eap:${approval.approval_id}:0`) as
            | { readonly consumed_at: string | null }
            | undefined);
    const approvalEvents =
      approval === undefined
        ? []
        : (db
            .prepare(
              `SELECT event_type, payload_json FROM domain_events
                WHERE aggregate_ref = ? ORDER BY sequence`,
            )
            .all(
              approval.approval_id,
            ) as unknown as ApprovalSnapshot["approvalEvents"]);
    const executionStopEventCount =
      approval === undefined
        ? 0
        : Number(
            (
              db
                .prepare(
                  `SELECT COUNT(*) AS count FROM domain_events
                    WHERE aggregate_ref = ? AND event_type = 'ExecutionStopRequested'`,
                )
                .get(approval.execution_id) as { readonly count: number }
            ).count,
          );
    const action =
      approval === undefined
        ? undefined
        : (db
            .prepare(
              `SELECT state FROM agent_loop_step_actions
                WHERE execution_id = ? AND logical_step_no = ? AND repair_attempt = ?
                  AND action_index = ? AND logical_action_id = ? AND route_kind = 'Executable'`,
            )
            .get(
              approval.execution_id,
              approval.logical_step_no,
              approval.repair_attempt,
              approval.action_index,
              approval.logical_action_id,
            ) as ApprovalSnapshot["action"]);
    const invocation =
      approval === undefined
        ? undefined
        : (db
            .prepare(
              `SELECT invocation_id, approval_id, effect_admission_state,
                      settlement_kind, settlement_json FROM tool_invocations
                WHERE execution_id = ? AND invocation_id = ?`,
            )
            .get(approval.execution_id, approval.tool_invocation_id) as
            | ApprovalSnapshot["invocation"]
            | undefined);
    const effectPath = join(workspaceDirectory, effectLog);
    const effectText = existsSync(effectPath)
      ? readFileSync(effectPath, "utf8")
      : "";
    const effectCount = effectText
      .split(/\r?\n/u)
      .filter((line) => line.length > 0).length;
    const matchingInvocationCount =
      approval === undefined
        ? 0
        : Number(
            (
              db
                .prepare(
                  `SELECT COUNT(*) AS count FROM tool_invocations
                    WHERE execution_id = ? AND approval_id = ?`,
                )
                .get(approval.execution_id, approvalId) as {
                readonly count: number;
              }
            ).count,
          );
    const executionApprovalCount =
      approval === undefined
        ? 0
        : Number(
            (
              db
                .prepare(
                  `SELECT COUNT(*) AS count FROM action_approvals
                    WHERE execution_id = ? AND route_kind = 'Executable'
                      AND binding_proven = 1`,
                )
                .get(approval.execution_id) as { readonly count: number }
            ).count,
          );
    const recoveryBinding =
      approval === undefined
        ? undefined
        : (db
            .prepare(
              `SELECT i.recovery_binding_state, i.recovery_binding_sha256,
                      b.canonical_binding_json, b.binding_sha256
                 FROM tool_invocations AS i
                 LEFT JOIN tool_invocation_recovery_bindings AS b
                   ON b.invocation_id = i.invocation_id
                WHERE i.execution_id = ? AND i.invocation_id = ?`,
            )
            .get(approval.execution_id, approval.tool_invocation_id) as
            | ApprovalSnapshot["recoveryBinding"]
            | undefined);
    const attempt0 =
      approval === undefined
        ? undefined
        : (db
            .prepare(
              `SELECT attempt_no, admission_state, admission_source,
                      admission_time_precision, binding_sha256
                 FROM tool_invocation_effect_attempts
                WHERE invocation_id = ? AND attempt_no = 0`,
            )
            .get(approval.tool_invocation_id) as
            | ApprovalSnapshot["attempt0"]
            | undefined);
    return {
      execution,
      approval,
      inboxConsumedAt: inboxRow?.consumed_at,
      approvalEvents,
      executionStopEventCount,
      step,
      action,
      invocation,
      effectCount,
      matchingInvocationCount,
      executionApprovalCount,
      recoveryBinding,
      attempt0,
    };
  } finally {
    db.close();
  }
};
