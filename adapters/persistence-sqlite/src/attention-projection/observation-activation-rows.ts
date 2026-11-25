import type { ProjectId } from "@arbor/domain";
import {
  type AttentionProjectionStoreError,
  type AttentionProjectionStoreService,
  type ToolObservationReplayAttentionProjectionRow,
  TransactionScope,
  type WorkspaceResourceActivationIntent,
} from "@arbor/ports";
import { Effect } from "effect";
import { persistenceCorruption } from "../repository-error.js";
import type { ProjectionContext } from "./context.js";
import {
  type AttentionProjectionDbRow,
  activationRowFromDb,
  fromDb,
  type ToolObservationReplayAttentionDbRow,
  toolObservationRowFromDb,
  type WorkspaceResourceActivationAttentionDbRow,
} from "./row-codecs.js";

export const makeObservationActivationRows = (
  context: ProjectionContext,
): Pick<
  AttentionProjectionStoreService,
  | "listVerificationSignalReconciliationFailures"
  | "listAssignWorkBindingFailures"
  | "putToolObservationReplayFailure"
  | "listToolObservationReplayFailures"
  | "reconcileWorkspaceResourceActivation"
  | "reconcileStaleWorkRevisionRows"
  | "listWorkspaceResourceActivationPending"
> => {
  const { sql, run, qualificationProbe } = context;
  return {
    listVerificationSignalReconciliationFailures: (projectId) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const rows = yield* run(
          sql.unsafe<{
            readonly project_id: string;
            readonly event_sequence: number;
            readonly attention_fact_id: string;
            readonly event_id: string | null;
            readonly failure_code: string;
            readonly target_workspace_id: string;
            readonly root_workspace_id: string;
            readonly first_detected_at: string;
            readonly phase: string;
          }>(
            `SELECT fact.project_id, fact.event_sequence,
                        fact.attention_fact_id, fact.event_id,
                        fact.failure_code, fact.target_workspace_id,
                        project.root_workspace_id, fact.first_detected_at,
                        reconciliation.phase
                   FROM verification_signal_reconciliation_attention_rows AS marker
                   JOIN verification_signal_reconciliation_attention_facts AS fact
                     ON fact.attention_fact_id = marker.attention_fact_id
                    AND fact.project_id = marker.project_id
                   JOIN projects AS project ON project.project_id = fact.project_id
                   JOIN verification_signal_reconciliations AS reconciliation
                     ON reconciliation.consumer_id = fact.consumer_id
                    AND reconciliation.project_id = fact.project_id
                    AND reconciliation.event_sequence = fact.event_sequence
                  WHERE marker.project_id = ?
                  ORDER BY fact.first_detected_at, fact.event_sequence`,
            [projectId],
          ),
        );
        const result: Array<
          import("@arbor/ports").VerificationSignalReconciliationAttentionProjectionRow
        > = [];
        for (const row of rows) {
          if (
            row.target_workspace_id !== row.root_workspace_id ||
            row.phase !== "Attention"
          ) {
            return yield* Effect.fail<AttentionProjectionStoreError>(
              persistenceCorruption(
                "AttentionProjectionStore",
                "f18-reconciliation-attention-binding",
                "P10 F18 marker does not resolve to an Attention fact targeted at the exact Project root",
              ),
            );
          }
          result.push({
            projectId: row.project_id as ProjectId,
            dedupKey: `f18-verification-v2-reconciliation:${row.project_id}:${row.event_sequence}`,
            source: "F18VerificationSignalReconciliation" as const,
            severity: "ActionRequired" as const,
            targetWorkspaceId: row.target_workspace_id as never,
            summary:
              "A verified result delivery could not be reconciled; recovery is paused." as const,
            failureCode: row.failure_code,
            occurredAt: row.first_detected_at,
            sourceEventId: row.event_id as never,
            sourceFactId: row.attention_fact_id,
          });
        }
        return result;
      }),
    listAssignWorkBindingFailures: (projectId) =>
      Effect.map(
        run(
          sql.unsafe<AttentionProjectionDbRow>(
            `SELECT projected.project_id, projected.dedup_key,
                      projected.source, projected.severity,
                      projected.target_workspace_id, projected.summary,
                      projected.failure_code, projected.occurred_at,
                      projected.source_event_id, projected.source_fact_id,
                      fact.execution_id AS source_execution_id
                 FROM attention_projection_rows AS projected
                 JOIN assign_work_binding_attention_facts AS fact
                   ON fact.attention_fact_id = projected.source_fact_id
                WHERE projected.project_id = ? ORDER BY occurred_at, dedup_key`,
            [projectId],
          ),
        ),
        (rows) => rows.map(fromDb),
      ),
    putToolObservationReplayFailure: (fact, occurredAt) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const owners = yield* run(
          sql.unsafe<{ workspace_id: string }>(
            "SELECT workspace_id FROM executions WHERE execution_id = ? AND project_id = ?",
            [fact.executionId, fact.projectId],
          ),
        );
        const targetWorkspaceId = owners[0]?.workspace_id;
        if (
          targetWorkspaceId === undefined ||
          targetWorkspaceId !== fact.targetWorkspaceId
        ) {
          return yield* Effect.fail<AttentionProjectionStoreError>({
            _tag: "PersistenceCorruption",
            repository: "AttentionProjectionStore",
            operation: "tool-observation-target",
            reason:
              "P9 tool observation replay fact target does not match the owning Execution workspace",
          });
        }
        const row: ToolObservationReplayAttentionProjectionRow = {
          projectId: fact.projectId,
          dedupKey: fact.attentionFactId,
          source: "ToolObservationReplayEvidenceFailure",
          severity: "ActionRequired",
          targetWorkspaceId: targetWorkspaceId as never,
          summary:
            "A terminal tool outcome could not be replayed from durable observation evidence; recovery is paused.",
          failureCode: fact.failureCode,
          occurredAt,
          sourceEventId: fact.eventId,
          sourceFactId: fact.attentionFactId,
        };
        yield* run(
          sql.unsafe(
            `INSERT INTO tool_observation_replay_attention_rows (
                  project_id, dedup_key, source, severity, target_workspace_id,
                  summary, failure_code, occurred_at, source_event_id, source_fact_id
                ) VALUES (?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(project_id, dedup_key) DO NOTHING`,
            [
              row.projectId,
              row.dedupKey,
              row.source,
              row.severity,
              row.targetWorkspaceId,
              row.summary,
              row.failureCode,
              row.occurredAt,
              row.sourceEventId,
              row.sourceFactId,
            ],
          ),
        );
        const rows = yield* run(
          sql.unsafe<ToolObservationReplayAttentionDbRow>(
            `SELECT project_id, dedup_key, source, severity,
                        target_workspace_id, summary, failure_code, occurred_at,
                        source_event_id, source_fact_id
                   FROM tool_observation_replay_attention_rows
                  WHERE project_id = ? AND dedup_key = ?`,
            [row.projectId, row.dedupKey],
          ),
        );
        const stored = rows[0];
        if (
          stored === undefined ||
          JSON.stringify(toolObservationRowFromDb(stored)) !==
            JSON.stringify(row)
        ) {
          return yield* Effect.fail<AttentionProjectionStoreError>({
            _tag: "PersistenceCorruption",
            repository: "AttentionProjectionStore",
            operation: "tool-observation-rows",
            reason:
              "P10 replay-evidence dedup identity is already bound to another source row",
          });
        }
      }),
    listToolObservationReplayFailures: (projectId) =>
      Effect.gen(function* () {
        const exists = yield* run(
          sql.unsafe<{ readonly n: number }>(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'tool_observation_replay_attention_rows'",
          ),
        );
        if (Number(exists[0]?.n ?? 0) !== 1) return [];
        const rows = yield* run(
          sql.unsafe<ToolObservationReplayAttentionDbRow>(
            `SELECT project_id, dedup_key, source, severity,
                        target_workspace_id, summary, failure_code, occurred_at,
                        source_event_id, source_fact_id
                   FROM tool_observation_replay_attention_rows
                  WHERE project_id = ? ORDER BY occurred_at, dedup_key`,
            [projectId],
          ),
        );
        return rows.map(toolObservationRowFromDb);
      }),
    reconcileWorkspaceResourceActivation: (projectId, intents) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const current = new Map<string, WorkspaceResourceActivationIntent>();
        for (const intent of intents) {
          if (intent.projectId !== projectId) continue;
          const key = `${intent.workspaceId}:${intent.resourceBoundaryRevision}`;
          if (current.has(key)) {
            return yield* Effect.fail<AttentionProjectionStoreError>({
              _tag: "PersistenceCorruption",
              repository: "AttentionProjectionStore",
              operation: "activation-reconcile",
              reason: "P1 activation intent snapshot has duplicate identities",
            });
          }
          current.set(key, intent);
        }
        const existing = yield* run(
          sql.unsafe<WorkspaceResourceActivationAttentionDbRow>(
            `SELECT project_id, workspace_id, resource_boundary_revision,
                        occurred_at
                   FROM workspace_resource_activation_attention_rows
                  WHERE project_id = ?`,
            [projectId],
          ),
        );
        const pendingKeys = new Set(
          [...current.entries()]
            .filter(([, intent]) => intent.status === "Pending")
            .map(([key]) => key),
        );
        for (const row of existing) {
          const key = `${row.workspace_id}:${Number(row.resource_boundary_revision)}`;
          if (pendingKeys.has(key)) continue;
          yield* run(
            sql.unsafe(
              `DELETE FROM workspace_resource_activation_attention_rows
                    WHERE project_id = ? AND workspace_id = ?
                      AND resource_boundary_revision = ?`,
              [projectId, row.workspace_id, row.resource_boundary_revision],
            ),
          );
        }
        for (const intent of current.values()) {
          if (intent.status !== "Pending") continue;
          yield* run(
            sql.unsafe(
              `INSERT INTO workspace_resource_activation_attention_rows (
                    project_id, workspace_id, resource_boundary_revision,
                    occurred_at
                  ) VALUES (?,?,?,?)
                  ON CONFLICT(project_id, workspace_id, resource_boundary_revision)
                  DO UPDATE SET occurred_at = excluded.occurred_at`,
              [
                projectId,
                intent.workspaceId,
                intent.resourceBoundaryRevision,
                intent.createdAt,
              ],
            ),
          );
          if (qualificationProbe !== undefined) {
            yield* Effect.promise(() =>
              qualificationProbe({
                boundary:
                  "P10AfterActivationAttentionRowWriteBeforeProjectionCommit",
                projectId,
                workspaceId: intent.workspaceId,
                resourceBoundaryRevision: intent.resourceBoundaryRevision,
              }),
            );
          }
        }
      }),
    reconcileStaleWorkRevisionRows: (projectId) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const staleExecution = `
              SELECT e.execution_id
                FROM executions AS e
                JOIN agent_execution_state AS state
                  ON state.execution_id = e.execution_id
                JOIN works AS work
                  ON work.work_id = CASE
                       WHEN json_valid(state.episode_json)
                       THEN json_extract(state.episode_json, '$.workId')
                       ELSE NULL
                     END
                 AND work.project_id = e.project_id
                 AND work.workspace_id = e.workspace_id
               WHERE e.project_id = ?
                 AND json_valid(state.episode_json)
                 AND CASE WHEN json_valid(state.episode_json)
                          THEN json_extract(state.episode_json, '$._tag')
                          ELSE NULL END = 'WorkEpisode'
                 AND CASE WHEN json_valid(state.episode_json)
                          THEN json_type(state.episode_json, '$.targetWorkRevision')
                          ELSE NULL END = 'integer'
                 AND CAST(CASE WHEN json_valid(state.episode_json)
                               THEN json_extract(state.episode_json, '$.targetWorkRevision')
                               ELSE NULL END AS INTEGER) < work.revision`;
        yield* run(
          sql.unsafe(
            `DELETE FROM attention_projection_rows
                  WHERE project_id = ?
                    AND source = 'AssignWorkTargetBindingFailure'
                    AND source_fact_id IN (
                      SELECT fact.attention_fact_id
                        FROM assign_work_binding_attention_facts AS fact
                        JOIN executions AS e
                          ON e.execution_id = fact.execution_id
                         AND e.project_id = fact.project_id
                         AND e.workspace_id = fact.target_workspace_id
                       WHERE fact.project_id = ?
                         AND fact.execution_id IN (${staleExecution})
                    )`,
            [projectId, projectId, projectId],
          ),
        );
        const deliverTable = yield* run(
          sql.unsafe<{ readonly name: string }>(
            `SELECT name FROM sqlite_master
                  WHERE type = 'table'
                    AND name = 'deliver_replay_attention_rows'`,
          ),
        );
        if (deliverTable.length > 0) {
          yield* run(
            sql.unsafe(
              `DELETE FROM deliver_replay_attention_rows
                    WHERE attention_fact_id IN (
                      SELECT fact.attention_fact_id
                        FROM deliver_replay_attention_facts AS fact
                        JOIN executions AS e
                          ON e.execution_id = fact.execution_id
                         AND e.project_id = fact.project_id
                         AND e.workspace_id = fact.target_workspace_id
                       WHERE fact.project_id = ?
                         AND fact.execution_id IN (${staleExecution})
                    )`,
              [projectId, projectId],
            ),
          );
        }
      }),
    listWorkspaceResourceActivationPending: (projectId) =>
      Effect.map(
        run(
          sql.unsafe<WorkspaceResourceActivationAttentionDbRow>(
            `SELECT project_id, workspace_id, resource_boundary_revision,
                        occurred_at
                   FROM workspace_resource_activation_attention_rows
                  WHERE project_id = ?
                  ORDER BY occurred_at, workspace_id, resource_boundary_revision`,
            [projectId],
          ),
        ),
        (rows) => rows.map(activationRowFromDb),
      ),
  };
};
