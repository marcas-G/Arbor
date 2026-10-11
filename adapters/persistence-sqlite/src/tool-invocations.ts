import type {
  CanonicalResourceRegion,
  ExecutionId,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import {
  type InvocationApproval,
  invocationAuthoritySourceRevisionOf,
  type LeaseFencingRejected,
  type NoEffectDenialCode,
  type ToolExecutionContext,
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
import {
  persistenceCorruption,
  repositoryFailure,
} from "./repository-error.js";

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
  readonly effect_admission_state: string;
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

/** P32's old P4 projection is deliberately recognizable without treating
 * arbitrary unbound Executable history as an InvocationApproval. P38 EAP rows
 * use binding_proven=1 and are only read through ExecutableApprovalStore. */
const legacyP4UnifiedApprovalShape = `route_kind = 'Executable'
  AND binding_proven = 0
  AND subject_ref = 'legacy:unbound'
  AND project_id IS NULL
  AND workspace_id IS NULL
  AND execution_id IS NULL
  AND side_effect_semantics = 'LegacyUnknown'
  AND arguments_json = '{}'
  AND target_ref = target_resource_space_ids_json`;

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
  effectAdmissionState:
    row.effect_admission_state as ToolInvocationRecord["effectAdmissionState"],
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

type FenceGate = "Current" | "ExecutionStopping";

const assertSameIntent = (
  existing: ToolInvocationRecord,
  incoming: ToolInvocationIntent,
): boolean =>
  existing.executionId === incoming.executionId &&
  existing.workspaceId === incoming.workspaceId &&
  existing.toolName === incoming.toolName &&
  existing.toolVersion === incoming.toolVersion &&
  existing.sideEffectSemantics === incoming.sideEffectSemantics &&
  existing.argumentsJson === incoming.argumentsJson &&
  JSON.stringify(existing.resolvedRegions) ===
    JSON.stringify(incoming.resolvedRegions) &&
  existing.approvalId === incoming.approvalId;

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
    const checkFenceAndStop = (
      executionId: ExecutionId,
      executionFence: ToolExecutionContext["executionFence"],
      fenceNow: string,
    ): Effect.Effect<FenceGate, ToolInvocationStoreError, TransactionScope> =>
      Effect.gen(function* () {
        yield* TransactionScope;
        if (executionFence === undefined) return "Current" as const;
        if (executionFence.executionId !== executionId) {
          return yield* Effect.fail<LeaseFencingRejected>({
            _tag: "LeaseFencingRejected",
            executionId,
            generation: executionFence.fencingGeneration,
          });
        }
        const rows = yield* run(
          sql.unsafe<{ stop_requested_at: string | null }>(
            `SELECT e.stop_requested_at
               FROM executions e
               JOIN execution_leases l ON l.execution_id = e.execution_id
              WHERE e.execution_id = ?
                AND e.settled_at IS NULL
                AND l.worker_id = ?
                AND l.worker_incarnation_id = ?
                AND l.generation = ?
                AND l.expires_at > ?`,
            [
              executionId,
              executionFence.workerId,
              executionFence.workerIncarnationId,
              executionFence.fencingGeneration,
              fenceNow,
            ],
          ),
        );
        const row = rows[0];
        if (row === undefined) {
          return yield* Effect.fail<LeaseFencingRejected>({
            _tag: "LeaseFencingRejected",
            executionId,
            generation: executionFence.fencingGeneration,
          });
        }
        return row.stop_requested_at === null
          ? ("Current" as const)
          : ("ExecutionStopping" as const);
      });
    return ToolInvocationStore.of({
      recordIntent: (invocation, executionFence, fenceNow) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const gate = yield* checkFenceAndStop(
            invocation.executionId,
            executionFence,
            fenceNow ?? invocation.intentAt,
          );
          if (gate === "ExecutionStopping") return gate;
          const priorRows = yield* run(
            sql.unsafe<InvocationRow>(
              "SELECT * FROM tool_invocations WHERE invocation_id = ?",
              [invocation.invocationId],
            ),
          );
          const prior = priorRows[0];
          if (prior !== undefined) {
            const record = toRecord(prior);
            if (
              assertSameIntent(record, invocation) &&
              record.effectAdmissionState === "NotAdmitted" &&
              record.settlement === null
            ) {
              return "Recorded" as const;
            }
            return yield* Effect.fail(
              persistenceCorruption(
                "ToolInvocationStore",
                "record-intent",
                "invocation identity conflicts with an existing terminal or non-admissible record",
              ),
            );
          }
          yield* run(
            sql.unsafe(
              "INSERT INTO tool_invocations (invocation_id, execution_id, workspace_id, tool_name, tool_version, side_effect_semantics, arguments_json, resolved_regions_json, approval_id, effect_admission_state, intent_at, settled_at, settlement_kind, settlement_json, result_ref) VALUES (?,?,?,?,?,?,?,?,?,'NotAdmitted',?,NULL,NULL,NULL,NULL)",
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
          return "Recorded" as const;
        }),
      recordNoEffectDenial: (
        invocation,
        reasonCode: NoEffectDenialCode,
        settledAt,
        executionFence,
        fenceNow,
      ) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const gate = yield* checkFenceAndStop(
            invocation.executionId,
            executionFence,
            fenceNow ?? settledAt,
          );
          if (gate === "ExecutionStopping") return gate;

          const existingRows = yield* run(
            sql.unsafe<InvocationRow>(
              "SELECT * FROM tool_invocations WHERE invocation_id = ?",
              [invocation.invocationId],
            ),
          );
          const existing = existingRows[0];
          if (existing !== undefined) {
            const record = toRecord(existing);
            if (!assertSameIntent(record, invocation)) {
              return yield* Effect.fail(
                persistenceCorruption(
                  "ToolInvocationStore",
                  "record-no-effect-denial",
                  "ToolInvocation identity conflicts with the rejected intent",
                ),
              );
            }
            if (record.settlement !== null) {
              if (
                record.settlement._tag === "Denied" &&
                record.settlement.reasonCode === reasonCode &&
                record.effectAdmissionState === "NotAdmitted"
              ) {
                return record;
              }
              return yield* Effect.fail(
                persistenceCorruption(
                  "ToolInvocationStore",
                  "record-no-effect-denial",
                  "terminal invocation cannot be rewritten as a different no-effect denial",
                ),
              );
            }
            if (record.effectAdmissionState !== "NotAdmitted") {
              return yield* Effect.fail(
                persistenceCorruption(
                  "ToolInvocationStore",
                  "record-no-effect-denial",
                  "MayHaveStarted or LegacyUnknown invocation cannot be classified as no-effect Denied",
                ),
              );
            }
            const updated = yield* run(
              sql.unsafe(
                `UPDATE tool_invocations
                    SET settled_at = ?, settlement_kind = 'Denied',
                        settlement_json = ?, result_ref = NULL
                  WHERE invocation_id = ? AND settled_at IS NULL
                    AND effect_admission_state = 'NotAdmitted'
                  RETURNING invocation_id`,
                [
                  settledAt,
                  JSON.stringify({
                    _tag: "Denied",
                    reasonCode,
                    projectionVersion: 1,
                  }),
                  invocation.invocationId,
                ],
              ),
            );
            if (updated.length === 0) {
              return yield* Effect.fail(
                persistenceCorruption(
                  "ToolInvocationStore",
                  "record-no-effect-denial",
                  "no-effect Denied compare-and-set did not apply",
                ),
              );
            }
          } else {
            yield* run(
              sql.unsafe(
                `INSERT INTO tool_invocations (
                   invocation_id, execution_id, workspace_id, tool_name,
                   tool_version, side_effect_semantics, arguments_json,
                   resolved_regions_json, approval_id, effect_admission_state,
                   intent_at, settled_at, settlement_kind, settlement_json,
                   result_ref
                 ) VALUES (?,?,?,?,?,?,?,?,?,'NotAdmitted',?,?,'Denied',?,NULL)`,
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
                  settledAt,
                  JSON.stringify({
                    _tag: "Denied",
                    reasonCode,
                    projectionVersion: 1,
                  }),
                ],
              ),
            );
          }
          const rows = yield* run(
            sql.unsafe<InvocationRow>(
              "SELECT * FROM tool_invocations WHERE invocation_id = ?",
              [invocation.invocationId],
            ),
          );
          const row = rows[0];
          if (row === undefined) {
            return yield* Effect.fail(
              persistenceCorruption(
                "ToolInvocationStore",
                "record-no-effect-denial",
                "terminal Denied record was not readable after commit scope",
              ),
            );
          }
          return toRecord(row);
        }),
      recordNoEffectInterruption: (
        invocationId,
        settledAt,
        executionFence,
        fenceNow,
      ) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<InvocationRow>(
              "SELECT * FROM tool_invocations WHERE invocation_id = ?",
              [invocationId],
            ),
          );
          const row = rows[0];
          if (row === undefined) return false;
          const gate = yield* checkFenceAndStop(
            row.execution_id as ExecutionId,
            executionFence,
            fenceNow ?? settledAt,
          );
          if (gate !== "ExecutionStopping") return false;
          const record = toRecord(row);
          if (
            record.effectAdmissionState !== "NotAdmitted" ||
            (record.settlement !== null &&
              record.settlement._tag !== "Interrupted")
          ) {
            return false;
          }
          if (record.settlement?._tag === "Interrupted") return true;
          const updated = yield* run(
            sql.unsafe(
              `UPDATE tool_invocations
                  SET settled_at = ?, settlement_kind = 'Interrupted',
                      settlement_json = ?, result_ref = NULL
                WHERE invocation_id = ? AND settled_at IS NULL
                  AND effect_admission_state = 'NotAdmitted'
                RETURNING invocation_id`,
              [
                settledAt,
                JSON.stringify({ _tag: "Interrupted" }),
                invocationId,
              ],
            ),
          );
          return updated.length > 0;
        }),
      admitEffect: (invocationId, currentAuthority, now, executionFence) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<InvocationRow>(
              "SELECT * FROM tool_invocations WHERE invocation_id = ?",
              [invocationId],
            ),
          );
          const row = rows[0];
          if (row === undefined) {
            return yield* Effect.fail(
              persistenceCorruption(
                "ToolInvocationStore",
                "admit-effect",
                "cannot admit an effect without a durable ToolInvocation intent",
              ),
            );
          }
          const gate = yield* checkFenceAndStop(
            row.execution_id as ExecutionId,
            executionFence,
            now,
          );
          if (gate === "ExecutionStopping") {
            return { _tag: "ExecutionStopping" } as const;
          }
          const record = toRecord(row);
          if (record.settlement !== null) {
            return yield* Effect.fail(
              persistenceCorruption(
                "ToolInvocationStore",
                "admit-effect",
                "terminal ToolInvocation cannot enter effect admission",
              ),
            );
          }
          if (record.effectAdmissionState === "MayHaveStarted") {
            return { _tag: "Admitted" } as const;
          }
          if (record.effectAdmissionState !== "NotAdmitted") {
            return yield* Effect.fail(
              persistenceCorruption(
                "ToolInvocationStore",
                "admit-effect",
                "LegacyUnknown invocation cannot enter effect admission",
              ),
            );
          }
          if (
            executionFence !== undefined &&
            currentAuthority.sourceRevision === undefined
          ) {
            return {
              _tag: "Denied",
              reasonCode: "InvocationAuthorityDenied",
            } as const;
          }
          const authorityMatches =
            currentAuthority.executionId === record.executionId &&
            currentAuthority.workspaceId === record.workspaceId &&
            currentAuthority.toolName === record.toolName &&
            currentAuthority.toolVersion === record.toolVersion &&
            currentAuthority.expiresAt > now &&
            record.resolvedRegions.every((region) =>
              currentAuthority.resourceSpaceIds.includes(
                region.resourceSpaceId,
              ),
            );
          if (!authorityMatches) {
            return {
              _tag: "Denied",
              reasonCode: "InvocationAuthorityDenied",
            } as const;
          }
          if (currentAuthority.sourceRevision !== undefined) {
            const workspaceRows = yield* run(
              sql.unsafe<{
                readonly project_id: string;
                readonly workspace_policy_revision: number;
              }>(
                `SELECT project_id, workspace_policy_revision
                   FROM workspaces WHERE workspace_id = ?`,
                [record.workspaceId],
              ),
            );
            const workspace = workspaceRows[0];
            if (workspace === undefined) {
              return {
                _tag: "Denied",
                reasonCode: "InvocationAuthorityDenied",
              } as const;
            }
            const grantRows = yield* run(
              sql.unsafe<{
                readonly permission_grant_id: string;
                readonly revision: number | null;
              }>(
                `SELECT permission_grant_id, revision
                   FROM permission_grants
                  WHERE project_id = ? AND state = 'Active'
                  ORDER BY permission_grant_id`,
                [workspace.project_id],
              ),
            );
            const verifierRows = yield* run(
              sql.unsafe<{ readonly verification_id: string }>(
                `SELECT v.verification_id
                   FROM verification_executions ve
                   JOIN verifications v
                     ON v.verification_id = ve.verification_id
                  WHERE ve.execution_id = ?
                  ORDER BY ve.bound_at, v.verification_id
                  LIMIT 1`,
                [record.executionId],
              ),
            );
            const currentSourceRevision = invocationAuthoritySourceRevisionOf({
              workspacePolicyRevision: Number(
                workspace.workspace_policy_revision,
              ),
              activeGrants: grantRows.map((grant) => ({
                permissionGrantId: grant.permission_grant_id,
                revision:
                  grant.revision === null ? null : Number(grant.revision),
              })),
              verifierId: verifierRows[0]?.verification_id ?? null,
            });
            if (currentSourceRevision !== currentAuthority.sourceRevision) {
              return {
                _tag: "Denied",
                reasonCode: "InvocationAuthorityDenied",
              } as const;
            }
          }
          if (record.approvalId !== null) {
            const unified = yield* hasUnifiedLedger;
            const approvalRows = yield* run(
              sql.unsafe<ApprovalRow>(
                unified
                  ? `SELECT approval_id, stable_action_id AS tool_name,
                            action_version AS tool_version, action_digest,
                            target_resource_space_ids_json,
                            control_basis_digest, expires_at, consumed_by
                       FROM action_approvals
                      WHERE approval_id = ? AND route_kind = 'Executable'`
                  : "SELECT * FROM invocation_approvals WHERE approval_id = ?",
                [record.approvalId],
              ),
            );
            const approval = approvalRows[0];
            if (approval === undefined) {
              return {
                _tag: "Denied",
                reasonCode: "ApprovalNoLongerAuthorized",
              } as const;
            }
            if (approval.consumed_by !== invocationId) {
              return {
                _tag: "Denied",
                reasonCode: "ApprovalNoLongerAuthorized",
              } as const;
            }
            if (approval.expires_at <= now) {
              return {
                _tag: "Denied",
                reasonCode: "ApprovalNoLongerAuthorized",
              } as const;
            }
            if (
              approval.tool_name !== record.toolName ||
              approval.tool_version !== record.toolVersion ||
              approval.control_basis_digest !==
                currentAuthority.controlBasisDigest
            ) {
              return {
                _tag: "Denied",
                reasonCode: "ApprovalNoLongerAuthorized",
              } as const;
            }
          }
          const updated = yield* run(
            sql.unsafe(
              `UPDATE tool_invocations
                  SET effect_admission_state = 'MayHaveStarted'
                WHERE invocation_id = ? AND settled_at IS NULL
                  AND effect_admission_state = 'NotAdmitted'
                RETURNING invocation_id`,
              [invocationId],
            ),
          );
          return updated.length > 0
            ? ({ _tag: "Admitted" } as const)
            : yield* Effect.fail(
                persistenceCorruption(
                  "ToolInvocationStore",
                  "admit-effect",
                  "effect-admission compare-and-set did not apply",
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
      consumeApproval: (approvalId, invocationId, executionFence, fenceNow) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          if (executionFence !== undefined) {
            const invocationRows = yield* run(
              sql.unsafe<{ execution_id: string }>(
                "SELECT execution_id FROM tool_invocations WHERE invocation_id = ?",
                [invocationId],
              ),
            );
            const invocation = invocationRows[0];
            if (invocation === undefined) {
              return yield* Effect.fail(
                persistenceCorruption(
                  "ToolInvocationStore",
                  "consume-approval",
                  "approval cannot be consumed before its ToolInvocation intent",
                ),
              );
            }
            const gate = yield* checkFenceAndStop(
              invocation.execution_id as ExecutionId,
              executionFence,
              fenceNow ?? new Date().toISOString(),
            );
            if (gate === "ExecutionStopping") return gate;
          }
          const unified = yield* hasUnifiedLedger;
          if (unified) return false;
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
          const unified = yield* hasUnifiedLedger;
          const rows = yield* run(
            sql.unsafe<ApprovalRow>(
              unified
                ? `SELECT approval_id, stable_action_id AS tool_name,
                          action_version AS tool_version, action_digest,
                          target_resource_space_ids_json, control_basis_digest,
                          expires_at, consumed_by
                     FROM action_approvals
                    WHERE approval_id = ? AND ${legacyP4UnifiedApprovalShape}
                      AND ((source_state IS NULL AND state IN ('Approved','Consumed'))
                        OR (source_state = 'Approved' AND state = 'Expired')
                        OR (source_state = 'Consumed' AND state = 'Consumed'))`
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
