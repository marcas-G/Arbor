import type { DomainEvent, ProjectId } from "@arbor/domain";
import {
  type AssignWorkBindingAttentionFact,
  type AssignWorkBindingAttentionProjectionRow,
  AttentionProjectionStore,
  type AttentionProjectionStoreError,
  type AttentionProjectionStoreService,
  type ConsumerOffsetStoreError,
  type DeliverReplayAttentionProjectionRow,
  type ProjectionStoreService,
  type RecoveryAttentionFactStoreService,
  type ToolObservationReplayAttentionFactStoreService,
  type ToolObservationReplayAttentionProjectionRow,
  type SubmittedDecisionBindingAttentionProjectionRow,
  TransactionScope,
  type WorkspaceResourceActivationAttentionProjectionRow,
  type WorkspaceResourceActivationIntent,
  type WorkspaceResourceActivationStoreService,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { repositoryFailure } from "./repository-error.js";

interface AttentionProjectionDbRow {
  readonly project_id: string;
  readonly dedup_key: string;
  readonly source: "AssignWorkTargetBindingFailure";
  readonly severity: "ActionRequired";
  readonly target_workspace_id: string;
  readonly summary: string;
  readonly failure_code: AssignWorkBindingAttentionProjectionRow["failureCode"];
  readonly occurred_at: string;
  readonly source_event_id: string;
  readonly source_fact_id: string;
  readonly source_execution_id: string;
}

interface WorkspaceResourceActivationAttentionDbRow {
  readonly project_id: string;
  readonly workspace_id: string;
  readonly resource_boundary_revision: number;
  readonly occurred_at: string;
}

interface DeliverReplayAttentionDbRow {
  readonly project_id: string;
  readonly dedup_key: string;
  readonly target_workspace_id: string;
  readonly failure_code: DeliverReplayAttentionProjectionRow["failureCode"];
  readonly occurred_at: string;
  readonly source_event_id: string;
  readonly source_fact_id: string;
  readonly source_execution_id: string;
}

interface ToolObservationReplayAttentionDbRow {
  readonly project_id: string;
  readonly dedup_key: string;
  readonly source: "ToolObservationReplayEvidenceFailure";
  readonly severity: "ActionRequired";
  readonly target_workspace_id: string;
  readonly summary: ToolObservationReplayAttentionProjectionRow["summary"];
  readonly failure_code: ToolObservationReplayAttentionProjectionRow["failureCode"];
  readonly occurred_at: string;
  readonly source_event_id: string;
  readonly source_fact_id: string;
}
interface SubmittedDecisionBindingAttentionDbRow {
  readonly project_id: string;
  readonly dedup_key: string;
  readonly target_workspace_id: string;
  readonly failure_code: SubmittedDecisionBindingAttentionProjectionRow["failureCode"];
  readonly occurred_at: string;
  readonly source_event_id: string;
  readonly source_fact_id: string;
  readonly source_execution_id: string;
}

export type AttentionProjectionQualificationEvent =
  | {
      readonly boundary: "P10AfterAttentionRowWriteBeforeConsumerCommit";
      readonly projectId: ProjectId;
      readonly attentionFactId: string;
    }
  | {
      readonly boundary: "P10AfterActivationAttentionRowWriteBeforeProjectionCommit";
      readonly projectId: ProjectId;
      readonly workspaceId: WorkspaceResourceActivationAttentionProjectionRow["workspaceId"];
      readonly resourceBoundaryRevision: WorkspaceResourceActivationAttentionProjectionRow["resourceBoundaryRevision"];
    };

export type AttentionProjectionQualificationProbe = (
  event: AttentionProjectionQualificationEvent,
) => Promise<void>;

const fromDb = (
  row: AttentionProjectionDbRow,
): AssignWorkBindingAttentionProjectionRow => ({
  projectId: row.project_id as ProjectId,
  dedupKey: row.dedup_key,
  source: row.source,
  severity: row.severity,
  targetWorkspaceId: row.target_workspace_id as never,
  summary: row.summary,
  failureCode: row.failure_code,
  occurredAt: row.occurred_at,
  sourceEventId: row.source_event_id as never,
  sourceFactId: row.source_fact_id,
  sourceExecutionId: row.source_execution_id,
});

const activationRowFromDb = (
  row: WorkspaceResourceActivationAttentionDbRow,
): WorkspaceResourceActivationAttentionProjectionRow => ({
  projectId: row.project_id as ProjectId,
  workspaceId: row.workspace_id as never,
  resourceBoundaryRevision: Number(
    row.resource_boundary_revision,
  ) as WorkspaceResourceActivationAttentionProjectionRow["resourceBoundaryRevision"],
  occurredAt: row.occurred_at,
});

const deliverReplayRowFromDb = (
  row: DeliverReplayAttentionDbRow,
): DeliverReplayAttentionProjectionRow => ({
  projectId: row.project_id as ProjectId,
  dedupKey: row.dedup_key,
  source: "DeliverReplayFailure",
  severity: "ActionRequired",
  targetWorkspaceId: row.target_workspace_id as never,
  summary:
    "A Deliver handover could not be reconciled with its exact Message and MessageSent facts; execution recovery is paused.",
  failureCode: row.failure_code,
  occurredAt: row.occurred_at,
  sourceEventId: row.source_event_id as never,
  sourceFactId: row.source_fact_id,
  sourceExecutionId: row.source_execution_id,
});

const toolObservationRowFromDb = (
  row: ToolObservationReplayAttentionDbRow,
): ToolObservationReplayAttentionProjectionRow => ({
  projectId: row.project_id as ProjectId,
  dedupKey: row.dedup_key,
  source: row.source,
  severity: row.severity,
  targetWorkspaceId: row.target_workspace_id as never,
  summary: row.summary,
  failureCode: row.failure_code,
  occurredAt: row.occurred_at,
  sourceEventId: row.source_event_id as never,
  sourceFactId: row.source_fact_id,
});

const submittedDecisionBindingRowFromDb = (
  row: SubmittedDecisionBindingAttentionDbRow,
): SubmittedDecisionBindingAttentionProjectionRow => ({
  projectId: row.project_id as ProjectId,
  attentionFactId: row.dedup_key,
  workspaceId: row.target_workspace_id as never,
  firstDetectedAt: row.occurred_at,
  dedupKey: row.dedup_key,
  source: "SubmittedDecisionBindingFailure",
  severity: "ActionRequired",
  targetWorkspaceId: row.target_workspace_id as never,
  summary:
    "A submitted DecisionEpisode binding could not be proven against its exact Execution, Step, and Action; recovery is paused.",
  failureCode: row.failure_code,
  occurredAt: row.occurred_at,
  sourceEventId: row.source_event_id as never,
  sourceFactId: row.source_fact_id,
  sourceExecutionId: row.source_execution_id,
});

const sameRow = (
  left: AssignWorkBindingAttentionProjectionRow,
  right: AssignWorkBindingAttentionProjectionRow,
): boolean =>
  left.projectId === right.projectId &&
  left.dedupKey === right.dedupKey &&
  left.source === right.source &&
  left.severity === right.severity &&
  left.targetWorkspaceId === right.targetWorkspaceId &&
  left.summary === right.summary &&
  left.failureCode === right.failureCode &&
  left.occurredAt === right.occurredAt &&
  left.sourceEventId === right.sourceEventId &&
  left.sourceFactId === right.sourceFactId;

export const makeAttentionProjectionStoreLive = (
  qualificationProbe?: AttentionProjectionQualificationProbe,
): Layer.Layer<AttentionProjectionStore, never, SqlClient> =>
  Layer.effect(
    AttentionProjectionStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const failure = repositoryFailure("AttentionProjectionStore", "rows");
      const run = <A>(effect: Effect.Effect<A, SqlError>) =>
        effect.pipe(Effect.mapError(failure));
      const submittedDecisionBindingMarkerAvailable = () =>
        run(
          sql.unsafe<{ readonly name: string }>(
            `SELECT name FROM sqlite_master
              WHERE type = 'table'
                AND name = 'submitted_decision_binding_attention_rows'`,
          ),
        );
      const requireSubmittedDecisionBindingMarker = () =>
        Effect.gen(function* () {
          const tables = yield* submittedDecisionBindingMarkerAvailable();
          if (tables.length === 0) {
            return yield* Effect.fail<AttentionProjectionStoreError>({
              _tag: "PersistenceUnavailable",
              repository: "AttentionProjectionStore",
              operation: "submitted-decision-binding-marker",
              retryDisposition: "non-retryable",
              sourceTag: "P41MigrationNotRegistered",
              cause: { _tag: "P41MigrationNotRegistered" },
            });
          }
        });
      return AttentionProjectionStore.of({
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
                reason:
                  "Deliver marker input does not match its durable P9 fact",
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
        listDeliverReplayFailures: (projectId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* run(
              sql.unsafe<DeliverReplayAttentionDbRow>(
                `SELECT fact.project_id AS project_id,
                        fact.attention_fact_id AS dedup_key,
                        fact.target_workspace_id AS target_workspace_id,
                        fact.failure_code AS failure_code,
                        fact.first_detected_at AS occurred_at,
                        fact.event_id AS source_event_id,
                        fact.attention_fact_id AS source_fact_id,
                        fact.execution_id AS source_execution_id
                   FROM deliver_replay_attention_rows AS projected
                   JOIN deliver_replay_attention_facts AS fact
                     ON fact.attention_fact_id = projected.attention_fact_id
                  WHERE fact.project_id = ?
                  ORDER BY fact.first_detected_at, fact.attention_fact_id`,
                [projectId],
              ),
            );
            return rows.map(deliverReplayRowFromDb);
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
            const current = new Map<
              string,
              WorkspaceResourceActivationIntent
            >();
            for (const intent of intents) {
              if (intent.projectId !== projectId) continue;
              const key = `${intent.workspaceId}:${intent.resourceBoundaryRevision}`;
              if (current.has(key)) {
                return yield* Effect.fail<AttentionProjectionStoreError>({
                  _tag: "PersistenceCorruption",
                  repository: "AttentionProjectionStore",
                  operation: "activation-reconcile",
                  reason:
                    "P1 activation intent snapshot has duplicate identities",
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
          }),
      });
    }),
  );

export const AttentionProjectionStoreLive = makeAttentionProjectionStoreLive();

const payloadRecord = (payload: unknown): Record<string, unknown> =>
  typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};

const projectionFailure = (cause: unknown): ConsumerOffsetStoreError => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { readonly _tag?: unknown })._tag === "PersistenceUnavailable"
  ) {
    const unavailable = cause as {
      readonly operation: string;
      readonly retryDisposition: "retryable" | "non-retryable";
      readonly sourceTag: string;
      readonly cause: unknown;
    };
    return {
      _tag: "PersistenceUnavailable",
      repository: "ConsumerOffsetStore",
      operation: unavailable.operation,
      retryDisposition: unavailable.retryDisposition,
      sourceTag: unavailable.sourceTag,
      cause: unavailable.cause,
    };
  }
  return {
    _tag: "PersistenceCorruption",
    repository: "ConsumerOffsetStore",
    operation: "p10-attention-apply",
    reason: "P10 Attention source fact or projection row failed validation",
  };
};

/** Bind the shared P1 ProjectionStore face to one P10 project. `pollOnce`
 * will call `apply` and advance that consumer's offset in its existing single
 * transaction. Reset affects only this project's P10 rows; the P1 generic
 * marker store is not delegated to or cleared. */
export const makeProjectAttentionProjectionStore = (
  projectId: ProjectId,
  sourceFacts: Pick<
    RecoveryAttentionFactStoreService,
    | "findAssignWorkBindingFailure"
    | "findDeliverReplayFailure"
    | "listDeliverReplayFailures"
    | "listPendingDeliverReplayAttention"
    | "acknowledgePendingDeliverReplayAttention"
    | "isSubmittedDecisionBindingAvailable"
    | "findSubmittedDecisionBindingFailure"
    | "listSubmittedDecisionBindingFailures"
  >,
  attentionRows: Pick<
    AttentionProjectionStoreService,
    | "putAssignWorkBindingFailure"
    | "putDeliverReplayFailure"
    | "putToolObservationReplayFailure"
    | "isSubmittedDecisionBindingAvailable"
    | "putSubmittedDecisionBindingFailure"
    | "resetProject"
    | "reconcileWorkspaceResourceActivation"
    | "reconcileStaleWorkRevisionRows"
  >,
  activationIntents?: Pick<WorkspaceResourceActivationStoreService, "listAll">,
  toolObservationFacts?: Pick<
    ToolObservationReplayAttentionFactStoreService,
    "findById"
  >,
): ProjectionStoreService => ({
  apply: (batch: ReadonlyArray<DomainEvent<unknown>>) =>
    Effect.gen(function* () {
      for (const event of batch) {
        if (event.eventType === "WorkSteered") {
          if (event.projectId !== projectId) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "P10 Attention consumer received a WorkSteered event for another project",
            });
          }
          yield* attentionRows
            .reconcileStaleWorkRevisionRows(projectId)
            .pipe(Effect.mapError(projectionFailure));
          continue;
        }
        if (event.eventType === "WorkspaceResourceActivationChanged") {
          if (event.projectId !== projectId) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "P10 Attention consumer received an activation event for another project",
            });
          }
          if (activationIntents === undefined) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason: "P10 Activation Attention event has no P1 intent source",
            });
          }
          const eventPayload = payloadRecord(event.payload);
          const revision = eventPayload.resourceBoundaryRevision;
          if (
            eventPayload._tag !== "WorkspaceResourceActivationChanged" ||
            typeof eventPayload.workspaceId !== "string" ||
            event.aggregateRef !== eventPayload.workspaceId ||
            typeof revision !== "number" ||
            !Number.isInteger(revision) ||
            revision < 0 ||
            (eventPayload.status !== "Pending" &&
              eventPayload.status !== "Active")
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason: "P10 Activation Attention wakeup event was malformed",
            });
          }
          const intents = yield* activationIntents
            .listAll()
            .pipe(Effect.mapError(projectionFailure));
          yield* attentionRows
            .reconcileWorkspaceResourceActivation(projectId, intents)
            .pipe(Effect.mapError(projectionFailure));
          continue;
        }
        if (event.eventType === "DeliverReplayEscalated") {
          if (event.projectId !== projectId) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "P10 Attention consumer received a Deliver event for another project",
            });
          }
          const payload = payloadRecord(event.payload);
          const payloadKeys = Object.keys(payload).sort();
          const expectedPayloadKeys = [
            "attentionFactId",
            "executionId",
            "failureCode",
            "logicalActionId",
            "messageId",
            "targetWorkspaceId",
          ];
          const attentionFactId = payload.attentionFactId;
          if (
            typeof attentionFactId !== "string" ||
            attentionFactId.length === 0
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason: "Deliver replay event is missing its attentionFactId",
            });
          }
          const found = yield* sourceFacts
            .findDeliverReplayFailure(attentionFactId)
            .pipe(Effect.mapError(projectionFailure));
          if (Option.isNone(found)) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason: "Deliver replay event has no matching immutable P9 fact",
            });
          }
          const fact = found.value;
          if (
            fact.eventId !== event.eventId ||
            fact.projectId !== projectId ||
            event.eventType !== "DeliverReplayEscalated" ||
            event.eventVersion !== 1 ||
            event.actor !== "system:recovery" ||
            event.causedByEventId !== undefined ||
            event.aggregateRef !== fact.targetWorkspaceId ||
            event.correlationRef !== fact.logicalActionId ||
            event.occurredAt !== fact.firstDetectedAt ||
            fact.executionId !== String(payload.executionId ?? "") ||
            fact.targetWorkspaceId !==
              String(payload.targetWorkspaceId ?? "") ||
            fact.logicalActionId !== String(payload.logicalActionId ?? "") ||
            fact.messageId !== String(payload.messageId ?? "") ||
            fact.failureCode !== String(payload.failureCode ?? "") ||
            payloadKeys.length !== expectedPayloadKeys.length ||
            payloadKeys.some((key, index) => key !== expectedPayloadKeys[index])
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "Deliver replay event does not exactly match its immutable P9 fact",
            });
          }
          yield* attentionRows
            .putDeliverReplayFailure(fact)
            .pipe(Effect.mapError(projectionFailure));
          continue;
        }
        if (event.eventType === "ToolObservationReplayEvidenceEscalated") {
          if (event.projectId !== projectId) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "P10 Attention consumer received a tool observation replay event for another project",
            });
          }
          if (
            toolObservationFacts === undefined ||
            attentionRows.putToolObservationReplayFailure === undefined
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "P10 tool observation replay event has no exact P9 fact or P10 marker store",
            });
          }
          const payload = payloadRecord(event.payload);
          const attentionFactId = String(payload.attentionFactId ?? "");
          const found = yield* toolObservationFacts
            .findById(attentionFactId)
            .pipe(Effect.mapError(projectionFailure));
          if (Option.isNone(found)) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "tool observation replay event has no matching immutable P9 fact",
            });
          }
          const fact = found.value;
          if (
            fact.eventId !== event.eventId ||
            fact.projectId !== projectId ||
            event.aggregateRef !== fact.targetWorkspaceId ||
            event.correlationRef !== fact.logicalActionId ||
            event.causedByCommandId !== undefined ||
            event.occurredAt !== fact.firstDetectedAt ||
            fact.attentionFactId !== attentionFactId ||
            fact.executionId !== String(payload.executionId ?? "") ||
            fact.targetWorkspaceId !==
              String(payload.targetWorkspaceId ?? "") ||
            fact.logicalActionId !== String(payload.logicalActionId ?? "") ||
            fact.providerTurnId !== String(payload.providerTurnId ?? "") ||
            fact.callRef !== String(payload.callRef ?? "") ||
            fact.invocationId !== String(payload.invocationId ?? "") ||
            fact.failureCode !== String(payload.failureCode ?? "")
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "tool observation replay event does not exactly match its immutable P9 fact",
            });
          }
          yield* attentionRows
            .putToolObservationReplayFailure(fact, event.occurredAt)
            .pipe(Effect.mapError(projectionFailure));
          continue;
        }
        if (event.eventType === "SubmittedDecisionBindingEscalated") {
          if (event.projectId !== projectId) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "P10 Attention consumer received a Submitted Decision event for another project",
            });
          }
          const payload = payloadRecord(event.payload);
          const payloadKeys = Object.keys(payload).sort();
          const expectedPayloadKeys = [
            "attentionFactId",
            "executionId",
            "failureCode",
            "logicalActionId",
            "logicalStepNo",
            "providerTurnId",
            "repairAttempt",
            "workspaceId",
          ].sort();
          const attentionFactId = payload.attentionFactId;
          const findSubmitted = sourceFacts.findSubmittedDecisionBindingFailure;
          const putSubmitted = attentionRows.putSubmittedDecisionBindingFailure;
          if (
            typeof attentionFactId !== "string" ||
            attentionFactId.length === 0 ||
            findSubmitted === undefined ||
            putSubmitted === undefined
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "Submitted Decision event has no available immutable P9 fact and P10 marker route",
            });
          }
          const source = yield* findSubmitted(attentionFactId).pipe(
            Effect.mapError(projectionFailure),
          );
          if (Option.isNone(source)) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "Submitted Decision event has no matching immutable P9 fact",
            });
          }
          const fact = source.value;
          if (
            event.eventVersion !== 1 ||
            event.actor !== "system:recovery" ||
            event.aggregateRef !== fact.workspaceId ||
            event.correlationRef !== fact.logicalActionId ||
            event.causedByCommandId !== undefined ||
            event.causedByEventId !== undefined ||
            event.occurredAt !== fact.firstDetectedAt ||
            fact.eventId !== event.eventId ||
            fact.projectId !== projectId ||
            fact.attentionFactId !== attentionFactId ||
            fact.executionId !== payload.executionId ||
            fact.workspaceId !== payload.workspaceId ||
            fact.logicalStepNo !== payload.logicalStepNo ||
            fact.repairAttempt !== payload.repairAttempt ||
            fact.providerTurnId !== payload.providerTurnId ||
            fact.logicalActionId !== payload.logicalActionId ||
            fact.failureCode !== payload.failureCode ||
            payloadKeys.length !== expectedPayloadKeys.length ||
            payloadKeys.some((key, index) => key !== expectedPayloadKeys[index])
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "Submitted Decision event does not exactly match its immutable P9 fact",
            });
          }
          yield* putSubmitted(fact).pipe(Effect.mapError(projectionFailure));
          continue;
        }
        if (event.eventType !== "AssignWorkTargetBindingEscalated") continue;
        if (event.projectId !== projectId) {
          return yield* Effect.fail<ConsumerOffsetStoreError>({
            _tag: "PersistenceCorruption",
            repository: "ConsumerOffsetStore",
            operation: "p10-attention-apply",
            reason:
              "P10 Attention consumer received an event for another project",
          });
        }
        const payload = payloadRecord(event.payload);
        const attentionFactId = String(payload.attentionFactId ?? "");
        if (attentionFactId.length === 0) {
          return yield* Effect.fail<ConsumerOffsetStoreError>({
            _tag: "PersistenceCorruption",
            repository: "ConsumerOffsetStore",
            operation: "p10-attention-apply",
            reason: "AssignWork binding event is missing its attentionFactId",
          });
        }
        const found = yield* sourceFacts
          .findAssignWorkBindingFailure(attentionFactId)
          .pipe(Effect.mapError(projectionFailure));
        if (Option.isNone(found)) {
          return yield* Effect.fail<ConsumerOffsetStoreError>({
            _tag: "PersistenceCorruption",
            repository: "ConsumerOffsetStore",
            operation: "p10-attention-apply",
            reason:
              "AssignWork binding event has no matching immutable P9 fact",
          });
        }
        const fact: AssignWorkBindingAttentionFact = found.value;
        const payloadKeys = Object.keys(payload).sort();
        const expectedPayloadKeys = [
          "attentionFactId",
          "committedCommandId",
          "executionId",
          "failureCode",
          "logicalActionId",
          "targetWorkspaceId",
        ];
        if (
          fact.eventId !== event.eventId ||
          fact.projectId !== projectId ||
          event.eventVersion !== 1 ||
          event.actor !== "system:recovery" ||
          event.causedByEventId !== undefined ||
          event.aggregateRef !== fact.targetWorkspaceId ||
          event.correlationRef !== fact.logicalActionId ||
          event.causedByCommandId !== fact.committedCommandId ||
          event.occurredAt !== fact.firstDetectedAt ||
          fact.attentionFactId !== String(payload.attentionFactId ?? "") ||
          fact.executionId !== String(payload.executionId ?? "") ||
          fact.targetWorkspaceId !== String(payload.targetWorkspaceId ?? "") ||
          fact.logicalActionId !== String(payload.logicalActionId ?? "") ||
          fact.committedCommandId !==
            String(payload.committedCommandId ?? "") ||
          fact.failureCode !== String(payload.failureCode ?? "") ||
          payloadKeys.length !== expectedPayloadKeys.length ||
          payloadKeys.some((key, index) => key !== expectedPayloadKeys[index])
        ) {
          return yield* Effect.fail<ConsumerOffsetStoreError>({
            _tag: "PersistenceCorruption",
            repository: "ConsumerOffsetStore",
            operation: "p10-attention-apply",
            reason:
              "AssignWork binding event does not exactly match its immutable P9 fact",
          });
        }
        yield* attentionRows
          .putAssignWorkBindingFailure(fact, event.occurredAt)
          .pipe(Effect.mapError(projectionFailure));
      }
    }),
  reset: () =>
    Effect.gen(function* () {
      yield* attentionRows
        .resetProject(projectId)
        .pipe(Effect.mapError(projectionFailure));
      const deliverFacts = yield* sourceFacts
        .listDeliverReplayFailures(projectId)
        .pipe(Effect.mapError(projectionFailure));
      for (const fact of deliverFacts) {
        yield* attentionRows
          .putDeliverReplayFailure(fact)
          .pipe(Effect.mapError(projectionFailure));
      }
      const submittedFactsAvailable =
        sourceFacts.isSubmittedDecisionBindingAvailable === undefined
          ? false
          : yield* sourceFacts
              .isSubmittedDecisionBindingAvailable()
              .pipe(Effect.mapError(projectionFailure));
      const submittedMarkersAvailable =
        attentionRows.isSubmittedDecisionBindingAvailable === undefined
          ? false
          : yield* attentionRows
              .isSubmittedDecisionBindingAvailable()
              .pipe(Effect.mapError(projectionFailure));
      if (submittedFactsAvailable !== submittedMarkersAvailable) {
        return yield* Effect.fail<ConsumerOffsetStoreError>({
          _tag: "PersistenceCorruption",
          repository: "ConsumerOffsetStore",
          operation: "p10-attention-rebuild",
          reason:
            "Submitted Decision fact and Attention marker availability do not converge",
        });
      }
      if (submittedFactsAvailable) {
        if (
          sourceFacts.listSubmittedDecisionBindingFailures === undefined ||
          attentionRows.putSubmittedDecisionBindingFailure === undefined
        ) {
          return yield* Effect.fail<ConsumerOffsetStoreError>({
            _tag: "PersistenceCorruption",
            repository: "ConsumerOffsetStore",
            operation: "p10-attention-rebuild",
            reason:
              "Submitted Decision fact snapshot has no P10 marker write route",
          });
        }
        const submittedFacts = yield* sourceFacts
          .listSubmittedDecisionBindingFailures(projectId)
          .pipe(Effect.mapError(projectionFailure));
        for (const fact of submittedFacts) {
          yield* attentionRows
            .putSubmittedDecisionBindingFailure(fact)
            .pipe(Effect.mapError(projectionFailure));
        }
      }
      const pending = yield* sourceFacts
        .listPendingDeliverReplayAttention(projectId, Number.MAX_SAFE_INTEGER)
        .pipe(Effect.mapError(projectionFailure));
      for (const fact of pending) {
        yield* sourceFacts
          .acknowledgePendingDeliverReplayAttention(fact.attentionFactId)
          .pipe(Effect.mapError(projectionFailure));
      }
      yield* attentionRows
        .reconcileStaleWorkRevisionRows(projectId)
        .pipe(Effect.mapError(projectionFailure));
      if (activationIntents === undefined) return;
      const intents = yield* activationIntents
        .listAll()
        .pipe(Effect.mapError(projectionFailure));
      yield* attentionRows
        .reconcileWorkspaceResourceActivation(projectId, intents)
        .pipe(Effect.mapError(projectionFailure));
    }),
});
