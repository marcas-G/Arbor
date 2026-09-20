import type {
  CanonicalResourceRegion,
  ExecutionId,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import {
  type InvocationApproval,
  type ToolInvocationIntent,
  type ToolInvocationRecord,
  type ToolInvocationSettlement,
  ToolInvocationStore,
  type ToolInvocationStoreError,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

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
    const failure = (cause: unknown): ToolInvocationStoreError => ({
      _tag: "ToolInvocationStoreError",
      cause,
    });
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
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
      settle: (invocationId, settlement, resultRef, settledAt) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(
            sql.unsafe(
              "UPDATE tool_invocations SET settled_at = ?, settlement_kind = ?, settlement_json = ?, result_ref = ? WHERE invocation_id = ? AND settled_at IS NULL",
              [
                settledAt,
                settlement._tag,
                JSON.stringify(settlement),
                resultRef,
                invocationId,
              ],
            ),
          );
        }),
      consumeApproval: (approvalId, invocationId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<{ approval_id: string }>(
              "UPDATE invocation_approvals SET consumed_by = ? WHERE approval_id = ? AND consumed_by IS NULL RETURNING approval_id",
              [invocationId, approvalId],
            ),
          );
          return rows.length > 0;
        }),
      findApproval: (approvalId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<ApprovalRow>(
              "SELECT * FROM invocation_approvals WHERE approval_id = ?",
              [approvalId],
            ),
          );
          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some(toApproval(row));
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
