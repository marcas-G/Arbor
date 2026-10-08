import { DatabaseSync } from "node:sqlite";

/** Read-only AH qualification oracle. Ordinary release journeys continue to
 * judge success through public views/browser; crash tests inspect the durable
 * ledger only to prove the exact side of a transaction they killed. */
export const durableSnapshot = (databaseFile: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      executions: db
        .prepare(
          "SELECT execution_id, stop_requested_at, settled_at, settlement_kind, settlement_json FROM executions",
        )
        .all(),
      leases: db
        .prepare(
          "SELECT execution_id, generation, expires_at FROM execution_leases",
        )
        .all(),
      steps: db
        .prepare(
          "SELECT execution_id, logical_step_no, provider_turn_id, repair_attempt, state, revision, next_action_index, successor_json, next_step_reason, decoder_version, decoded_output_hash, model_output_session_sequence FROM agent_loop_steps ORDER BY execution_id, logical_step_no, repair_attempt",
        )
        .all(),
      actions: db
        .prepare(
          "SELECT execution_id, logical_step_no, repair_attempt, action_index, logical_action_id, call_ref, route_kind, action_kind, input_hash, state, result_ref, disposition_json, observation_source_ref, revision FROM agent_loop_step_actions ORDER BY execution_id, logical_step_no, repair_attempt, action_index",
        )
        .all(),
      works: db
        .prepare(
          "SELECT work_id, workspace_id, lifecycle, revision FROM works ORDER BY work_id",
        )
        .all(),
      toolInvocations: db
        .prepare(
          "SELECT invocation_id, execution_id, tool_name, side_effect_semantics, settled_at, settlement_kind, settlement_json, result_ref FROM tool_invocations ORDER BY invocation_id",
        )
        .all(),
      toolResults: db
        .prepare(
          "SELECT sequence, payload_json, source_kind, source_ref FROM session_entries WHERE item_type = 'ToolResult' ORDER BY sequence",
        )
        .all(),
      artifacts: db
        .prepare(
          "SELECT artifact_id, invocation_id, content_hash FROM artifacts ORDER BY artifact_id",
        )
        .all(),
      providerTurns: db
        .prepare(
          "SELECT provider_turn_id, settled_at, finish_reason FROM provider_turns",
        )
        .all(),
      attempts: db
        .prepare(
          "SELECT provider_turn_id, attempt_no, outcome, settled_at, success_evidence_version FROM provider_attempts",
        )
        .all(),
      outputs: db
        .prepare(
          "SELECT source_ref FROM session_entries WHERE entry_kind = 'ModelOutput'",
        )
        .all(),
      events: db
        .prepare("SELECT event_type, aggregate_ref FROM domain_events")
        .all(),
      timers: db.prepare("SELECT * FROM scheduler_timers").all(),
    };
  } finally {
    db.close();
  }
};
