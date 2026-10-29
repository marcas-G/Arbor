import type {
  EventId,
  ExecutionId,
  ProjectId,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import { Actor, parse } from "@arbor/domain";
import {
  Clock,
  DomainEventJournal,
  IdGenerator,
  type RecordToolObservationReplayFailureInput,
  sha256Hex,
  type ToolObservationReplayAttentionFact,
  ToolObservationReplayAttentionFactStore,
  type ToolObservationReplayAttentionFactStoreError,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { repositoryFailure } from "./repository-error.js";

interface FactRow {
  readonly attention_fact_id: string;
  readonly event_id: string;
  readonly project_id: string;
  readonly execution_id: string;
  readonly target_workspace_id: string;
  readonly logical_action_id: string;
  readonly provider_turn_id: string;
  readonly call_ref: string;
  readonly invocation_id: string;
  readonly failure_code: string;
  readonly first_detected_at: string;
}

const toFact = (row: FactRow): ToolObservationReplayAttentionFact => ({
  attentionFactId: row.attention_fact_id,
  eventId: row.event_id as EventId,
  projectId: row.project_id as ProjectId,
  executionId: row.execution_id as ExecutionId,
  targetWorkspaceId: row.target_workspace_id as WorkspaceId,
  logicalActionId: row.logical_action_id,
  providerTurnId: row.provider_turn_id,
  callRef: row.call_ref,
  invocationId: row.invocation_id as ToolInvocationId,
  failureCode:
    row.failure_code as ToolObservationReplayAttentionFact["failureCode"],
  firstDetectedAt: row.first_detected_at,
});

const attentionFactIdOf = (
  input: Pick<
    RecordToolObservationReplayFailureInput,
    "executionId" | "invocationId"
  >,
): string =>
  `att_${sha256Hex(
    JSON.stringify({
      executionId: input.executionId,
      invocationId: input.invocationId,
      version: 1,
    }),
  )}`;

export const ToolObservationReplayAttentionFactStoreLive: Layer.Layer<
  ToolObservationReplayAttentionFactStore,
  never,
  SqlClient | DomainEventJournal | IdGenerator | Clock
> = Layer.effect(
  ToolObservationReplayAttentionFactStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const journal = yield* DomainEventJournal;
    const ids = yield* IdGenerator;
    const clock = yield* Clock;
    const run = <A>(operation: string, effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(
        Effect.mapError(
          repositoryFailure(
            "ToolObservationReplayAttentionFactStore",
            operation,
          ),
        ),
      );

    const checkFence = (
      input: RecordToolObservationReplayFailureInput,
      trustedNow: string,
    ) =>
      Effect.gen(function* () {
        const fence = input.executionFence;
        if (fence.executionId !== input.executionId) {
          return yield* Effect.fail<ToolObservationReplayAttentionFactStoreError>(
            {
              _tag: "LeaseFencingRejected",
              executionId: fence.executionId,
              generation: fence.fencingGeneration,
            },
          );
        }
        const rows = yield* run(
          "fence",
          sql.unsafe<{ readonly ok: number }>(
            `SELECT 1 AS ok
               FROM executions e
               JOIN execution_leases l ON l.execution_id = e.execution_id
              WHERE e.execution_id = ? AND e.project_id = ?
                AND e.workspace_id = ? AND e.settled_at IS NULL
                AND l.worker_id = ? AND l.worker_incarnation_id = ?
                AND l.generation = ? AND l.expires_at > ?`,
            [
              input.executionId,
              input.projectId,
              input.targetWorkspaceId,
              fence.workerId,
              fence.workerIncarnationId,
              fence.fencingGeneration,
              trustedNow,
            ],
          ),
        );
        if (rows.length === 0) {
          return yield* Effect.fail<ToolObservationReplayAttentionFactStoreError>(
            {
              _tag: "LeaseFencingRejected",
              executionId: fence.executionId,
              generation: fence.fencingGeneration,
            },
          );
        }
      });

    const findByTuple = (
      executionId: ExecutionId,
      invocationId: ToolInvocationId,
    ) =>
      run(
        "find-by-tuple",
        sql.unsafe<FactRow>(
          `SELECT attention_fact_id, event_id, project_id, execution_id,
                  target_workspace_id, logical_action_id, provider_turn_id,
                  call_ref, invocation_id, failure_code, first_detected_at
             FROM tool_observation_replay_attention_facts
            WHERE execution_id = ? AND invocation_id = ?`,
          [executionId, invocationId],
        ),
      );

    const readById = (attentionFactId: string) =>
      run(
        "find-by-id",
        sql.unsafe<FactRow>(
          `SELECT attention_fact_id, event_id, project_id, execution_id,
                  target_workspace_id, logical_action_id, provider_turn_id,
                  call_ref, invocation_id, failure_code, first_detected_at
             FROM tool_observation_replay_attention_facts
            WHERE attention_fact_id = ?`,
          [attentionFactId],
        ),
      );

    return ToolObservationReplayAttentionFactStore.of({
      recordFailure: (input) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* checkFence(input, yield* clock.now());
          const expectedId = attentionFactIdOf(input);
          const existing = yield* findByTuple(
            input.executionId,
            input.invocationId,
          );
          if (existing[0] !== undefined) {
            const fact = toFact(existing[0]);
            if (
              fact.attentionFactId !== expectedId ||
              fact.projectId !== input.projectId ||
              fact.targetWorkspaceId !== input.targetWorkspaceId ||
              fact.logicalActionId !== input.logicalActionId ||
              fact.providerTurnId !== input.providerTurnId ||
              fact.callRef !== input.callRef ||
              fact.failureCode !== input.failureCode
            ) {
              return yield* Effect.fail<ToolObservationReplayAttentionFactStoreError>(
                {
                  _tag: "ToolObservationReplayAttentionFactInvariantConflict",
                  reason:
                    "existing tool observation replay fact conflicts with the fenced action tuple",
                },
              );
            }
            yield* checkFence(input, yield* clock.now());
            return fact;
          }

          const events = yield* journal
            .appendReturningIds([
              {
                projectId: input.projectId,
                eventType: "ToolObservationReplayEvidenceEscalated",
                eventVersion: 1,
                occurredAt: input.firstDetectedAt,
                aggregateRef: input.targetWorkspaceId,
                actor: parse(Actor)("system:recovery"),
                correlationRef: input.logicalActionId,
                payload: {
                  attentionFactId: expectedId,
                  executionId: input.executionId,
                  targetWorkspaceId: input.targetWorkspaceId,
                  logicalActionId: input.logicalActionId,
                  providerTurnId: input.providerTurnId,
                  callRef: input.callRef,
                  invocationId: input.invocationId,
                  failureCode: input.failureCode,
                },
              },
            ])
            .pipe(Effect.provideService(IdGenerator, ids));
          const eventId = events[0];
          if (eventId === undefined) {
            return yield* Effect.fail<ToolObservationReplayAttentionFactStoreError>(
              {
                _tag: "ToolObservationReplayAttentionFactInvariantConflict",
                reason:
                  "event journal did not return the tool observation replay event id",
              },
            );
          }
          const writeNow = yield* clock.now();
          const inserted = yield* run(
            "record-failure",
            sql.unsafe<{ readonly attention_fact_id: string }>(
              `INSERT INTO tool_observation_replay_attention_facts (
                attention_fact_id, event_id, project_id, execution_id,
                target_workspace_id, logical_action_id, provider_turn_id,
                call_ref, invocation_id, failure_code, first_detected_at
              ) SELECT ?,?,?,?,?,?,?,?,?,?,?
                 WHERE EXISTS (
                   SELECT 1
                     FROM executions e
                     JOIN execution_leases l ON l.execution_id = e.execution_id
                    WHERE e.execution_id = ? AND e.project_id = ?
                      AND e.workspace_id = ? AND e.settled_at IS NULL
                      AND l.worker_id = ? AND l.worker_incarnation_id = ?
                      AND l.generation = ? AND l.expires_at > ?
                 )
              RETURNING attention_fact_id`,
              [
                expectedId,
                eventId,
                input.projectId,
                input.executionId,
                input.targetWorkspaceId,
                input.logicalActionId,
                input.providerTurnId,
                input.callRef,
                input.invocationId,
                input.failureCode,
                input.firstDetectedAt,
                input.executionId,
                input.projectId,
                input.targetWorkspaceId,
                input.executionFence.workerId,
                input.executionFence.workerIncarnationId,
                input.executionFence.fencingGeneration,
                writeNow,
              ],
            ),
          );
          if (inserted.length !== 1) {
            return yield* Effect.fail<ToolObservationReplayAttentionFactStoreError>(
              {
                _tag: "LeaseFencingRejected",
                executionId: input.executionFence.executionId,
                generation: input.executionFence.fencingGeneration,
              },
            );
          }
          return {
            projectId: input.projectId,
            executionId: input.executionId,
            targetWorkspaceId: input.targetWorkspaceId,
            logicalActionId: input.logicalActionId,
            providerTurnId: input.providerTurnId,
            callRef: input.callRef,
            invocationId: input.invocationId,
            failureCode: input.failureCode,
            firstDetectedAt: input.firstDetectedAt,
            attentionFactId: expectedId,
            eventId,
          };
        }),
      findById: (attentionFactId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* readById(attentionFactId);
          return rows[0] === undefined
            ? Option.none()
            : Option.some(toFact(rows[0]));
        }),
    });
  }),
);
