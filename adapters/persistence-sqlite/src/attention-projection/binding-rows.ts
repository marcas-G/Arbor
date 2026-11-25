import {
  type AssignWorkBindingAttentionProjectionRow,
  type AttentionProjectionStoreError,
  type AttentionProjectionStoreService,
  TransactionScope,
} from "@arbor/ports";
import { Effect } from "effect";
import type { ProjectionContext } from "./context.js";
import {
  type AttentionProjectionDbRow,
  fromDb,
  type SubmittedDecisionBindingAttentionDbRow,
  sameRow,
  submittedDecisionBindingRowFromDb,
} from "./row-codecs.js";

export const makeBindingRows = (
  context: ProjectionContext,
): Pick<
  AttentionProjectionStoreService,
  | "isSubmittedDecisionBindingAvailable"
  | "putAssignWorkBindingFailure"
  | "putDeliverReplayFailure"
  | "putSubmittedDecisionBindingFailure"
  | "listSubmittedDecisionBindingFailures"
> => {
  const {
    sql,
    run,
    qualificationProbe,
    submittedDecisionBindingMarkerAvailable,
    requireSubmittedDecisionBindingMarker,
  } = context;
  return {
    isSubmittedDecisionBindingAvailable: () =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const tables = yield* submittedDecisionBindingMarkerAvailable();
        return tables.length > 0;
      }),
    putAssignWorkBindingFailure: (fact, occurredAt) =>
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
            _tag: "PersistenceCorruption" as const,
            repository: "AttentionProjectionStore" as const,
            operation: "target",
            reason:
              "P9 Attention fact target does not match the owning Execution workspace",
          });
        }
        const row: AssignWorkBindingAttentionProjectionRow = {
          projectId: fact.projectId,
          dedupKey: fact.attentionFactId,
          source: "AssignWorkTargetBindingFailure",
          severity: "ActionRequired",
          targetWorkspaceId: targetWorkspaceId as never,
          summary:
            "A committed AssignWork could not be proven to match its exact target; recovery is paused.",
          failureCode: fact.failureCode,
          occurredAt,
          sourceEventId: fact.eventId as never,
          sourceFactId: fact.attentionFactId,
          sourceExecutionId: fact.executionId,
        };
        yield* run(
          sql.unsafe(
            `INSERT INTO attention_projection_rows (
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
        if (qualificationProbe !== undefined) {
          yield* Effect.promise(() =>
            qualificationProbe({
              boundary: "P10AfterAttentionRowWriteBeforeConsumerCommit",
              projectId: row.projectId,
              attentionFactId: row.sourceFactId,
            }),
          );
        }
        const rows = yield* run(
          sql.unsafe<AttentionProjectionDbRow>(
            `SELECT project_id, dedup_key, source, severity,
                      target_workspace_id, summary, failure_code, occurred_at,
                      source_event_id, source_fact_id
                 FROM attention_projection_rows
                WHERE project_id = ? AND dedup_key = ?`,
            [row.projectId, row.dedupKey],
          ),
        );
        const stored = rows[0];
        if (stored === undefined || !sameRow(fromDb(stored), row)) {
          return yield* Effect.fail({
            _tag: "PersistenceCorruption" as const,
            repository: "AttentionProjectionStore" as const,
            operation: "rows",
            reason:
              "Attention dedup identity is already bound to another source row",
          });
        }
      }),
    putDeliverReplayFailure: (fact) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const stored = yield* run(
          sql.unsafe<{
            readonly event_id: string;
            readonly project_id: string;
            readonly execution_id: string;
            readonly target_workspace_id: string;
            readonly logical_action_id: string;
            readonly message_id: string;
            readonly failure_code: string;
            readonly first_detected_at: string;
          }>(
            `SELECT event_id, project_id, execution_id, target_workspace_id,
                        logical_action_id, message_id, failure_code, first_detected_at
                   FROM deliver_replay_attention_facts
                  WHERE attention_fact_id = ?`,
            [fact.attentionFactId],
          ),
        );
        const row = stored[0];
        if (
          row === undefined ||
          row.event_id !== fact.eventId ||
          row.project_id !== fact.projectId ||
          row.execution_id !== fact.executionId ||
          row.target_workspace_id !== fact.targetWorkspaceId ||
          row.logical_action_id !== fact.logicalActionId ||
          row.message_id !== fact.messageId ||
          row.failure_code !== fact.failureCode ||
          row.first_detected_at !== fact.firstDetectedAt
        ) {
          return yield* Effect.fail<AttentionProjectionStoreError>({
            _tag: "PersistenceCorruption",
            repository: "AttentionProjectionStore",
            operation: "deliver-replay-marker",
            reason: "Deliver marker input does not match its durable P9 fact",
          });
        }
        yield* run(
          sql.unsafe(
            `INSERT INTO deliver_replay_attention_rows (attention_fact_id)
                 VALUES (?) ON CONFLICT(attention_fact_id) DO NOTHING`,
            [fact.attentionFactId],
          ),
        );
        if (qualificationProbe !== undefined) {
          yield* Effect.promise(() =>
            qualificationProbe({
              boundary: "P10AfterAttentionRowWriteBeforeConsumerCommit",
              projectId: fact.projectId,
              attentionFactId: fact.attentionFactId,
            }),
          );
        }
      }),
    putSubmittedDecisionBindingFailure: (fact) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        yield* requireSubmittedDecisionBindingMarker();
        const sourceFacts = yield* run(
          sql.unsafe<{
            readonly attention_fact_id: string;
            readonly event_id: string;
            readonly project_id: string;
            readonly execution_id: string;
            readonly workspace_id: string;
            readonly logical_step_no: number;
            readonly repair_attempt: number;
            readonly provider_turn_id: string;
            readonly logical_action_id: string;
            readonly failure_code: string;
            readonly first_detected_at: string;
          }>(
            `SELECT attention_fact_id, event_id, project_id, execution_id,
                        workspace_id, logical_step_no, repair_attempt,
                        provider_turn_id, logical_action_id, failure_code,
                        first_detected_at
                   FROM submitted_decision_binding_attention_facts
                  WHERE attention_fact_id = ?`,
            [fact.attentionFactId],
          ),
        );
        const source = sourceFacts[0];
        if (
          source === undefined ||
          source.attention_fact_id !== fact.attentionFactId ||
          source.event_id !== fact.eventId ||
          source.project_id !== fact.projectId ||
          source.execution_id !== fact.executionId ||
          source.workspace_id !== fact.workspaceId ||
          Number(source.logical_step_no) !== fact.logicalStepNo ||
          Number(source.repair_attempt) !== fact.repairAttempt ||
          source.provider_turn_id !== fact.providerTurnId ||
          source.logical_action_id !== fact.logicalActionId ||
          source.failure_code !== fact.failureCode ||
          source.first_detected_at !== fact.firstDetectedAt
        ) {
          return yield* Effect.fail<AttentionProjectionStoreError>({
            _tag: "PersistenceCorruption",
            repository: "AttentionProjectionStore",
            operation: "submitted-decision-binding-marker",
            reason:
              "Submitted DecisionEpisode marker input does not match its exact immutable P9 fact",
          });
        }
        const executions = yield* run(
          sql.unsafe<{ readonly workspace_id: string }>(
            `SELECT workspace_id FROM executions
                  WHERE execution_id = ? AND project_id = ?`,
            [fact.executionId, fact.projectId],
          ),
        );
        if (executions[0]?.workspace_id !== fact.workspaceId) {
          return yield* Effect.fail<AttentionProjectionStoreError>({
            _tag: "PersistenceCorruption",
            repository: "AttentionProjectionStore",
            operation: "submitted-decision-binding-marker",
            reason:
              "Submitted DecisionEpisode fact Workspace does not match its authoritative Execution",
          });
        }
        yield* run(
          sql.unsafe(
            `INSERT INTO submitted_decision_binding_attention_rows (
                   project_id, attention_fact_id, workspace_id
                 ) VALUES (?, ?, ?)
                 ON CONFLICT(project_id, attention_fact_id) DO NOTHING`,
            [fact.projectId, fact.attentionFactId, fact.workspaceId],
          ),
        );
        const markers = yield* run(
          sql.unsafe<{ readonly workspace_id: string }>(
            `SELECT workspace_id
                   FROM submitted_decision_binding_attention_rows
                  WHERE project_id = ? AND attention_fact_id = ?`,
            [fact.projectId, fact.attentionFactId],
          ),
        );
        if (markers[0]?.workspace_id !== fact.workspaceId) {
          return yield* Effect.fail<AttentionProjectionStoreError>({
            _tag: "PersistenceCorruption",
            repository: "AttentionProjectionStore",
            operation: "submitted-decision-binding-marker",
            reason:
              "Submitted DecisionEpisode marker identity is bound to another Workspace",
          });
        }
      }),
    listSubmittedDecisionBindingFailures: (projectId) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        yield* requireSubmittedDecisionBindingMarker();
        const rows = yield* run(
          sql.unsafe<SubmittedDecisionBindingAttentionDbRow>(
            `SELECT marker.project_id AS project_id,
                        marker.attention_fact_id AS dedup_key,
                        marker.workspace_id AS target_workspace_id,
                        fact.failure_code AS failure_code,
                        fact.first_detected_at AS occurred_at,
                        fact.event_id AS source_event_id,
                        fact.attention_fact_id AS source_fact_id,
                        fact.execution_id AS source_execution_id
                   FROM submitted_decision_binding_attention_rows AS marker
                   JOIN submitted_decision_binding_attention_facts AS fact
                     ON fact.attention_fact_id = marker.attention_fact_id
                    AND fact.project_id = marker.project_id
                    AND fact.workspace_id = marker.workspace_id
                  WHERE marker.project_id = ?
                  ORDER BY fact.first_detected_at, fact.attention_fact_id`,
            [projectId],
          ),
        );
        return rows.map(submittedDecisionBindingRowFromDb);
      }),
  };
};
