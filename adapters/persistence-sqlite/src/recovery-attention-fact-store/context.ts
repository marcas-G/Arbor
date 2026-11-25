import type {
  AgentLoopStepFence,
  DeliverReplayAttentionFact,
  LeaseFencingRejected,
  RecordAssignWorkBindingFailureInput,
  RecordDeliverReplayFailureInput,
  RecordSubmittedDecisionBindingFailureInput,
  RecoveryAttentionFactStoreError,
} from "@arbor/ports";
import { DomainEventJournal, IdGenerator } from "@arbor/ports";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { repositoryFailure } from "../repository-error.js";
import type { SubmittedDecisionBindingAttentionDbRow } from "../submitted-decision-binding-attention-codec.js";
import {
  DELIVER_REPLAY_COLUMNS,
  type DeliverReplayRow,
  type LegacyAdoptionAttentionRow,
  legacyAdoptionColumns,
  type RecoveryAttentionFactQualificationProbe,
  type Row,
  submittedDecisionBindingColumns,
} from "./row-codecs.js";

export const makeFactContext = (
  qualificationProbe?: RecoveryAttentionFactQualificationProbe,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const journal = yield* DomainEventJournal;
    const ids = yield* IdGenerator;
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(
        Effect.mapError(
          repositoryFailure(
            "RecoveryAttentionFactStore",
            "assign-work-binding",
          ),
        ),
      );
    const runLegacyAdoption = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(
        Effect.mapError(
          repositoryFailure(
            "RecoveryAttentionFactStore",
            "legacy-adoption-attention",
          ),
        ),
      );
    const readLegacyAdoptionById = (attentionFactId: string) =>
      runLegacyAdoption(
        sql.unsafe<LegacyAdoptionAttentionRow>(
          `SELECT ${legacyAdoptionColumns}
               FROM legacy_adoption_attention_facts
              WHERE attention_fact_id = ?`,
          [attentionFactId],
        ),
      );
    const assertLegacyAdoptionFence = (
      fence: AgentLoopStepFence,
      fenceNow: string,
    ) =>
      Effect.gen(function* () {
        const rows = yield* runLegacyAdoption(
          sql.unsafe<{ readonly ok: number }>(
            `SELECT 1 AS ok
                 FROM executions AS e
                 JOIN execution_leases AS l ON l.execution_id = e.execution_id
                WHERE e.execution_id = ? AND e.settled_at IS NULL
                  AND l.worker_id = ? AND l.worker_incarnation_id = ?
                  AND l.generation = ? AND l.expires_at > ?`,
            [
              fence.executionId,
              fence.workerId,
              fence.workerIncarnationId,
              fence.fencingGeneration,
              fenceNow,
            ],
          ),
        );
        if (rows.length === 0) {
          return yield* Effect.fail<LeaseFencingRejected>({
            _tag: "LeaseFencingRejected",
            executionId: fence.executionId,
            generation: fence.fencingGeneration,
          });
        }
      });
    const readByTuple = (input: RecordAssignWorkBindingFailureInput) =>
      run(
        sql.unsafe<Row>(
          `SELECT attention_fact_id, event_id, project_id, execution_id,
                  target_workspace_id, logical_action_id, committed_command_id,
                  failure_code, first_detected_at
             FROM assign_work_binding_attention_facts
            WHERE execution_id = ? AND logical_action_id = ? AND committed_command_id = ?`,
          [input.executionId, input.logicalActionId, input.committedCommandId],
        ),
      );
    const runDeliver = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(
        Effect.mapError(
          repositoryFailure("RecoveryAttentionFactStore", "deliver-replay"),
        ),
      );
    const readDeliverByTuple = (input: RecordDeliverReplayFailureInput) =>
      runDeliver(
        sql.unsafe<DeliverReplayRow>(
          `SELECT ${DELIVER_REPLAY_COLUMNS}
               FROM deliver_replay_attention_facts
              WHERE execution_id = ? AND logical_action_id = ? AND message_id = ?`,
          [input.executionId, input.logicalActionId, input.messageId],
        ),
      );
    const readDeliverById = (attentionFactId: string) =>
      runDeliver(
        sql.unsafe<DeliverReplayRow>(
          `SELECT ${DELIVER_REPLAY_COLUMNS}
               FROM deliver_replay_attention_facts WHERE attention_fact_id = ?`,
          [attentionFactId],
        ),
      );
    const ensureSubmittedDecisionBindingAvailable = () =>
      Effect.gen(function* () {
        const tables = yield* run(
          sql.unsafe<{ readonly name: string }>(
            `SELECT name FROM sqlite_master
                WHERE type = 'table'
                  AND name = 'submitted_decision_binding_attention_facts'`,
          ),
        );
        if (tables.length === 0) {
          return yield* Effect.fail<RecoveryAttentionFactStoreError>({
            _tag: "PersistenceUnavailable",
            repository: "RecoveryAttentionFactStore",
            operation: "submitted-decision-binding",
            retryDisposition: "non-retryable",
            sourceTag: "P41MigrationNotRegistered",
            cause: { _tag: "P41MigrationNotRegistered" },
          });
        }
      });
    const readSubmittedDecisionBindingByTuple = (
      input: RecordSubmittedDecisionBindingFailureInput,
    ) =>
      run(
        sql.unsafe<SubmittedDecisionBindingAttentionDbRow>(
          `SELECT ${submittedDecisionBindingColumns}
               FROM submitted_decision_binding_attention_facts
              WHERE execution_id = ? AND logical_step_no = ?
                AND repair_attempt = ? AND logical_action_id = ?`,
          [
            input.executionId,
            input.logicalStepNo,
            input.repairAttempt,
            input.logicalActionId,
          ],
        ),
      );
    const insertPending = (fact: DeliverReplayAttentionFact) =>
      runDeliver(
        sql.unsafe(
          `INSERT INTO deliver_replay_attention_pending
               (project_id, attention_fact_id, enqueued_at)
             VALUES (?, ?, ?)
             ON CONFLICT(attention_fact_id) DO NOTHING`,
          [fact.projectId, fact.attentionFactId, fact.firstDetectedAt],
        ),
      );
    return {
      sql,
      journal,
      ids,
      run,
      runLegacyAdoption,
      readLegacyAdoptionById,
      assertLegacyAdoptionFence,
      readByTuple,
      runDeliver,
      readDeliverByTuple,
      readDeliverById,
      ensureSubmittedDecisionBindingAvailable,
      readSubmittedDecisionBindingByTuple,
      insertPending,
      qualificationProbe,
    };
  });

export type FactContext = Effect.Success<ReturnType<typeof makeFactContext>>;
