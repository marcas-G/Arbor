import {
  Actor,
  parse,
} from "@arbor/domain";
import type {
  DeliverReplayAttentionFact,
  RecoveryAttentionFactStoreError,
} from "@arbor/ports";
import {
  IdGenerator,
  sha256Hex,
  TransactionScope,
} from "@arbor/ports";
import {
  Effect,
  Option,
} from "effect";
import type { RecoveryAttentionFactStoreService } from "@arbor/ports";
import {
  type DeliverReplayRow,
  toDeliverReplayFact,
  DELIVER_REPLAY_COLUMNS,
} from "./row-codecs.js";
import type { FactContext } from "./context.js";

export const makeDeliverReplayFacts = (context: FactContext): Pick<RecoveryAttentionFactStoreService, "recordDeliverReplayFailure" | "findDeliverReplayFailure" | "findDeliverReplayFailureByEventId" | "listDeliverReplayFailures" | "listPendingDeliverReplayAttention" | "acknowledgePendingDeliverReplayAttention"> => {
  const { sql, journal, ids, runDeliver, readDeliverByTuple, readDeliverById, insertPending } = context;
  return {
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
  };
};
