import { Actor, parse } from "@arbor/domain";
import type {
  AssignWorkBindingAttentionFact,
  AssignWorkBindingFailureCode,
  DeliverReplayAttentionFact,
  DeliverReplayFailureCode,
  RecordAssignWorkBindingFailureInput,
  RecordDeliverReplayFailureInput,
  RecordSubmittedDecisionBindingFailureInput,
  RecoveryAttentionFactStoreError,
  SubmittedDecisionBindingAttentionFact,
} from "@arbor/ports";
import {
  DomainEventJournal,
  IdGenerator,
  RecoveryAttentionFactStore,
  sha256Hex,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  persistenceCorruption,
  repositoryFailure,
} from "./repository-error.js";
import {
  decodeSubmittedDecisionBindingAttentionFactRow,
  type SubmittedDecisionBindingAttentionDbRow,
} from "./submitted-decision-binding-attention-codec.js";

interface Row {
  readonly attention_fact_id: string;
  readonly event_id: string;
  readonly project_id: string;
  readonly execution_id: string;
  readonly target_workspace_id: string;
  readonly logical_action_id: string;
  readonly committed_command_id: string;
  readonly failure_code: string;
  readonly first_detected_at: string;
}

interface DeliverReplayRow {
  readonly attention_fact_id: string;
  readonly event_id: string;
  readonly project_id: string;
  readonly execution_id: string;
  readonly target_workspace_id: string;
  readonly logical_action_id: string;
  readonly message_id: string;
  readonly failure_code: string;
  readonly first_detected_at: string;
}

const submittedDecisionBindingColumns = `attention_fact_id, event_id, project_id,
  execution_id, workspace_id, logical_step_no, repair_attempt,
  provider_turn_id, logical_action_id, failure_code, first_detected_at`;

const decodeSubmittedDecisionBindingFact = (
  row: SubmittedDecisionBindingAttentionDbRow,
): Effect.Effect<
  SubmittedDecisionBindingAttentionFact,
  RecoveryAttentionFactStoreError
> => {
  const fact = decodeSubmittedDecisionBindingAttentionFactRow(row);
  return fact === undefined
    ? Effect.fail(
        persistenceCorruption(
          "RecoveryAttentionFactStore",
          "submitted-decision-binding-read",
          "stored Submitted DecisionEpisode binding fact violates its closed physical codec",
        ),
      )
    : Effect.succeed(fact);
};

const factsAreEqual = (
  left: SubmittedDecisionBindingAttentionFact,
  right: SubmittedDecisionBindingAttentionFact,
): boolean =>
  left.attentionFactId === right.attentionFactId &&
  left.eventId === right.eventId &&
  left.projectId === right.projectId &&
  left.executionId === right.executionId &&
  left.workspaceId === right.workspaceId &&
  left.logicalStepNo === right.logicalStepNo &&
  left.repairAttempt === right.repairAttempt &&
  left.providerTurnId === right.providerTurnId &&
  left.logicalActionId === right.logicalActionId &&
  left.failureCode === right.failureCode &&
  left.firstDetectedAt === right.firstDetectedAt;

export interface RecoveryAttentionFactQualificationEvent {
  readonly boundary:
    | "AH10BeforeAssignWorkBindingAttentionCommit"
    | "AH10AfterAssignWorkBindingAttentionCommit";
  readonly executionId: string;
  readonly logicalActionId: string;
  readonly committedCommandId: string;
}

export type RecoveryAttentionFactQualificationProbe = (
  event: RecoveryAttentionFactQualificationEvent,
) => Promise<void>;

const toFact = (row: Row): AssignWorkBindingAttentionFact => ({
  attentionFactId: row.attention_fact_id,
  eventId: row.event_id as never,
  projectId: row.project_id as never,
  executionId: row.execution_id as never,
  targetWorkspaceId: row.target_workspace_id as never,
  logicalActionId: row.logical_action_id,
  committedCommandId: row.committed_command_id as never,
  failureCode: row.failure_code as AssignWorkBindingFailureCode,
  firstDetectedAt: row.first_detected_at,
});

const toDeliverReplayFact = (
  row: DeliverReplayRow,
): DeliverReplayAttentionFact => ({
  attentionFactId: row.attention_fact_id,
  eventId: row.event_id,
  projectId: row.project_id as never,
  executionId: row.execution_id as never,
  targetWorkspaceId: row.target_workspace_id as never,
  logicalActionId: row.logical_action_id,
  messageId: row.message_id,
  failureCode: row.failure_code as DeliverReplayFailureCode,
  firstDetectedAt: row.first_detected_at,
});

const DELIVER_REPLAY_COLUMNS = `attention_fact_id, event_id, project_id,
  execution_id, target_workspace_id, logical_action_id, message_id,
  failure_code, first_detected_at`;

export const makeRecoveryAttentionFactStoreLive = (
  qualificationProbe?: RecoveryAttentionFactQualificationProbe,
): Layer.Layer<
  RecoveryAttentionFactStore,
  never,
  SqlClient | DomainEventJournal | IdGenerator
> =>
  Layer.effect(
    RecoveryAttentionFactStore,
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
      const readByTuple = (input: RecordAssignWorkBindingFailureInput) =>
        run(
          sql.unsafe<Row>(
            `SELECT attention_fact_id, event_id, project_id, execution_id,
                  target_workspace_id, logical_action_id, committed_command_id,
                  failure_code, first_detected_at
             FROM assign_work_binding_attention_facts
            WHERE execution_id = ? AND logical_action_id = ? AND committed_command_id = ?`,
            [
              input.executionId,
              input.logicalActionId,
              input.committedCommandId,
            ],
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
      return RecoveryAttentionFactStore.of({
        isSubmittedDecisionBindingAvailable: () =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const tables = yield* run(
              sql.unsafe<{ readonly name: string }>(
                `SELECT name FROM sqlite_master
                  WHERE type = 'table'
                    AND name = 'submitted_decision_binding_attention_facts'`,
              ),
            );
            return tables.length > 0;
          }),
        recordAssignWorkBindingFailure: (input) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const attentionFactId = `att_${sha256Hex(
              JSON.stringify({
                version: 1,
                executionId: input.executionId,
                logicalActionId: input.logicalActionId,
                committedCommandId: input.committedCommandId,
              }),
            )}`;
            const prior = yield* readByTuple(input);
            if (prior[0] !== undefined) {
              const fact = toFact(prior[0]);
              if (
                fact.projectId !== input.projectId ||
                fact.targetWorkspaceId !== input.targetWorkspaceId ||
                fact.attentionFactId !== attentionFactId
              ) {
                return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                  _tag: "RecoveryAttentionFactInvariantConflict",
                  reason:
                    "existing AssignWork binding fact has a conflicting identity",
                });
              }
              return fact;
            }
            const events = yield* journal
              .appendReturningIds([
                {
                  projectId: input.projectId,
                  eventType: "AssignWorkTargetBindingEscalated",
                  eventVersion: 1,
                  occurredAt: input.firstDetectedAt,
                  aggregateRef: input.targetWorkspaceId,
                  actor: parse(Actor)("system:recovery"),
                  causedByCommandId: input.committedCommandId,
                  correlationRef: input.logicalActionId,
                  payload: {
                    attentionFactId,
                    executionId: input.executionId,
                    targetWorkspaceId: input.targetWorkspaceId,
                    logicalActionId: input.logicalActionId,
                    committedCommandId: input.committedCommandId,
                    failureCode: input.failureCode,
                  },
                },
              ])
              .pipe(Effect.provideService(IdGenerator, ids));
            const eventId = events[0];
            if (eventId === undefined) {
              return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                _tag: "RecoveryAttentionFactInvariantConflict",
                reason:
                  "event journal did not return the AssignWork binding event id",
              });
            }
            yield* run(
              sql.unsafe(
                `INSERT INTO assign_work_binding_attention_facts (
                attention_fact_id, event_id, project_id, execution_id,
                target_workspace_id, logical_action_id, committed_command_id,
                failure_code, first_detected_at
              ) VALUES (?,?,?,?,?,?,?,?,?)`,
                [
                  attentionFactId,
                  eventId,
                  input.projectId,
                  input.executionId,
                  input.targetWorkspaceId,
                  input.logicalActionId,
                  input.committedCommandId,
                  input.failureCode,
                  input.firstDetectedAt,
                ],
              ),
            );
            if (qualificationProbe !== undefined) {
              yield* Effect.promise(() =>
                qualificationProbe({
                  boundary: "AH10BeforeAssignWorkBindingAttentionCommit",
                  executionId: input.executionId,
                  logicalActionId: input.logicalActionId,
                  committedCommandId: input.committedCommandId,
                }),
              );
            }
            return {
              ...input,
              attentionFactId,
              eventId,
            };
          }),
        findAssignWorkBindingFailure: (attentionFactId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* run(
              sql.unsafe<Row>(
                `SELECT attention_fact_id, event_id, project_id, execution_id,
                      target_workspace_id, logical_action_id, committed_command_id,
                      failure_code, first_detected_at
                 FROM assign_work_binding_attention_facts WHERE attention_fact_id = ?`,
                [attentionFactId],
              ),
            );
            return rows[0] === undefined
              ? Option.none()
              : Option.some(toFact(rows[0]));
          }),
        recordDeliverReplayFailure: (input) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const attentionFactId = `att_${sha256Hex(
              JSON.stringify({
                version: 1,
                executionId: input.executionId,
                logicalActionId: input.logicalActionId,
                messageId: input.messageId,
              }),
            )}`;
            const prior = yield* readDeliverByTuple(input);
            if (prior[0] !== undefined) {
              const fact = toDeliverReplayFact(prior[0]);
              if (
                fact.projectId !== input.projectId ||
                fact.targetWorkspaceId !== input.targetWorkspaceId ||
                fact.attentionFactId !== attentionFactId
              ) {
                return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                  _tag: "RecoveryAttentionFactInvariantConflict",
                  reason:
                    "existing Deliver replay fact has a conflicting identity",
                });
              }
              yield* insertPending(fact);
              return fact;
            }

            const payload = {
              attentionFactId,
              executionId: input.executionId,
              targetWorkspaceId: input.targetWorkspaceId,
              logicalActionId: input.logicalActionId,
              messageId: input.messageId,
              failureCode: input.failureCode,
            };
            const events = yield* journal
              .appendReturningIds([
                {
                  projectId: input.projectId,
                  eventType: "DeliverReplayEscalated",
                  eventVersion: 1,
                  occurredAt: input.firstDetectedAt,
                  aggregateRef: input.targetWorkspaceId,
                  actor: parse(Actor)("system:recovery"),
                  ...(input.causedByCommandId === undefined
                    ? {}
                    : { causedByCommandId: input.causedByCommandId }),
                  correlationRef: input.logicalActionId,
                  payload,
                },
              ])
              .pipe(Effect.provideService(IdGenerator, ids));
            const eventId = events[0];
            if (eventId === undefined) {
              return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                _tag: "RecoveryAttentionFactInvariantConflict",
                reason:
                  "event journal did not return the Deliver replay event id",
              });
            }
            const witnesses = yield* runDeliver(
              sql.unsafe<{
                readonly project_id: string;
                readonly event_type: string;
                readonly event_version: number;
                readonly occurred_at: string;
                readonly aggregate_ref: string;
                readonly actor: string;
                readonly caused_by_command_id: string | null;
                readonly caused_by_event_id: string | null;
                readonly correlation_ref: string | null;
                readonly payload_json: string;
              }>(
                `SELECT project_id, event_type, event_version, occurred_at,
                        aggregate_ref, actor, caused_by_command_id,
                        caused_by_event_id, correlation_ref, payload_json
                   FROM domain_events WHERE event_id = ?`,
                [eventId],
              ),
            );
            const witness = witnesses[0];
            if (
              witness === undefined ||
              witness.project_id !== input.projectId ||
              witness.event_type !== "DeliverReplayEscalated" ||
              Number(witness.event_version) !== 1 ||
              witness.occurred_at !== input.firstDetectedAt ||
              witness.aggregate_ref !== input.targetWorkspaceId ||
              witness.actor !== "system:recovery" ||
              witness.caused_by_command_id !==
                (input.causedByCommandId ?? null) ||
              witness.caused_by_event_id !== null ||
              witness.correlation_ref !== input.logicalActionId ||
              witness.payload_json !== JSON.stringify(payload)
            ) {
              return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                _tag: "RecoveryAttentionFactInvariantConflict",
                reason:
                  "stored Deliver replay event witness conflicts with its fact",
              });
            }
            const fact: DeliverReplayAttentionFact = {
              attentionFactId,
              eventId,
              projectId: input.projectId,
              executionId: input.executionId,
              targetWorkspaceId: input.targetWorkspaceId,
              logicalActionId: input.logicalActionId,
              messageId: input.messageId,
              failureCode: input.failureCode,
              firstDetectedAt: input.firstDetectedAt,
            };
            yield* runDeliver(
              sql.unsafe(
                `INSERT INTO deliver_replay_attention_facts (
                   attention_fact_id, event_id, project_id, execution_id,
                   target_workspace_id, logical_action_id, message_id,
                   failure_code, first_detected_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  attentionFactId,
                  eventId,
                  input.projectId,
                  input.executionId,
                  input.targetWorkspaceId,
                  input.logicalActionId,
                  input.messageId,
                  input.failureCode,
                  input.firstDetectedAt,
                ],
              ),
            );
            yield* insertPending(fact);
            return fact;
          }),
        findDeliverReplayFailure: (attentionFactId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* readDeliverById(attentionFactId);
            return rows[0] === undefined
              ? Option.none()
              : Option.some(toDeliverReplayFact(rows[0]));
          }),
        findDeliverReplayFailureByEventId: (eventId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* runDeliver(
              sql.unsafe<DeliverReplayRow>(
                `SELECT ${DELIVER_REPLAY_COLUMNS}
                   FROM deliver_replay_attention_facts WHERE event_id = ?`,
                [eventId],
              ),
            );
            return rows[0] === undefined
              ? Option.none()
              : Option.some(toDeliverReplayFact(rows[0]));
          }),
        listDeliverReplayFailures: (projectId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* runDeliver(
              sql.unsafe<DeliverReplayRow>(
                `SELECT ${DELIVER_REPLAY_COLUMNS}
                   FROM deliver_replay_attention_facts
                  WHERE project_id = ?
                  ORDER BY first_detected_at, attention_fact_id`,
                [projectId],
              ),
            );
            return rows.map(toDeliverReplayFact);
          }),
        listPendingDeliverReplayAttention: (projectId, limit) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const columns = DELIVER_REPLAY_COLUMNS.split(", ")
              .map((column) => `fact.${column}`)
              .join(", ");
            const rows = yield* runDeliver(
              sql.unsafe<DeliverReplayRow>(
                `SELECT ${columns}
                   FROM deliver_replay_attention_pending AS pending
                   JOIN deliver_replay_attention_facts AS fact
                     ON fact.attention_fact_id = pending.attention_fact_id
                    AND fact.project_id = pending.project_id
                  WHERE pending.project_id = ?
                  ORDER BY pending.queue_sequence
                  LIMIT ?`,
                [projectId, Math.max(0, Math.trunc(limit))],
              ),
            );
            return rows.map(toDeliverReplayFact);
          }),
        acknowledgePendingDeliverReplayAttention: (attentionFactId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const marker = yield* runDeliver(
              sql.unsafe<{ readonly present: number }>(
                `SELECT 1 AS present FROM deliver_replay_attention_rows
                  WHERE attention_fact_id = ?`,
                [attentionFactId],
              ),
            );
            if (marker[0] === undefined) {
              return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                _tag: "RecoveryAttentionFactInvariantConflict",
                reason: "Deliver replay queue ACK requires its P10 marker",
              });
            }
            yield* runDeliver(
              sql.unsafe(
                "DELETE FROM deliver_replay_attention_pending WHERE attention_fact_id = ?",
                [attentionFactId],
              ),
            );
          }),
        recordSubmittedDecisionBindingFailure: (input) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            yield* ensureSubmittedDecisionBindingAvailable();
            const validInput = decodeSubmittedDecisionBindingAttentionFactRow({
              attention_fact_id: input.attentionFactId,
              event_id: input.eventId,
              project_id: input.projectId,
              execution_id: input.executionId,
              workspace_id: input.workspaceId,
              logical_step_no: input.logicalStepNo,
              repair_attempt: input.repairAttempt,
              provider_turn_id: input.providerTurnId,
              logical_action_id: input.logicalActionId,
              failure_code: input.failureCode,
              first_detected_at: input.firstDetectedAt,
            });
            if (validInput === undefined) {
              return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                _tag: "RecoveryAttentionFactInvariantConflict",
                reason:
                  "submitted DecisionEpisode fact input violates its closed physical codec",
              });
            }
            const prior = yield* readSubmittedDecisionBindingByTuple(input);
            if (prior[0] !== undefined) {
              const fact = yield* decodeSubmittedDecisionBindingFact(prior[0]);
              if (!factsAreEqual(fact, validInput)) {
                return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                  _tag: "RecoveryAttentionFactInvariantConflict",
                  reason:
                    "existing Submitted DecisionEpisode binding fact conflicts with its immutable tuple",
                });
              }
              return fact;
            }
            yield* run(
              sql.unsafe(
                `INSERT INTO submitted_decision_binding_attention_facts (
                   attention_fact_id, event_id, project_id, execution_id,
                   workspace_id, logical_step_no, repair_attempt,
                   provider_turn_id, logical_action_id, failure_code,
                   first_detected_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  validInput.attentionFactId,
                  validInput.eventId,
                  validInput.projectId,
                  validInput.executionId,
                  validInput.workspaceId,
                  validInput.logicalStepNo,
                  validInput.repairAttempt,
                  validInput.providerTurnId,
                  validInput.logicalActionId,
                  validInput.failureCode,
                  validInput.firstDetectedAt,
                ],
              ),
            );
            return validInput;
          }),
        findSubmittedDecisionBindingFailure: (attentionFactId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            yield* ensureSubmittedDecisionBindingAvailable();
            const rows = yield* run(
              sql.unsafe<SubmittedDecisionBindingAttentionDbRow>(
                `SELECT ${submittedDecisionBindingColumns}
                   FROM submitted_decision_binding_attention_facts
                  WHERE attention_fact_id = ?`,
                [attentionFactId],
              ),
            );
            return rows[0] === undefined
              ? Option.none()
              : Option.some(yield* decodeSubmittedDecisionBindingFact(rows[0]));
          }),
        listSubmittedDecisionBindingFailures: (projectId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            yield* ensureSubmittedDecisionBindingAvailable();
            const rows = yield* run(
              sql.unsafe<SubmittedDecisionBindingAttentionDbRow>(
                `SELECT ${submittedDecisionBindingColumns}
                   FROM submitted_decision_binding_attention_facts
                  WHERE project_id = ?
                  ORDER BY first_detected_at, attention_fact_id`,
                [projectId],
              ),
            );
            const facts: SubmittedDecisionBindingAttentionFact[] = [];
            for (const row of rows) {
              facts.push(yield* decodeSubmittedDecisionBindingFact(row));
            }
            return facts;
          }),
      });
    }),
  );

export const RecoveryAttentionFactStoreLive =
  makeRecoveryAttentionFactStoreLive();
