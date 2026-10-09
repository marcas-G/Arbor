import { Actor, parse } from "@arbor/domain";
import type {
  AssignWorkBindingAttentionFact,
  AssignWorkBindingFailureCode,
  RecordAssignWorkBindingFailureInput,
  RecoveryAttentionFactStoreError,
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
import { repositoryFailure } from "./repository-error.js";

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
      return RecoveryAttentionFactStore.of({
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
      });
    }),
  );

export const RecoveryAttentionFactStoreLive =
  makeRecoveryAttentionFactStoreLive();
