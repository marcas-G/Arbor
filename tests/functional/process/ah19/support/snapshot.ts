import { DatabaseSync } from "node:sqlite";
import type { createFunctionalProject } from "../../../support/public-client.js";

// Shared AH19 test support — moved verbatim from ah19-provider-native-binding-recovery.functional.test.ts (B5 split).

export interface Ah19Snapshot {
  readonly session: { session_id: string; context_epoch: number } | undefined;
  readonly checkpoints: Array<{
    sequence: number;
    item_type: string;
    source_ref: string | null;
    payload_json: string;
    content_hash: string;
  }>;
  readonly providerTurns: Array<{
    provider_turn_id: string;
    execution_id: string;
    session_id: string;
    context_epoch: number;
    manifest_id: string;
    output_contract_ref: string;
    settled_at: string | null;
    finish_reason: string | null;
    manifest_json: string | null;
    portable_request_json: string | null;
  }>;
  readonly providerAttempts: Array<{
    provider_turn_id: string;
    attempt_no: number;
    outcome: string;
    provider_error_kind: string | null;
    settled_at: string | null;
    observation_json: string;
    canonical_event_prefix_json: string;
    delivered_position: number | null;
    continuation_checkpoint_json: string | null;
  }>;
  readonly steps: Array<{
    logical_step_no: number;
    repair_attempt: number;
    provider_turn_id: string;
    state: string;
    next_action_index: number;
    predecessor_logical_step_no: number | null;
    predecessor_repair_attempt: number | null;
    successor_json: string | null;
    settlement_json: string | null;
    next_step_reason: string | null;
    decoded_output_hash: string | null;
    model_output_session_sequence: number | null;
  }>;
  readonly actions: Array<{
    logical_step_no: number;
    repair_attempt: number;
    action_index: number;
    logical_action_id: string;
    call_ref: string;
    action_kind: string;
    state: string;
    revision: number;
    observation_source_ref: string | null;
  }>;
  readonly providerLinks: Array<{
    logical_step_no: number;
    repair_attempt: number;
    overflow_ordinal: number;
    role: string;
    provider_turn_id: string;
    predecessor_provider_turn_id: string | null;
    context_epoch: number;
    state: string;
  }>;
  readonly sessionEntries: Array<{
    sequence: number;
    entry_kind: string;
    item_type: string | null;
    source_kind: string | null;
    source_ref: string | null;
    causal_binding_json: string | null;
    payload_json: string;
  }>;
  readonly execution:
    | {
        execution_id: string;
        settled_at: string | null;
        settlement_kind: string | null;
      }
    | undefined;
  readonly leases: Array<{
    execution_id: string;
    generation: number;
    expires_at: string;
  }>;
  readonly workWait: { work_id: string } | undefined;
  readonly responseJobs: Array<{
    message_id: string;
    state: string;
    response_body: string | null;
    response_execution_id: string | null;
  }>;
}

export const readSnapshot = (
  databaseFile: string,
  input: { sessionId: string; executionId: string; workId: string },
): Ah19Snapshot => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN DEFERRED");
    return {
      session: db
        .prepare(
          "SELECT session_id, context_epoch FROM sessions WHERE session_id = ?",
        )
        .get(input.sessionId) as Ah19Snapshot["session"],
      checkpoints: db
        .prepare(
          `SELECT sequence, item_type, source_ref, payload_json, content_hash
             FROM session_entries WHERE session_id = ?
              AND item_type = 'CompactionCheckpoint' ORDER BY sequence`,
        )
        .all(input.sessionId) as Ah19Snapshot["checkpoints"],
      providerTurns: db
        .prepare(
          `SELECT pt.provider_turn_id, pt.execution_id, pt.session_id,
                  pt.context_epoch, pt.manifest_id, pt.output_contract_ref,
                  pt.settled_at,
                  pt.finish_reason, m.manifest_json, m.portable_request_json
             FROM provider_turns pt
             LEFT JOIN model_context_manifests m
               ON m.provider_turn_id = pt.provider_turn_id
              AND m.manifest_id = pt.manifest_id
            WHERE pt.execution_id = ? ORDER BY pt.provider_turn_id`,
        )
        .all(input.executionId) as Ah19Snapshot["providerTurns"],
      providerAttempts: db
        .prepare(
          `SELECT pa.provider_turn_id, pa.attempt_no, pa.outcome,
                  pa.provider_error_kind, pa.settled_at, pa.observation_json,
                  pa.canonical_event_prefix_json, pa.delivered_position,
                  pa.continuation_checkpoint_json
             FROM provider_attempts pa JOIN provider_turns pt
               ON pt.provider_turn_id = pa.provider_turn_id
            WHERE pt.execution_id = ?
            ORDER BY pa.provider_turn_id, pa.attempt_no`,
        )
        .all(input.executionId) as Ah19Snapshot["providerAttempts"],
      steps: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, provider_turn_id, state,
                  next_action_index,
                  predecessor_logical_step_no, predecessor_repair_attempt,
                  successor_json, settlement_json, next_step_reason,
                  decoded_output_hash,
                  model_output_session_sequence
             FROM agent_loop_steps WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt`,
        )
        .all(input.executionId) as Ah19Snapshot["steps"],
      actions: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, action_index,
                  logical_action_id, call_ref, action_kind, state, revision,
                  observation_source_ref
             FROM agent_loop_step_actions WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt, action_index`,
        )
        .all(input.executionId) as Ah19Snapshot["actions"],
      providerLinks: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, overflow_ordinal, role,
                  provider_turn_id, predecessor_provider_turn_id,
                  context_epoch, state
             FROM agent_loop_step_provider_turns WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt, overflow_ordinal, role`,
        )
        .all(input.executionId) as Ah19Snapshot["providerLinks"],
      sessionEntries: db
        .prepare(
          `SELECT sequence, entry_kind, item_type, source_kind, source_ref,
                  causal_binding_json, payload_json
             FROM session_entries WHERE session_id = ? ORDER BY sequence`,
        )
        .all(input.sessionId) as Ah19Snapshot["sessionEntries"],
      execution: db
        .prepare(
          "SELECT execution_id, settled_at, settlement_kind FROM executions WHERE execution_id = ?",
        )
        .get(input.executionId) as Ah19Snapshot["execution"],
      leases: db
        .prepare(
          "SELECT execution_id, generation, expires_at FROM execution_leases WHERE execution_id = ?",
        )
        .all(input.executionId) as Ah19Snapshot["leases"],
      workWait: db
        .prepare("SELECT work_id FROM work_waits WHERE work_id = ?")
        .get(input.workId) as Ah19Snapshot["workWait"],
      responseJobs: db
        .prepare(
          `SELECT message_id, state, response_body, response_execution_id
             FROM conversation_response_jobs
            WHERE active_execution_id = ? OR response_execution_id = ?
            ORDER BY message_id`,
        )
        .all(
          input.executionId,
          input.executionId,
        ) as Ah19Snapshot["responseJobs"],
    };
  } finally {
    db.close();
  }
};

export const readConversationHistoryEvidence = (
  databaseFile: string,
  input: { rootWorkspaceId: string; sessionId: string },
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN DEFERRED");
    return {
      owner: db
        .prepare(
          `SELECT context_epoch, covered_through_created_at,
                  covered_through_message_id, checkpoint_kind, checkpoint_ref,
                  binding_fingerprint, source_manifest_json,
                  producer_execution_id, producer_provider_turn_id
             FROM conversation_checkpoint_owners WHERE root_workspace_id = ?`,
        )
        .get(input.rootWorkspaceId) as
        | {
            context_epoch: number;
            covered_through_created_at: string | null;
            covered_through_message_id: string | null;
            checkpoint_kind: string | null;
            checkpoint_ref: string | null;
            binding_fingerprint: string | null;
            source_manifest_json: string | null;
            producer_execution_id: string | null;
            producer_provider_turn_id: string | null;
          }
        | undefined,
      messages: db
        .prepare(
          `SELECT message_id, body_ref, state, created_at FROM human_messages
            WHERE root_workspace_id = ? ORDER BY created_at, message_id`,
        )
        .all(input.rootWorkspaceId) as Array<{
        message_id: string;
        body_ref: string;
        state: string;
        created_at: string;
      }>,
      jobs: db
        .prepare(
          `SELECT message_id, state, active_execution_id, next_attempt_no,
                  response_body, response_execution_id, revision
             FROM conversation_response_jobs WHERE root_workspace_id = ?
            ORDER BY created_at, message_id`,
        )
        .all(input.rootWorkspaceId) as Array<{
        message_id: string;
        state: string;
        active_execution_id: string | null;
        next_attempt_no: number;
        response_body: string | null;
        response_execution_id: string | null;
        revision: number;
      }>,
      attempts: db
        .prepare(
          `SELECT message_id, attempt_no, execution_id, settled_at,
                  settlement_kind, retry_decision_json
             FROM conversation_attempts WHERE message_id IN (
               SELECT message_id FROM human_messages WHERE root_workspace_id = ?
             ) ORDER BY message_id, attempt_no`,
        )
        .all(input.rootWorkspaceId) as Array<{
        message_id: string;
        attempt_no: number;
        execution_id: string;
        settled_at: string | null;
        settlement_kind: string | null;
        retry_decision_json: string | null;
      }>,
      executions: db
        .prepare(
          `SELECT execution_id, settled_at, settlement_kind, settlement_json
             FROM executions WHERE execution_id IN (
               SELECT execution_id FROM conversation_attempts WHERE message_id IN (
                 SELECT message_id FROM human_messages WHERE root_workspace_id = ?
               )
             ) ORDER BY admitted_at, execution_id`,
        )
        .all(input.rootWorkspaceId) as Array<{
        execution_id: string;
        settled_at: string | null;
        settlement_kind: string | null;
        settlement_json: string | null;
      }>,
      assistantEntries: db
        .prepare(
          `SELECT sequence, source_ref, payload_json FROM session_entries
            WHERE session_id = ? AND item_type = 'AssistantMessage'
            ORDER BY sequence`,
        )
        .all(input.sessionId) as Array<{
        sequence: number;
        source_ref: string | null;
        payload_json: string;
      }>,
    };
  } finally {
    db.close();
  }
};

export const readTypedSessionRows = (
  databaseFile: string,
  sessionId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN DEFERRED");
    return db
      .prepare(
        `SELECT sequence, item_type, source_kind, source_ref,
                causal_binding_json, payload_json
           FROM session_entries
          WHERE session_id = ? AND schema_version = 2
          ORDER BY sequence`,
      )
      .all(sessionId) as Array<{
      sequence: number;
      item_type: string;
      source_kind: string | null;
      source_ref: string | null;
      causal_binding_json: string | null;
      payload_json: string;
    }>;
  } finally {
    db.close();
  }
};

export const readToolCallOwners = (
  databaseFile: string,
  sessionId: string,
  callRefs: ReadonlyArray<string>,
) => {
  if (callRefs.length === 0) return [];
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const placeholders = callRefs.map(() => "?").join(",");
    return db
      .prepare(
        `SELECT json_extract(se.payload_json, '$.callRef') AS call_ref,
                json_extract(se.payload_json, '$.providerTurnId') AS provider_turn_id,
                pt.execution_id,
                json_extract(se.causal_binding_json, '$.workId') AS work_id,
                json_extract(se.causal_binding_json, '$.episodeBinding') AS episode_binding
           FROM session_entries se
           LEFT JOIN provider_turns pt
             ON pt.provider_turn_id =
                json_extract(se.payload_json, '$.providerTurnId')
          WHERE se.session_id = ?
            AND se.item_type = 'ToolCall'
            AND json_extract(se.payload_json, '$.callRef') IN (${placeholders})
          ORDER BY se.sequence`,
      )
      .all(sessionId, ...callRefs) as Array<{
      call_ref: string;
      provider_turn_id: string;
      execution_id: string | null;
      work_id: string | null;
      episode_binding: string | null;
    }>;
  } finally {
    db.close();
  }
};

export const readAllWorkTimelineRows = (
  databaseFile: string,
  sessionId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT sequence, item_type, source_kind, source_ref, payload_json
           FROM session_entries
          WHERE session_id = ? AND schema_version = 2
          ORDER BY sequence`,
      )
      .all(sessionId) as Array<{
      sequence: number;
      item_type: string;
      source_kind: string | null;
      source_ref: string | null;
      payload_json: string;
    }>;
    const conversationExecutionIds = new Set(
      (
        db
          .prepare(
            `SELECT execution_id FROM executions
              WHERE session_id = ? AND episode_kind = 'ConversationResponseEpisode'`,
          )
          .all(sessionId) as Array<{ execution_id: string }>
      ).map((row) => row.execution_id),
    );
    const conversationProviderTurnIds = new Set<string>();
    for (const executionId of conversationExecutionIds) {
      for (const turn of db
        .prepare(
          "SELECT provider_turn_id FROM provider_turns WHERE execution_id = ? AND session_id = ?",
        )
        .all(executionId, sessionId) as Array<{ provider_turn_id: string }>) {
        conversationProviderTurnIds.add(turn.provider_turn_id);
      }
    }
    return rows.filter((row) => {
      if (
        row.source_kind === "AgentLoopAction" &&
        [...conversationExecutionIds].some((executionId) =>
          row.source_ref?.startsWith(`observation_${executionId}_`),
        )
      ) {
        return false;
      }
      if (
        row.source_kind === "ProviderTurn" ||
        row.source_kind === "ProviderTurnCall" ||
        row.source_kind === "ProviderTurnReasoning" ||
        row.source_kind === "CompactionTurn"
      ) {
        if (
          [...conversationExecutionIds].some((executionId) =>
            row.source_ref?.startsWith(`ptn_${executionId}_`),
          )
        ) {
          return false;
        }
        if (
          [...conversationProviderTurnIds].some(
            (providerTurnId) =>
              row.source_ref === providerTurnId ||
              row.source_ref?.startsWith(`${providerTurnId}:`),
          )
        ) {
          return false;
        }
      }
      return true;
    });
  } finally {
    db.close();
  }
};

/** One coherent, read-only snapshot used only if AH19's public Root Work seed
 * times out. It distinguishes provider/approval admission from later Work,
 * lease, Inbox, and durable workflow-signal progress. */
export const readRootSeedDiagnosticSnapshot = (
  databaseFile: string,
  project: Awaited<ReturnType<typeof createFunctionalProject>>,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN DEFERRED");
    const projectId = project.projectId;
    const workspaceId = project.rootWorkspaceId;
    const sessionId = project.rootSessionId;
    return {
      project: db
        .prepare(
          `SELECT project_id, root_workspace_id, lifecycle, revision
             FROM projects WHERE project_id = ?`,
        )
        .get(projectId),
      workspace: db
        .prepare(
          `SELECT workspace_id, parent_workspace_id, current_work_id,
                  primary_session_id, lifecycle, revision
             FROM workspaces WHERE workspace_id = ?`,
        )
        .get(workspaceId),
      works: db
        .prepare(
          `SELECT work_id, workspace_id, objective, lifecycle, revision,
                  created_at, updated_at
             FROM works WHERE project_id = ? ORDER BY created_at, work_id`,
        )
        .all(projectId),
      executions: db
        .prepare(
          `SELECT execution_id, episode_kind, episode_ref, workspace_id,
                  session_id, admitted_at, settled_at, settlement_kind
             FROM executions WHERE project_id = ?
            ORDER BY admitted_at, execution_id`,
        )
        .all(projectId),
      agentExecutionState: db
        .prepare(
          `SELECT state.execution_id, state.episode_json, state.wake_reason,
                  state.current_mode, state.turn_no, state.updated_at
             FROM agent_execution_state AS state
             JOIN executions AS execution
               ON execution.execution_id = state.execution_id
            WHERE execution.project_id = ?
            ORDER BY execution.admitted_at, state.execution_id`,
        )
        .all(projectId),
      leases: db
        .prepare(
          `SELECT lease.execution_id, lease.worker_id,
                  lease.generation, lease.expires_at
             FROM execution_leases AS lease
             JOIN executions AS execution
               ON execution.execution_id = lease.execution_id
            WHERE execution.project_id = ?
            ORDER BY lease.execution_id`,
        )
        .all(projectId),
      workWaits: db
        .prepare(
          `SELECT wait.work_id, wait.wait_mode, wait.conditions_json,
                  wait.registered_at, wait.updated_at
             FROM work_waits AS wait
             JOIN works AS work ON work.work_id = wait.work_id
            WHERE work.project_id = ? ORDER BY wait.registered_at, wait.work_id`,
        )
        .all(projectId),
      schedulerTimers: db
        .prepare(
          `SELECT timer_id, workspace_id, work_id, kind, fire_at, created_at
             FROM scheduler_timers WHERE workspace_id = ?
            ORDER BY fire_at, timer_id`,
        )
        .all(workspaceId),
      approvals: db
        .prepare(
          `SELECT approval_id, route_kind, project_id, workspace_id,
                  execution_id, stable_action_id, state, revision,
                  requested_at, expires_at, decided_at, consumed_at,
                  binding_proven, source_state
             FROM action_approvals WHERE project_id = ?
            ORDER BY requested_at, approval_id`,
        )
        .all(projectId),
      commandReceipts: db
        .prepare(
          `SELECT command_id, resolution, result_json, terminal_error_json,
                  created_at, settled_at
             FROM commands WHERE project_id = ?
            ORDER BY created_at DESC, command_id DESC LIMIT 40`,
        )
        .all(projectId),
      commandAttempts: db
        .prepare(
          `SELECT attempt.command_id, attempt.attempt_no, attempt.outcome,
                  attempt.failure_kind, attempt.started_at,
                  attempt.settled_at
             FROM command_attempts AS attempt
             JOIN commands AS command
               ON command.command_id = attempt.command_id
            WHERE command.project_id = ?
            ORDER BY command.created_at DESC, attempt.attempt_no DESC
            LIMIT 40`,
        )
        .all(projectId),
      inbox: db
        .prepare(
          `SELECT workspace_id, entry_key, kind, summary, correlation_id,
                  admitted_at, consumed_at
             FROM inbox_entries WHERE workspace_id = ?
            ORDER BY admitted_at, entry_key`,
        )
        .all(workspaceId),
      consumerOffsets: db
        .prepare(
          `SELECT consumer_id, project_id, last_sequence, updated_at
             FROM consumer_offsets WHERE project_id = ?
            ORDER BY consumer_id`,
        )
        .all(projectId),
      workflowSignals: {
        consumerOffset: db
          .prepare(
            `SELECT consumer_id, project_id, last_sequence, updated_at
               FROM consumer_offsets
              WHERE consumer_id = 'workflow-signals' AND project_id = ?`,
          )
          .get(projectId),
        events: db
          .prepare(
            `SELECT event_id, sequence, event_type, aggregate_ref,
                    caused_by_command_id, correlation_ref, occurred_at,
                    payload_json
               FROM domain_events
              WHERE project_id = ? AND event_type IN (
                'DependencyDeclared', 'DependencySatisfied',
                'VerificationConcluded', 'MessageSent', 'ExecutionSettled'
              )
              ORDER BY sequence DESC LIMIT 40`,
          )
          .all(projectId),
      },
      latestDomainEvents: db
        .prepare(
          `SELECT event_id, sequence, event_type, aggregate_ref,
                  caused_by_command_id, correlation_ref, occurred_at,
                  payload_json
             FROM domain_events WHERE project_id = ?
            ORDER BY sequence DESC LIMIT 40`,
        )
        .all(projectId),
      eventSequence: db
        .prepare(
          `SELECT project_id, last_sequence FROM project_event_sequences
            WHERE project_id = ?`,
        )
        .get(projectId),
      session: db
        .prepare(
          `SELECT session_id, binding_kind, workspace_id, execution_id,
                  context_epoch, created_at
             FROM sessions WHERE session_id = ?`,
        )
        .get(sessionId),
      sessionEntries: db
        .prepare(
          `SELECT sequence, entry_kind, item_type, source_ref, payload_json
             FROM session_entries WHERE session_id = ?
            ORDER BY sequence DESC LIMIT 40`,
        )
        .all(sessionId),
    };
  } finally {
    db.close();
  }
};

export const readWorkExecutionId = (
  databaseFile: string,
  project: Awaited<ReturnType<typeof createFunctionalProject>>,
  workId: string,
  activeOnly = true,
): string | undefined => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT execution_id FROM executions
          WHERE workspace_id = ? AND episode_kind = 'WorkEpisode'
            AND episode_ref = ?
            ${activeOnly ? "AND settled_at IS NULL" : ""}
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(project.rootWorkspaceId, workId) as
      | { execution_id: string }
      | undefined;
    return row?.execution_id;
  } finally {
    db.close();
  }
};

export const readExecutionIdForProviderTurn = (
  databaseFile: string,
  providerTurnId: string,
): string => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT execution_id FROM provider_turns WHERE provider_turn_id = ?",
      )
      .get(providerTurnId) as { execution_id: string } | undefined;
    if (row === undefined) {
      throw new Error(`AH19 ProviderTurn missing: ${providerTurnId}`);
    }
    return row.execution_id;
  } finally {
    db.close();
  }
};
