import type {
  AttentionProjectionStoreError,
  AttentionProjectionStoreService,
} from "@arbor/ports";
import { Effect } from "effect";
import { persistenceCorruption } from "../repository-error.js";
import type { ProjectionContext } from "./context.js";

export const makeResetProject = (
  context: ProjectionContext,
): Pick<AttentionProjectionStoreService, "resetProject"> => {
  const { sql, run, submittedDecisionBindingMarkerAvailable } = context;
  return {
    resetProject: (projectId) =>
      Effect.gen(function* () {
        const submittedMarkers =
          yield* submittedDecisionBindingMarkerAvailable();
        if (submittedMarkers.length > 0) {
          yield* run(
            sql.unsafe(
              `DELETE FROM submitted_decision_binding_attention_rows
                    WHERE project_id = ?`,
              [projectId],
            ),
          );
        }
        const legacyMarkers = yield* run(
          sql.unsafe<{ readonly name: string }>(
            `SELECT name FROM sqlite_master
                  WHERE type='table' AND name='legacy_adoption_attention_rows'`,
          ),
        );
        if (legacyMarkers.length > 0) {
          yield* run(
            sql.unsafe(
              `DELETE FROM legacy_adoption_attention_rows
                    WHERE project_id = ?`,
              [projectId],
            ),
          );
        }
        yield* run(
          sql.unsafe(
            `DELETE FROM deliver_replay_attention_rows
                  WHERE attention_fact_id IN (
                    SELECT attention_fact_id FROM deliver_replay_attention_facts
                     WHERE project_id = ?
                  )`,
            [projectId],
          ),
        );
        yield* run(
          sql.unsafe(
            "DELETE FROM attention_projection_rows WHERE project_id = ?",
            [projectId],
          ),
        );
        const table = yield* run(
          sql.unsafe<{ name: string }>(
            `SELECT name FROM sqlite_master
                  WHERE type = 'table'
                    AND name = 'workspace_resource_activation_attention_rows'`,
          ),
        );
        if (table.length > 0) {
          yield* run(
            sql.unsafe(
              "DELETE FROM workspace_resource_activation_attention_rows WHERE project_id = ?",
              [projectId],
            ),
          );
        }
        const replayTable = yield* run(
          sql.unsafe<{ name: string }>(
            `SELECT name FROM sqlite_master
                  WHERE type = 'table'
                    AND name = 'tool_observation_replay_attention_rows'`,
          ),
        );
        if (replayTable.length > 0) {
          yield* run(
            sql.unsafe(
              "DELETE FROM tool_observation_replay_attention_rows WHERE project_id = ?",
              [projectId],
            ),
          );
        }
        const sandboxMarkers = yield* run(
          sql.unsafe<{ readonly name: string }>(
            `SELECT name FROM sqlite_master WHERE type='table'
                  AND name='sandbox_provider_unavailable_attention_rows'`,
          ),
        );
        if (sandboxMarkers.length > 0) {
          yield* run(
            sql.unsafe(
              `DELETE FROM sandbox_provider_unavailable_attention_rows
                    WHERE project_id = ?`,
              [projectId],
            ),
          );
        }
        const f18MarkerTable = yield* run(
          sql.unsafe<{ readonly name: string }>(
            `SELECT name FROM sqlite_master WHERE type='table'
                  AND name='verification_signal_reconciliation_attention_rows'`,
          ),
        );
        if (f18MarkerTable.length > 0) {
          yield* run(
            sql.unsafe(
              `DELETE FROM verification_signal_reconciliation_attention_rows
                    WHERE project_id = ?`,
              [projectId],
            ),
          );
          const facts = yield* run(
            sql.unsafe<{
              readonly attention_fact_id: string;
              readonly project_id: string;
              readonly target_workspace_id: string;
              readonly root_workspace_id: string;
              readonly phase: string;
              readonly first_detected_at: string;
            }>(
              `SELECT fact.attention_fact_id, fact.project_id,
                          fact.target_workspace_id, project.root_workspace_id,
                          reconciliation.phase, fact.first_detected_at
                     FROM verification_signal_reconciliation_attention_facts AS fact
                     JOIN projects AS project ON project.project_id = fact.project_id
                     JOIN verification_signal_reconciliations AS reconciliation
                       ON reconciliation.consumer_id = fact.consumer_id
                      AND reconciliation.project_id = fact.project_id
                      AND reconciliation.event_sequence = fact.event_sequence
                    WHERE fact.project_id = ?
                    ORDER BY fact.first_detected_at, fact.event_sequence`,
              [projectId],
            ),
          );
          for (const fact of facts) {
            if (
              fact.target_workspace_id !== fact.root_workspace_id ||
              fact.phase !== "Attention"
            ) {
              return yield* Effect.fail<AttentionProjectionStoreError>(
                persistenceCorruption(
                  "AttentionProjectionStore",
                  "f18-attention-rebuild-binding",
                  "F18 Attention fact does not bind to its reconciliation and exact Project root",
                ),
              );
            }
            yield* run(
              sql.unsafe(
                `INSERT INTO verification_signal_reconciliation_attention_rows
                      (attention_fact_id, project_id) VALUES (?,?)
                      ON CONFLICT(attention_fact_id) DO NOTHING`,
                [fact.attention_fact_id, fact.project_id],
              ),
            );
            const marker = yield* run(
              sql.unsafe<{ readonly project_id: string }>(
                `SELECT project_id FROM verification_signal_reconciliation_attention_rows
                      WHERE attention_fact_id = ?`,
                [fact.attention_fact_id],
              ),
            );
            if (marker[0]?.project_id !== fact.project_id) {
              return yield* Effect.fail<AttentionProjectionStoreError>(
                persistenceCorruption(
                  "AttentionProjectionStore",
                  "f18-attention-rebuild-marker",
                  "F18 marker identity conflicts with its immutable fact",
                ),
              );
            }
            yield* run(
              sql.unsafe(
                `UPDATE verification_signal_reconciliation_attention_queue
                        SET state = 'Projected', lease_owner = NULL,
                            lease_expires_at = NULL, projected_at = COALESCE(projected_at, ?)
                      WHERE project_id = ? AND attention_fact_id = ?`,
                [
                  fact.first_detected_at,
                  fact.project_id,
                  fact.attention_fact_id,
                ],
              ),
            );
          }
        }
      }),
  };
};
