import { DatabaseSync } from "node:sqlite";

interface CommandRow {
  readonly command_id: string;
  readonly resolution: "Committed" | "TerminalRejected";
  readonly result_json: string | null;
  readonly terminal_error_json: string | null;
}

interface WorkRow {
  readonly work_id: string;
  readonly project_id: string;
  readonly workspace_id: string;
  readonly objective: string;
  readonly why: string;
  readonly constraints: string;
  readonly completion_expectation: string;
  readonly verification_mission: string;
  readonly provenance: string;
  readonly lifecycle: string;
  readonly revision: number;
}

interface WorkspaceLifecycleRow {
  readonly workspace_id: string;
  readonly lifecycle: string;
}

interface WorkAssignedEventRow {
  readonly event_id: string;
  readonly event_type: string;
  readonly aggregate_ref: string;
  readonly caused_by_command_id: string | null;
  readonly payload_json: string;
}

interface BindingRow {
  readonly command_id: string;
  readonly execution_id: string;
  readonly provider_turn_id: string;
  readonly logical_action_id: string;
  readonly call_ref: string;
  readonly parent_workspace_id: string;
  readonly parent_work_id: string;
  readonly target_workspace_ref: string;
  readonly target_workspace_id: string;
  readonly work_id: string;
  readonly authority_kind: string;
  readonly authority_evidence_json: string;
}

interface BindingAttentionRow {
  readonly attention_fact_id: string;
  readonly event_id: string;
  readonly execution_id: string;
  readonly target_workspace_id: string;
  readonly logical_action_id: string;
  readonly committed_command_id: string;
  readonly failure_code: string;
}

interface BindingAttentionEventRow {
  readonly event_id: string;
  readonly project_id: string;
  readonly aggregate_ref: string;
  readonly caused_by_command_id: string | null;
  readonly correlation_ref: string | null;
  readonly payload_json: string;
}

export interface ControlResult {
  readonly _tag?: string;
  readonly actionKind?: string;
  readonly callRef?: string;
  readonly status?: string;
  readonly outputText?: string;
}

export const readRows = (databaseFile: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      schemaVersion: Number(
        (db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version,
      ),
      leases: db
        .prepare(
          `SELECT execution_id, worker_id, worker_incarnation_id, generation,
                  expires_at FROM execution_leases`,
        )
        .all() as Array<{
        execution_id: string;
        worker_id: string;
        worker_incarnation_id: string;
        generation: number;
        expires_at: string;
      }>,
      commands: db
        .prepare(
          "SELECT command_id, resolution, result_json, terminal_error_json FROM commands",
        )
        .all() as unknown as CommandRow[],
      works: db
        .prepare(
          `SELECT work_id, project_id, workspace_id, objective, why,
                  constraints, completion_expectation, verification_mission,
                  provenance, lifecycle, revision
             FROM works ORDER BY created_at, work_id`,
        )
        .all() as unknown as WorkRow[],
      workspaceLifecycles: db
        .prepare(
          "SELECT workspace_id, lifecycle FROM workspaces ORDER BY workspace_id",
        )
        .all() as unknown as WorkspaceLifecycleRow[],
      workAssignedEvents: db
        .prepare(
          `SELECT event_id, event_type, aggregate_ref, caused_by_command_id,
                  payload_json
             FROM domain_events WHERE event_type = 'WorkAssigned'
            ORDER BY sequence`,
        )
        .all() as unknown as WorkAssignedEventRow[],
      assignWorkTargetBindings: db
        .prepare(
          `SELECT command_id, execution_id, provider_turn_id, logical_action_id,
                  call_ref, parent_workspace_id, parent_work_id,
                  target_workspace_ref, target_workspace_id, work_id,
                  authority_kind, authority_evidence_json
             FROM assign_work_target_bindings ORDER BY command_id`,
        )
        .all() as unknown as BindingRow[],
      bindingAttentionFacts: db
        .prepare(
          `SELECT attention_fact_id, event_id, execution_id, target_workspace_id,
                  logical_action_id, committed_command_id, failure_code
             FROM assign_work_binding_attention_facts ORDER BY attention_fact_id`,
        )
        .all() as unknown as BindingAttentionRow[],
      bindingAttentionEvents: db
        .prepare(
          `SELECT event_id, project_id, aggregate_ref, caused_by_command_id,
                  correlation_ref, payload_json
             FROM domain_events
            WHERE event_type = 'AssignWorkTargetBindingEscalated'
            ORDER BY sequence`,
        )
        .all() as unknown as BindingAttentionEventRow[],
      actions: db
        .prepare(
          `SELECT a.execution_id, s.provider_turn_id, a.logical_step_no,
                  a.repair_attempt, a.logical_action_id, a.action_index,
                  a.observation_source_ref, a.call_ref, a.action_kind, a.state
             FROM agent_loop_step_actions a
             JOIN agent_loop_steps s
               ON s.execution_id = a.execution_id
              AND s.logical_step_no = a.logical_step_no
              AND s.repair_attempt = a.repair_attempt
            ORDER BY a.action_index`,
        )
        .all() as Array<{
        execution_id: string;
        provider_turn_id: string;
        logical_step_no: number;
        repair_attempt: number;
        logical_action_id: string;
        action_index: number;
        observation_source_ref: string | null;
        call_ref: string;
        action_kind: string;
        state: string;
      }>,
      observations: db
        .prepare(
          `SELECT source_ref FROM session_entries
            WHERE source_kind = 'AgentLoopAction'
              AND entry_kind = 'Observation' ORDER BY sequence`,
        )
        .all() as Array<{ source_ref: string }>,
      controlResults: db
        .prepare(
          `SELECT source_ref, payload_json
             FROM session_entries WHERE item_type = 'ControlResult'
            ORDER BY sequence`,
        )
        .all() as Array<{ source_ref: string; payload_json: string }>,
      providerAttempts: db
        .prepare(
          `SELECT provider_turn_id, attempt_no, outcome, settled_at
             FROM provider_attempts ORDER BY provider_turn_id, attempt_no`,
        )
        .all() as Array<{
        provider_turn_id: string;
        attempt_no: number;
        outcome: string;
        settled_at: string | null;
      }>,
      permissionGrants: db
        .prepare(
          `SELECT permission_grant_id, subject_kind, subject_ref, capability,
                  target, state, expires_at
             FROM permission_grants ORDER BY permission_grant_id`,
        )
        .all() as Array<{
        permission_grant_id: string;
        subject_kind: string;
        subject_ref: string;
        capability: string;
        target: string | null;
        state: string;
        expires_at: string | null;
      }>,
      approvals: db
        .prepare(
          "SELECT approval_id, target_ref, state, revision, consumed_by, binding_proven FROM action_approvals ORDER BY approval_id",
        )
        .all() as Array<{
        approval_id: string;
        target_ref: string;
        state: string;
        revision: number;
        consumed_by: string | null;
        binding_proven: number;
      }>,
    };
  } finally {
    db.close();
  }
};

export const fencedReceipts = (rows: ReturnType<typeof readRows>) =>
  rows.commands.filter(
    (command) =>
      command.resolution === "TerminalRejected" &&
      command.terminal_error_json?.includes("FencingRejected"),
  );

export const targetWorks = (
  rows: ReturnType<typeof readRows>,
  objective: string,
) => rows.works.filter((work) => work.objective === objective);

export const parseWorkspacesResult = (row: { payload_json: string }) => {
  const result = JSON.parse(row.payload_json) as ControlResult;
  if (
    result._tag !== "ControlResult" ||
    result.actionKind !== "list_workspaces" ||
    result.status !== "Succeeded" ||
    typeof result.outputText !== "string"
  ) {
    throw new Error(
      `list_workspaces did not persist a successful ControlResult: ${row.payload_json}`,
    );
  }
  return JSON.parse(result.outputText) as {
    directChildren?: Array<{ ref: string; name: string }>;
  };
};
