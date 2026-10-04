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
          "SELECT execution_id, stop_requested_at, settled_at, settlement_kind FROM executions",
        )
        .all(),
      leases: db
        .prepare(
          "SELECT execution_id, generation, expires_at FROM execution_leases",
        )
        .all(),
      steps: db
        .prepare(
          "SELECT execution_id, provider_turn_id, repair_attempt, state, revision FROM agent_loop_steps",
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
