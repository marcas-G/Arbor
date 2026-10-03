import type {
  Execution,
  ExecutionBinding,
  ExecutionEpisodeBinding,
  ExecutionId,
  ExecutionSettlement,
  ExecutionState,
  ProjectId,
  SessionId,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import {
  Clock,
  ExecutionRepository,
  type LeaseRecord,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { repositoryFailure } from "./repository-error.js";

interface ExecutionRow {
  readonly execution_id: string;
  readonly project_id: string;
  readonly binding_kind: string;
  readonly workspace_id: string;
  readonly focus_kind?: string | null;
  readonly focus_work_id?: string | null;
  readonly episode_kind?: string | null;
  readonly episode_ref?: string | null;
  readonly episode_revision?: number | null;
  readonly parent_execution_id: string | null;
  readonly mission: string | null;
  readonly session_id: string;
  readonly admitted_at: string;
  readonly stop_requested_at: string | null;
  readonly settlement_kind: string | null;
  readonly settlement_json: string | null;
  readonly settled_at: string | null;
}

interface LeaseRow {
  readonly execution_id: string;
  readonly worker_id: string;
  readonly worker_incarnation_id: string;
  readonly generation: number;
  readonly expires_at: string;
  readonly updated_at: string;
}

const toExecution = (row: ExecutionRow): Execution => {
  const episode = episodeOfRow(row);
  const compatibilityFocus =
    episode?._tag === "WorkEpisode"
      ? { _tag: "Work" as const, workId: episode.workId }
      : row.focus_kind === "work"
        ? { _tag: "Work" as const, workId: row.focus_work_id as WorkId }
        : { _tag: "Coordination" as const };
  const binding: ExecutionBinding =
    row.binding_kind === "workspace"
      ? episode === undefined
        ? {
            _tag: "WorkspaceExecution",
            workspaceId: row.workspace_id as WorkspaceId,
            focus: compatibilityFocus,
          }
        : {
            _tag: "WorkspaceExecution",
            workspaceId: row.workspace_id as WorkspaceId,
            episode,
          }
      : {
          _tag: "ExecutionBoundAgentBinding",
          parentExecutionId: row.parent_execution_id as ExecutionId | null,
          mission: row.mission ?? "",
        };
  const state: ExecutionState =
    row.settled_at === null
      ? { status: "Active", settlement: null }
      : {
          status: "Settled",
          settlement: JSON.parse(
            row.settlement_json ?? "null",
          ) as ExecutionSettlement,
        };
  return {
    executionId: row.execution_id as ExecutionId,
    projectId: row.project_id as ProjectId,
    workspaceId: row.workspace_id as WorkspaceId,
    binding,
    sessionId: row.session_id as SessionId,
    admittedAt: row.admitted_at,
    stopRequestedAt: row.stop_requested_at,
    state,
  };
};

const episodeOfRow = (
  row: ExecutionRow,
): ExecutionEpisodeBinding | undefined => {
  const revision = Number(row.episode_revision ?? 0);
  switch (row.episode_kind) {
    case "WorkEpisode":
      return row.episode_ref == null
        ? undefined
        : {
            _tag: "WorkEpisode",
            workId: row.episode_ref as WorkId,
            targetWorkRevision: revision as never,
          };
    case "ConversationResponseEpisode":
      return row.episode_ref == null
        ? undefined
        : {
            _tag: "ConversationResponseEpisode",
            messageId: row.episode_ref as never,
            responseJobRevision: revision,
          };
    case "InboxEpisode":
      return row.episode_ref == null
        ? undefined
        : {
            _tag: "InboxEpisode",
            entryKey: row.episode_ref,
            inputKind: "LegacyMigrated",
          };
    case "DecisionEpisode":
      return row.episode_ref == null
        ? undefined
        : {
            _tag: "DecisionEpisode",
            decisionId: row.episode_ref as never,
            decisionKind: "SelectCurrentWork",
            requestRevision: revision,
          };
    default:
      return undefined;
  }
};

const toLease = (row: LeaseRow): LeaseRecord => ({
  executionId: row.execution_id as ExecutionId,
  workerId: row.worker_id,
  workerIncarnationId: row.worker_incarnation_id,
  generation: Number(row.generation) as LeaseRecord["generation"],
  expiresAt: row.expires_at,
  updatedAt: row.updated_at,
});

const insertSql =
  "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at, episode_kind, episode_ref, episode_revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";

const legacyInsertSql =
  "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)";

const episodeOnlyInsertSql =
  "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, episode_kind, episode_ref, episode_revision, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";

const insertParams = (execution: Execution): ReadonlyArray<unknown> => {
  const binding = execution.binding;
  const isWorkspace = binding._tag === "WorkspaceExecution";
  const episode = isWorkspace ? binding.episode : undefined;
  return [
    execution.executionId,
    execution.projectId,
    isWorkspace ? "workspace" : "execution_bound",
    execution.workspaceId,
    isWorkspace
      ? binding.episode?._tag === "WorkEpisode"
        ? "work"
        : binding.episode === undefined
          ? binding.focus._tag.toLowerCase()
          : "coordination"
      : null,
    isWorkspace
      ? binding.episode?._tag === "WorkEpisode"
        ? binding.episode.workId
        : binding.episode === undefined && binding.focus._tag === "Work"
          ? binding.focus.workId
          : null
      : null,
    isWorkspace ? null : binding.parentExecutionId,
    isWorkspace ? null : binding.mission,
    execution.sessionId,
    execution.admittedAt,
    execution.stopRequestedAt,
    null,
    null,
    null,
    episode?._tag ?? null,
    episode === undefined
      ? null
      : episode._tag === "WorkEpisode"
        ? episode.workId
        : episode._tag === "ConversationResponseEpisode"
          ? episode.messageId
          : episode._tag === "InboxEpisode"
            ? episode.entryKey
            : episode.decisionId,
    episode === undefined
      ? null
      : episode._tag === "WorkEpisode"
        ? episode.targetWorkRevision
        : episode._tag === "ConversationResponseEpisode"
          ? episode.responseJobRevision
          : episode._tag === "DecisionEpisode"
            ? episode.requestRevision
            : 0,
  ];
};

const episodeOnlyInsertParams = (
  execution: Execution,
): ReadonlyArray<unknown> => {
  const binding = execution.binding;
  const isWorkspace = binding._tag === "WorkspaceExecution";
  const episode = isWorkspace ? binding.episode : undefined;
  if (isWorkspace && episode === undefined) {
    throw new Error(
      "new Workspace execution requires an exact ExecutionEpisodeBinding",
    );
  }
  const episodeRef =
    episode === undefined
      ? null
      : episode._tag === "WorkEpisode"
        ? episode.workId
        : episode._tag === "ConversationResponseEpisode"
          ? episode.messageId
          : episode._tag === "InboxEpisode"
            ? episode.entryKey
            : episode.decisionId;
  const episodeRevision =
    episode === undefined
      ? null
      : episode._tag === "WorkEpisode"
        ? episode.targetWorkRevision
        : episode._tag === "ConversationResponseEpisode"
          ? episode.responseJobRevision
          : episode._tag === "DecisionEpisode"
            ? episode.requestRevision
            : 0;
  return [
    execution.executionId,
    execution.projectId,
    isWorkspace ? "workspace" : "execution_bound",
    execution.workspaceId,
    episode?._tag ?? null,
    episodeRef,
    episodeRevision,
    isWorkspace ? null : binding.parentExecutionId,
    isWorkspace ? null : binding.mission,
    execution.sessionId,
    execution.admittedAt,
    execution.stopRequestedAt,
    null,
    null,
    null,
  ];
};

export const ExecutionRepositoryLive: Layer.Layer<
  ExecutionRepository,
  never,
  SqlClient | Clock
> = Layer.effect(
  ExecutionRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const clock = yield* Clock;
    const failure = repositoryFailure("ExecutionRepository", "execution");
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    const insertExecution = (execution: Execution) =>
      Effect.gen(function* () {
        const columns = yield* sql.unsafe<{ name: string }>(
          "PRAGMA table_info(executions)",
        );
        const parameters = insertParams(execution);
        const hasEpisode = columns.some(
          (column) => column.name === "episode_kind",
        );
        const hasLegacyFocus = columns.some(
          (column) => column.name === "focus_kind",
        );
        if (hasEpisode && !hasLegacyFocus) {
          yield* sql.unsafe(
            episodeOnlyInsertSql,
            episodeOnlyInsertParams(execution),
          );
        } else if (hasEpisode) {
          yield* sql.unsafe(insertSql, parameters);
        } else {
          yield* sql.unsafe(legacyInsertSql, parameters.slice(0, 14));
        }
      });
    return ExecutionRepository.of({
      tryAdmitMainExecution: (execution) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const existing = yield* run(
            sql.unsafe<{ ok: number }>(
              "SELECT 1 AS ok FROM executions WHERE workspace_id = ? AND binding_kind = 'workspace' AND settled_at IS NULL",
              [
                execution.binding._tag === "WorkspaceExecution"
                  ? execution.binding.workspaceId
                  : "",
              ],
            ),
          );
          if (existing.length > 0) {
            return Option.none();
          }
          yield* run(insertExecution(execution));
          return Option.some(execution);
        }),
      admitExecution: (execution) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(insertExecution(execution));
        }),
      findById: (executionId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<ExecutionRow>(
              "SELECT * FROM executions WHERE execution_id = ?",
              [executionId],
            ),
          );
          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some(toExecution(row));
        }),
      findActiveMainByWorkspace: (workspaceId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<ExecutionRow>(
              "SELECT * FROM executions WHERE workspace_id = ? AND binding_kind = 'workspace' AND settled_at IS NULL",
              [workspaceId],
            ),
          );
          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some(toExecution(row));
        }),
      requestStop: (executionId, stopRequestedAt) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(
            sql.unsafe(
              "UPDATE executions SET stop_requested_at = COALESCE(stop_requested_at, ?) WHERE execution_id = ?",
              [stopRequestedAt, executionId],
            ),
          );
        }),
      settle: (executionId, settlement, settledAt) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(
            sql.unsafe(
              "UPDATE executions SET settlement_kind = ?, settlement_json = ?, settled_at = ? WHERE execution_id = ? AND settled_at IS NULL RETURNING execution_id",
              [
                settlement._tag,
                JSON.stringify(settlement),
                settledAt,
                executionId,
              ],
            ),
          );
        }),
      currentLease: (executionId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<LeaseRow>(
              "SELECT * FROM execution_leases WHERE execution_id = ?",
              [executionId],
            ),
          );
          const row = rows[0];
          return row === undefined ? Option.none() : Option.some(toLease(row));
        }),
      tryAcquireLease: (
        executionId,
        workerId,
        workerIncarnationId,
        expiresAt,
      ) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = yield* clock.now();
          const rows = yield* run(
            sql.unsafe<{ generation: number }>(
              "INSERT INTO execution_leases (execution_id, worker_id, worker_incarnation_id, generation, expires_at, updated_at) VALUES (?, ?, ?, COALESCE((SELECT MAX(generation) + 1 FROM execution_leases WHERE execution_id = ?), 0), ?, ?) ON CONFLICT(execution_id) DO UPDATE SET worker_id = excluded.worker_id, worker_incarnation_id = excluded.worker_incarnation_id, generation = excluded.generation, expires_at = excluded.expires_at, updated_at = excluded.updated_at WHERE execution_leases.expires_at <= ? RETURNING generation",
              [
                executionId,
                workerId,
                workerIncarnationId,
                executionId,
                expiresAt,
                now,
                now,
              ],
            ),
          );
          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some({
                executionId,
                workerId,
                workerIncarnationId,
                generation: Number(row.generation) as LeaseRecord["generation"],
                expiresAt,
                updatedAt: now,
              });
        }),
      renewLease: (
        executionId,
        workerId,
        workerIncarnationId,
        generation,
        expiresAt,
      ) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = yield* clock.now();
          const rows = yield* run(
            sql.unsafe<{ generation: number }>(
              "UPDATE execution_leases SET expires_at = ?, updated_at = ? WHERE execution_id = ? AND worker_id = ? AND worker_incarnation_id = ? AND generation = ? RETURNING generation",
              [
                expiresAt,
                now,
                executionId,
                workerId,
                workerIncarnationId,
                generation,
              ],
            ),
          );
          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some({
                executionId,
                workerId,
                workerIncarnationId,
                generation: Number(row.generation) as LeaseRecord["generation"],
                expiresAt,
                updatedAt: now,
              });
        }),
      releaseLease: (executionId, workerId, workerIncarnationId, generation) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = yield* clock.now();
          yield* run(
            sql.unsafe(
              "UPDATE execution_leases SET expires_at = ?, updated_at = ? WHERE execution_id = ? AND worker_id = ? AND worker_incarnation_id = ? AND generation = ?",
              [
                now,
                now,
                executionId,
                workerId,
                workerIncarnationId,
                generation,
              ],
            ),
          );
        }),
      findExpiredActiveExecutions: (now) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<ExecutionRow>(
              "SELECT e.* FROM executions e JOIN execution_leases l ON l.execution_id = e.execution_id WHERE e.settled_at IS NULL AND l.expires_at <= ?",
              [now],
            ),
          );
          return rows.map(toExecution);
        }),
      findUnsettledExecutions: () =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<ExecutionRow>(
              "SELECT * FROM executions WHERE settled_at IS NULL",
            ),
          );
          return rows.map(toExecution);
        }),
    });
  }),
);
