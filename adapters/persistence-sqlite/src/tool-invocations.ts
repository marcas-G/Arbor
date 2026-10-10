import type {
  CanonicalResourceRegion,
  ExecutionId,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import {
  type InvocationApproval,
  type LeaseFencingRejected,
  type ToolInvocationIntent,
  type ToolInvocationRecord,
  type ToolInvocationSettlement,
  ToolInvocationStore,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { repositoryFailure } from "./repository-error.js";

interface InvocationRow {
  readonly invocation_id: string;
  readonly execution_id: string;
  readonly workspace_id: string;
  readonly tool_name: string;
  readonly tool_version: string;
  readonly side_effect_semantics: string;
  readonly arguments_json: string;
  readonly resolved_regions_json: string;
  readonly approval_id: string | null;
  readonly intent_at: string;
  readonly settled_at: string | null;
  readonly settlement_kind: string | null;
  readonly settlement_json: string | null;
  readonly result_ref: string | null;
}

interface ApprovalRow {
  readonly approval_id: string;
  readonly tool_name: string;
  readonly tool_version: string;
  readonly action_digest: string;
  readonly target_resource_space_ids_json: string;
  readonly control_basis_digest: string;
  readonly expires_at: string;
  readonly consumed_by: string | null;
}

const toRecord = (row: InvocationRow): ToolInvocationRecord => ({
  invocationId: row.invocation_id as ToolInvocationId,
  executionId: row.execution_id as ExecutionId,
  workspaceId: row.workspace_id as WorkspaceId,
  toolName: row.tool_name,
  toolVersion: row.tool_version,
  sideEffectSemantics:
    row.side_effect_semantics as ToolInvocationRecord["sideEffectSemantics"],
  argumentsJson: row.arguments_json,
  resolvedRegions: JSON.parse(
    row.resolved_regions_json,
  ) as ReadonlyArray<CanonicalResourceRegion>,
  approvalId: row.approval_id,
  intentAt: row.intent_at,
  settledAt: row.settled_at,
  settlement:
    row.settlement_json === null
      ? null
      : (JSON.parse(row.settlement_json) as ToolInvocationSettlement),
  resultRef: row.result_ref,
});

const toApproval = (row: ApprovalRow): InvocationApproval => ({
  approvalId: row.approval_id,
  toolName: row.tool_name,
  toolVersion: row.tool_version,
  actionDigest: row.action_digest,
  targetResourceSpaceIds: JSON.parse(
    row.target_resource_space_ids_json,
  ) as ReadonlyArray<string>,
  controlBasisDigest: row.control_basis_digest,
  expiresAt: row.expires_at,
  consumedBy: row.consumed_by as ToolInvocationId | null,
});

export const ToolInvocationStoreLive: Layer.Layer<
  ToolInvocationStore,
  never,
  SqlClient
> = Layer.effect(
  ToolInvocationStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = repositoryFailure("ToolInvocationStore", "invocation");
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    const hasUnifiedLedger = Effect.gen(function* () {
      yield* TransactionScope;
      const rows = yield* run(
        sql.unsafe<{ n: number }>(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'action_approvals'",
        ),
      );
      return Number(rows[0]?.n ?? 0) === 1;
    });
    return ToolInvocationStore.of({
      recordIntent: (invocation: ToolInvocationIntent) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(
            sql.unsafe(
              "INSERT INTO tool_invocations (invocation_id, execution_id, workspace_id, tool_name, tool_version, side_effect_semantics, arguments_json, resolved_regions_json, approval_id, intent_at, settled_at, settlement_kind, settlement_json, result_ref) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL)",
              [
                invocation.invocationId,
                invocation.executionId,
                invocation.workspaceId,
                invocation.toolName,
                invocation.toolVersion,
                invocation.sideEffectSemantics,
                invocation.argumentsJson,
                JSON.stringify(invocation.resolvedRegions),
                invocation.approvalId,
                invocation.intentAt,
              ],
            ),
          );
        }),
      settle: (
        invocationId,
        settlement,
        resultRef,
        settledAt,
        executionFence,
        fenceNow,
      ) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          if (executionFence !== undefined) {
            const fenced = yield* run(
              sql.unsafe<{ readonly ok: number }>(
                `SELECT 1 AS ok
                   FROM tool_invocations i
                   JOIN executions e ON e.execution_id = i.execution_id
                   JOIN execution_leases l ON l.execution_id = e.execution_id
                  WHERE i.invocation_id = ?
                    AND i.execution_id = ?
                    AND e.settled_at IS NULL
                    AND l.worker_id = ?
                    AND l.worker_incarnation_id = ?
                    AND l.generation = ?
                    AND l.expires_at > ?`,
                [
                  invocationId,
                  executionFence.executionId,
                  executionFence.workerId,
                  executionFence.workerIncarnationId,
                  executionFence.fencingGeneration,
                  fenceNow ?? settledAt,
                ],
              ),
            );
            if (fenced.length === 0) {
              return yield* Effect.fail<LeaseFencingRejected>({
                _tag: "LeaseFencingRejected",
                executionId: executionFence.executionId,
                generation: executionFence.fencingGeneration,
              });
            }
          }
          const rows = yield* run(
            sql.unsafe(
              "UPDATE tool_invocations SET settled_at = ?, settlement_kind = ?, settlement_json = ?, result_ref = ? WHERE invocation_id = ? AND settled_at IS NULL RETURNING invocation_id",
              [
                settledAt,
                settlement._tag,
                JSON.stringify(settlement),
                resultRef,
                invocationId,
              ],
            ),
          );
          return rows.length > 0;
        }),
      consumeApproval: (approvalId, invocationId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const unified = yield* hasUnifiedLedger;
          const rows = yield* run(
            sql.unsafe<{ approval_id: string }>(
              unified
                ? "UPDATE action_approvals SET state = 'Consumed', revision = revision + 1, consumed_by = ?, consumed_at = CURRENT_TIMESTAMP WHERE approval_id = ? AND route_kind = 'Executable' AND state = 'Approved' AND consumed_by IS NULL RETURNING approval_id"
                : "UPDATE invocation_approvals SET consumed_by = ? WHERE approval_id = ? AND consumed_by IS NULL RETURNING approval_id",
              [invocationId, approvalId],
            ),
          );
          return rows.length > 0;
        }),
      findApproval: (approvalId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const unified = yield* hasUnifiedLedger;
          const rows = yield* run(
            sql.unsafe<ApprovalRow>(
              unified
                ? "SELECT approval_id, stable_action_id AS tool_name, action_version AS tool_version, action_digest, target_resource_space_ids_json, control_basis_digest, expires_at, consumed_by FROM action_approvals WHERE approval_id = ? AND route_kind = 'Executable'"
                : "SELECT * FROM invocation_approvals WHERE approval_id = ?",
              [approvalId],
            ),
          );
          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some(toApproval(row));
        }),
      findById: (invocationId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<InvocationRow>(
              "SELECT * FROM tool_invocations WHERE invocation_id = ?",
              [invocationId],
            ),
          );
          const row = rows[0];
          return row === undefined ? Option.none() : Option.some(toRecord(row));
        }),
      findUnsettled: (executionId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<InvocationRow>(
              "SELECT * FROM tool_invocations WHERE execution_id = ? AND settled_at IS NULL",
              [executionId],
            ),
          );
          return rows.map(toRecord);
        }),
    });
  }),
);
