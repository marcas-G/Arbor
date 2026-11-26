// Shared AH18 snapshot reader and probe types — moved verbatim from
// ah18-overflow-linked-compaction-resume.functional.test.ts (B5 split).
import { DatabaseSync } from "node:sqlite";

export interface Ah18Probe {
  readonly tag: "AH18_PROBE";
  readonly boundary: string;
  readonly executionId: string;
  readonly providerTurnId: string;
  readonly attemptNo?: number;
  readonly failureKind?: string;
}

export interface Ah4Probe {
  readonly tag: "AH_PROBE";
  readonly boundary: string;
  readonly providerTurnId?: string;
}

export interface ProviderRequest {
  readonly kind: "initial-inference" | "summary" | "replacement-inference";
  readonly messages: ReadonlyArray<{ role?: string; content?: string }>;
  readonly tools: ReadonlyArray<{ function?: { name?: string } }>;
}

export interface SeedProviderRequest {
  readonly kind: "root" | "work";
  readonly messages: ProviderRequest["messages"];
  readonly tools: ProviderRequest["tools"];
}

export interface Ah18Snapshot {
  readonly session: { session_id: string; context_epoch: number } | undefined;
  readonly checkpoints: Array<{
    sequence: number;
    context_epoch: number;
    source_kind: string;
    source_ref: string;
    payload_json: string;
    content_hash: string;
  }>;
  readonly providerTurns: Array<{
    provider_turn_id: string;
    execution_id: string;
    session_id: string;
    context_epoch: number;
    manifest_id: string;
    settled_at: string | null;
    finish_reason: string | null;
    manifest_json: string | null;
    portable_request_json: string | null;
  }>;
  readonly manifests: Array<{
    provider_turn_id: string;
    manifest_id: string;
    execution_id: string;
    context_epoch: number;
    manifest_json: string;
    portable_request_json: string | null;
  }>;
  readonly providerAttempts: Array<{
    provider_turn_id: string;
    attempt_no: number;
    outcome: string;
    provider_error_kind: string | null;
    failure_taxonomy_version: string | null;
    retry_safety: string | null;
    retry_decision: string | null;
    retry_strategy: string | null;
    retry_reason: string | null;
    canonical_event_prefix_json: string;
    delivered_position: number | null;
    settled_at: string | null;
  }>;
  readonly step:
    | {
        execution_id: string;
        logical_step_no: number;
        repair_attempt: number;
        provider_turn_id: string;
        state: string;
        settlement_json: string | null;
      }
    | undefined;
  readonly steps: Array<{
    logical_step_no: number;
    repair_attempt: number;
    state: string;
    settlement_json: string | null;
  }>;
  readonly links: Array<{
    logical_step_no: number;
    repair_attempt: number;
    overflow_ordinal: number;
    role: string;
    provider_turn_id: string;
    predecessor_provider_turn_id: string | null;
    context_epoch: number;
    state: string;
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
  readonly workWait:
    | {
        work_id: string;
        wait_mode: string;
        conditions_json: string;
      }
    | undefined;
  readonly actions: Array<{
    action_index: number;
    action_kind: string;
    state: string;
  }>;
  readonly durableOutputs: Array<{
    item_type: string;
    source_ref: string | null;
  }>;
  readonly work: { work_id: string; lifecycle: string } | undefined;
}

export const readSnapshot = (
  databaseFile: string,
  input: {
    readonly sessionId: string;
    readonly executionId: string;
    readonly workId: string;
  },
): Ah18Snapshot => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN DEFERRED");
    const snapshot: Ah18Snapshot = {
      session: db
        .prepare(
          "SELECT session_id, context_epoch FROM sessions WHERE session_id = ?",
        )
        .get(input.sessionId) as Ah18Snapshot["session"],
      checkpoints: db
        .prepare(
          `SELECT sequence, context_epoch, source_kind, source_ref, payload_json, content_hash
             FROM session_entries
            WHERE session_id = ? AND item_type = 'CompactionCheckpoint'
            ORDER BY sequence`,
        )
        .all(input.sessionId) as Ah18Snapshot["checkpoints"],
      providerTurns: db
        .prepare(
          `SELECT pt.provider_turn_id, pt.execution_id, pt.session_id,
                  pt.context_epoch, pt.manifest_id, pt.settled_at,
                  pt.finish_reason, m.manifest_json, m.portable_request_json
             FROM provider_turns pt
             LEFT JOIN model_context_manifests m
               ON m.provider_turn_id = pt.provider_turn_id
              AND m.manifest_id = pt.manifest_id
            WHERE pt.execution_id = ? ORDER BY pt.provider_turn_id`,
        )
        .all(input.executionId) as Ah18Snapshot["providerTurns"],
      manifests: db
        .prepare(
          `SELECT provider_turn_id, manifest_id, execution_id, context_epoch,
                  manifest_json, portable_request_json
             FROM model_context_manifests WHERE execution_id = ?
            ORDER BY provider_turn_id, manifest_id`,
        )
        .all(input.executionId) as Ah18Snapshot["manifests"],
      providerAttempts: db
        .prepare(
          `SELECT pa.provider_turn_id, pa.attempt_no, pa.outcome,
                  pa.provider_error_kind, pa.failure_taxonomy_version,
                  pa.retry_safety, pa.retry_decision, pa.retry_strategy,
                  pa.retry_reason, pa.canonical_event_prefix_json,
                  pa.delivered_position, pa.settled_at
             FROM provider_attempts pa
             JOIN provider_turns pt
               ON pt.provider_turn_id = pa.provider_turn_id
            WHERE pt.execution_id = ?
            ORDER BY pa.provider_turn_id, pa.attempt_no`,
        )
        .all(input.executionId) as Ah18Snapshot["providerAttempts"],
      step: db
        .prepare(
          `SELECT execution_id, logical_step_no, repair_attempt, provider_turn_id,
                  state, settlement_json
             FROM agent_loop_steps WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt LIMIT 1`,
        )
        .get(input.executionId) as Ah18Snapshot["step"],
      steps: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, state, settlement_json
             FROM agent_loop_steps WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt`,
        )
        .all(input.executionId) as Ah18Snapshot["steps"],
      links: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, overflow_ordinal, role, provider_turn_id,
                  predecessor_provider_turn_id, context_epoch, state
             FROM agent_loop_step_provider_turns WHERE execution_id = ?
            ORDER BY overflow_ordinal, role`,
        )
        .all(input.executionId) as Ah18Snapshot["links"],
      execution: db
        .prepare(
          `SELECT execution_id, settled_at, settlement_kind
             FROM executions WHERE execution_id = ?`,
        )
        .get(input.executionId) as Ah18Snapshot["execution"],
      leases: db
        .prepare(
          "SELECT execution_id, generation, expires_at FROM execution_leases WHERE execution_id = ?",
        )
        .all(input.executionId) as Ah18Snapshot["leases"],
      workWait: db
        .prepare(
          "SELECT work_id, wait_mode, conditions_json FROM work_waits WHERE work_id = ?",
        )
        .get(input.workId) as Ah18Snapshot["workWait"],
      actions: db
        .prepare(
          `SELECT action_index, action_kind, state
             FROM agent_loop_step_actions WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt, action_index`,
        )
        .all(input.executionId) as Ah18Snapshot["actions"],
      durableOutputs: db
        .prepare(
          `SELECT item_type, source_ref FROM session_entries
            WHERE session_id = ? AND item_type IN
              ('AssistantMessage','ModelOutput','ToolCall','ToolResult','ControlResult','Observation')
            ORDER BY sequence`,
        )
        .all(input.sessionId) as Ah18Snapshot["durableOutputs"],
      work: db
        .prepare("SELECT work_id, lifecycle FROM works WHERE work_id = ?")
        .get(input.workId) as Ah18Snapshot["work"],
    };
    db.exec("ROLLBACK");
    return snapshot;
  } finally {
    db.close();
  }
};

export const readWorkExecutionId = (databaseFile: string, workId: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT execution_id FROM executions
          WHERE episode_kind = 'WorkEpisode' AND episode_ref = ?
          ORDER BY admitted_at DESC LIMIT 1`,
      )
      .get(workId)?.execution_id as string | undefined;
  } finally {
    db.close();
  }
};
