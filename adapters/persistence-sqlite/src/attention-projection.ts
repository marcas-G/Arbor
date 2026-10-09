import type { DomainEvent, ProjectId } from "@arbor/domain";
import {
  type AssignWorkBindingAttentionFact,
  type AssignWorkBindingAttentionProjectionRow,
  AttentionProjectionStore,
  type AttentionProjectionStoreError,
  type AttentionProjectionStoreService,
  type ConsumerOffsetStoreError,
  type ProjectionStoreService,
  type RecoveryAttentionFactStoreService,
  TransactionScope,
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
}

export interface AttentionProjectionQualificationEvent {
  readonly boundary: "P10AfterAttentionRowWriteBeforeConsumerCommit";
  readonly projectId: ProjectId;
  readonly attentionFactId: string;
}

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
      return AttentionProjectionStore.of({
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
        listAssignWorkBindingFailures: (projectId) =>
          Effect.map(
            run(
              sql.unsafe<AttentionProjectionDbRow>(
                `SELECT project_id, dedup_key, source, severity,
                      target_workspace_id, summary, failure_code, occurred_at,
                      source_event_id, source_fact_id
                 FROM attention_projection_rows
                WHERE project_id = ? ORDER BY occurred_at, dedup_key`,
                [projectId],
              ),
            ),
            (rows) => rows.map(fromDb),
          ),
        resetProject: (projectId) =>
          Effect.asVoid(
            run(
              sql.unsafe(
                "DELETE FROM attention_projection_rows WHERE project_id = ?",
                [projectId],
              ),
            ),
          ),
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
    "findAssignWorkBindingFailure"
  >,
  attentionRows: Pick<
    AttentionProjectionStoreService,
    "putAssignWorkBindingFailure" | "resetProject"
  >,
): ProjectionStoreService => ({
  apply: (batch: ReadonlyArray<DomainEvent<unknown>>) =>
    Effect.gen(function* () {
      for (const event of batch) {
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
        if (
          fact.eventId !== event.eventId ||
          fact.projectId !== projectId ||
          event.aggregateRef !== fact.targetWorkspaceId ||
          event.correlationRef !== fact.logicalActionId ||
          event.causedByCommandId !== fact.committedCommandId ||
          event.occurredAt !== fact.firstDetectedAt ||
          fact.executionId !== String(payload.executionId ?? "") ||
          fact.targetWorkspaceId !== String(payload.targetWorkspaceId ?? "") ||
          fact.logicalActionId !== String(payload.logicalActionId ?? "") ||
          fact.committedCommandId !==
            String(payload.committedCommandId ?? "") ||
          fact.failureCode !== String(payload.failureCode ?? "")
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
    attentionRows
      .resetProject(projectId)
      .pipe(Effect.mapError(projectionFailure)),
});
