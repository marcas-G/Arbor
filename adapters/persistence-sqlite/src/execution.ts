import type {
  Execution,
  ExecutionBinding,
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
  type ExecutionRepositoryError,
  type LeaseRecord,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

interface ExecutionRow {
  readonly execution_id: string;
  readonly project_id: string;
  readonly binding_kind: string;
  readonly workspace_id: string;
  readonly focus_kind: string | null;
  readonly focus_work_id: string | null;
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
  readonly generation: number;
  readonly expires_at: string;
  readonly updated_at: string;
}

const toExecution = (row: ExecutionRow): Execution => {
  const binding: ExecutionBinding =
    row.binding_kind === "workspace"
      ? {
          _tag: "WorkspaceExecution",
          workspaceId: row.workspace_id as WorkspaceId,
          focus:
            row.focus_kind === "work"
              ? { _tag: "Work", workId: row.focus_work_id as WorkId }
              : { _tag: "Coordination" },
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

const toLease = (row: LeaseRow): LeaseRecord => ({
  executionId: row.execution_id as ExecutionId,
  workerId: row.worker_id,
  generation: Number(row.generation) as LeaseRecord["generation"],
  expiresAt: row.expires_at,
  updatedAt: row.updated_at,
});

const insertSql =
  "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)";

const insertParams = (execution: Execution): ReadonlyArray<unknown> => {
  const binding = execution.binding;
  const isWorkspace = binding._tag === "WorkspaceExecution";
  return [
    execution.executionId,
    execution.projectId,
    isWorkspace ? "workspace" : "execution_bound",
    execution.workspaceId,
    isWorkspace ? binding.focus._tag.toLowerCase() : null,
    isWorkspace && binding.focus._tag === "Work" ? binding.focus.workId : null,
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
    const failure = (cause: unknown): ExecutionRepositoryError => ({
      _tag: "ExecutionRepositoryFailure",
      cause,
    });
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
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
          yield* run(sql.unsafe(insertSql, insertParams(execution)));
          return Option.some(execution);
        }),
      admitExecution: (execution) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(sql.unsafe(insertSql, insertParams(execution)));
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
      tryAcquireLease: (executionId, workerId, expiresAt) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = yield* clock.now();
          const rows = yield* run(
            sql.unsafe<{ generation: number }>(
              "INSERT INTO execution_leases (execution_id, worker_id, generation, expires_at, updated_at) VALUES (?, ?, COALESCE((SELECT MAX(generation) + 1 FROM execution_leases WHERE execution_id = ?), 0), ?, ?) ON CONFLICT(execution_id) DO UPDATE SET worker_id = excluded.worker_id, generation = excluded.generation, expires_at = excluded.expires_at, updated_at = excluded.updated_at WHERE execution_leases.expires_at <= ? RETURNING generation",
              [executionId, workerId, executionId, expiresAt, now, now],
            ),
          );
          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some({
                executionId,
                workerId,
                generation: Number(row.generation) as LeaseRecord["generation"],
                expiresAt,
                updatedAt: now,
              });
        }),
      renewLease: (executionId, workerId, generation, expiresAt) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = yield* clock.now();
          const rows = yield* run(
            sql.unsafe<{ generation: number }>(
              "UPDATE execution_leases SET expires_at = ?, updated_at = ? WHERE execution_id = ? AND worker_id = ? AND generation = ? RETURNING generation",
              [expiresAt, now, executionId, workerId, generation],
            ),
          );
          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some({
                executionId,
                workerId,
                generation: Number(row.generation) as LeaseRecord["generation"],
                expiresAt,
                updatedAt: now,
              });
        }),
      releaseLease: (executionId, workerId, generation) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = yield* clock.now();
          yield* run(
            sql.unsafe(
              "UPDATE execution_leases SET expires_at = ?, updated_at = ? WHERE execution_id = ? AND worker_id = ? AND generation = ?",
              [now, now, executionId, workerId, generation],
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
