// REAL S4 durable binding readers (B5 split): Executable approval binding,
// WorkEpisode execution binding and settled shell invocation oracles read
// directly from the private SQLite fixture database. Bodies are moved
// verbatim from the former monolithic public-s4-recovery.test.ts.
import { DatabaseSync } from "node:sqlite";

interface ApprovalBinding {
  readonly approvalId: string;
  readonly routeKind: string;
  readonly executionId: string;
  readonly workId: string;
  readonly episodeKind: string;
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
  readonly actionIndex: number;
  readonly logicalActionId: string;
  readonly callRef: string;
  readonly toolInvocationId: string;
  readonly approvalState: string;
  readonly approvalRevision: number;
  readonly toolName: string;
  readonly sideEffectSemantics: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly targetResourceSpaceIds: ReadonlyArray<string>;
  readonly stepState: string;
  readonly actionState: string;
  readonly invocationCount: number;
}

const readPendingApprovalBinding = (
  databaseFile: string,
  approvalId: string,
): ApprovalBinding => {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT a.approval_id, a.route_kind, a.execution_id,
                e.episode_kind, e.episode_ref AS work_id,
                a.logical_step_no, a.repair_attempt, a.action_index,
                a.logical_action_id, a.call_ref, a.tool_invocation_id,
                a.stable_action_id, a.side_effect_semantics,
                a.arguments_json, a.target_resource_space_ids_json,
                a.state AS approval_state, a.revision AS approval_revision,
                s.state AS step_state, x.state AS action_state,
                (SELECT COUNT(*) FROM tool_invocations i
                  WHERE i.invocation_id = a.tool_invocation_id) AS invocation_count
           FROM action_approvals a
           JOIN executions e ON e.execution_id = a.execution_id
           JOIN agent_loop_steps s ON s.execution_id = a.execution_id
             AND s.logical_step_no = a.logical_step_no
             AND s.repair_attempt = a.repair_attempt
           JOIN agent_loop_step_actions x ON x.execution_id = a.execution_id
             AND x.logical_step_no = a.logical_step_no
             AND x.repair_attempt = a.repair_attempt
             AND x.action_index = a.action_index
             AND x.logical_action_id = a.logical_action_id
          WHERE a.approval_id = ? AND e.episode_kind = 'WorkEpisode'
            AND a.route_kind = 'Executable'
            AND a.binding_proven = 1`,
      )
      .get(approvalId) as
      | {
          approval_id: string;
          route_kind: string;
          execution_id: string;
          episode_kind: string;
          work_id: string;
          logical_step_no: number;
          repair_attempt: number;
          action_index: number;
          logical_action_id: string;
          call_ref: string;
          tool_invocation_id: string;
          stable_action_id: string;
          side_effect_semantics: string;
          arguments_json: string;
          target_resource_space_ids_json: string;
          approval_state: string;
          approval_revision: number;
          step_state: string;
          action_state: string;
          invocation_count: number;
        }
      | undefined;
    if (row === undefined)
      throw new Error("public approval has no exact durable binding");
    const binding: ApprovalBinding = {
      approvalId: row.approval_id,
      routeKind: row.route_kind,
      executionId: row.execution_id,
      episodeKind: row.episode_kind,
      workId: row.work_id,
      logicalStepNo: row.logical_step_no,
      repairAttempt: row.repair_attempt,
      actionIndex: row.action_index,
      logicalActionId: row.logical_action_id,
      callRef: row.call_ref,
      toolInvocationId: row.tool_invocation_id,
      approvalState: row.approval_state,
      approvalRevision: row.approval_revision,
      toolName: row.stable_action_id,
      sideEffectSemantics: row.side_effect_semantics,
      arguments: JSON.parse(row.arguments_json) as Record<string, unknown>,
      targetResourceSpaceIds: JSON.parse(
        row.target_resource_space_ids_json,
      ) as ReadonlyArray<string>,
      stepState: row.step_state,
      actionState: row.action_state,
      invocationCount: row.invocation_count,
    };
    if (
      binding.approvalState !== "Pending" ||
      binding.approvalRevision !== 0 ||
      binding.invocationCount !== 0
    ) {
      throw new Error(
        "Executable approval was not pending before effect admission",
      );
    }
    return binding;
  } finally {
    database.close();
  }
};

const readWorkEpisodeBinding = (databaseFile: string, executionId: string) => {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT execution_id, project_id, workspace_id, episode_kind,
                episode_ref, episode_revision, session_id
           FROM executions WHERE execution_id = ?`,
      )
      .get(executionId) as
      | {
          execution_id: string;
          project_id: string;
          workspace_id: string;
          episode_kind: string | null;
          episode_ref: string | null;
          episode_revision: number;
          session_id: string;
        }
      | undefined;
  } finally {
    database.close();
  }
};

const readSuccessfulShellInvocation = (input: {
  readonly databaseFile: string;
  readonly executionId: string;
  readonly approvalId: string;
  readonly toolInvocationId: string;
  readonly callRef: string;
}) => {
  const database = new DatabaseSync(input.databaseFile, { readOnly: true });
  database.exec("BEGIN");
  try {
    const invocationRows = database
      .prepare(
        `SELECT invocation_id, execution_id, tool_name, side_effect_semantics,
                approval_id, effect_admission_state, settlement_kind,
                settled_at, observation_json, result_ref
           FROM tool_invocations
          WHERE invocation_id = ? AND execution_id = ?`,
      )
      .all(input.toolInvocationId, input.executionId) as Array<{
      invocation_id: string;
      execution_id: string;
      tool_name: string;
      side_effect_semantics: string;
      approval_id: string | null;
      effect_admission_state: string;
      settlement_kind: string | null;
      settled_at: string | null;
      observation_json: string | null;
      result_ref: string | null;
    }>;
    const executionInvocations = database
      .prepare(
        `SELECT invocation_id, tool_name, approval_id, settlement_kind
           FROM tool_invocations WHERE execution_id = ?
          ORDER BY intent_at, invocation_id`,
      )
      .all(input.executionId) as Array<{
      invocation_id: string;
      tool_name: string;
      approval_id: string | null;
      settlement_kind: string | null;
    }>;
    const effectAttempts = database
      .prepare(
        `SELECT attempt_no, admission_state FROM tool_invocation_effect_attempts
          WHERE invocation_id = ? ORDER BY attempt_no`,
      )
      .all(input.toolInvocationId) as Array<{
      attempt_no: number;
      admission_state: string;
    }>;
    const approvalRows = database
      .prepare(
        `SELECT approval_id, route_kind, execution_id, state, revision,
                consumed_by, tool_invocation_id
           FROM action_approvals WHERE approval_id = ?`,
      )
      .all(input.approvalId) as Array<{
      approval_id: string;
      route_kind: string;
      execution_id: string;
      state: string;
      revision: number;
      consumed_by: string | null;
      tool_invocation_id: string;
    }>;
    const sessionIdRow = database
      .prepare("SELECT session_id FROM executions WHERE execution_id = ?")
      .get(input.executionId) as { session_id: string } | undefined;
    if (sessionIdRow === undefined) {
      throw new Error("approved Work Execution has no Session");
    }
    const toolResults = database
      .prepare(
        `SELECT sequence, payload_json FROM session_entries
          WHERE session_id = ? AND item_type = 'ToolResult'
          ORDER BY sequence`,
      )
      .all(sessionIdRow.session_id) as Array<{
      sequence: number;
      payload_json: string;
    }>;
    const exactToolResults = toolResults.filter((row) => {
      try {
        const payload = JSON.parse(row.payload_json) as {
          invocationId?: unknown;
          callRef?: unknown;
        };
        return (
          payload.invocationId === input.toolInvocationId &&
          payload.callRef === input.callRef
        );
      } catch {
        return false;
      }
    });
    const approvalsForInvocation = database
      .prepare(
        `SELECT approval_id FROM action_approvals
          WHERE execution_id = ? AND route_kind = 'Executable'
            AND binding_proven = 1 AND tool_invocation_id = ?`,
      )
      .all(input.executionId, input.toolInvocationId) as Array<{
      approval_id: string;
    }>;
    const executionApprovals = database
      .prepare(
        `SELECT approval_id, state, tool_invocation_id
           FROM action_approvals
          WHERE execution_id = ? AND route_kind = 'Executable'
            AND binding_proven = 1
          ORDER BY requested_at, approval_id`,
      )
      .all(input.executionId) as Array<{
      approval_id: string;
      state: string;
      tool_invocation_id: string;
    }>;
    return {
      invocationRows,
      executionInvocations,
      effectAttempts,
      approvalRows,
      approvalsForInvocation,
      executionApprovals,
      executionToolResultCount: toolResults.length,
      exactToolResults,
    };
  } finally {
    try {
      database.exec("ROLLBACK");
    } finally {
      database.close();
    }
  }
};

export type { ApprovalBinding };
export {
  readPendingApprovalBinding,
  readSuccessfulShellInvocation,
  readWorkEpisodeBinding,
};
