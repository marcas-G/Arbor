import type {
  ControlApprovalRecord,
  ControlApprovalStoreError,
} from "@arbor/ports";
import { ControlApprovalStore, TransactionScope } from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { repositoryFailure } from "./repository-error.js";

interface Row {
  readonly approval_id: string;
  readonly project_id: string;
  readonly workspace_id: string;
  readonly execution_id: string;
  readonly stable_action_id: string;
  readonly action_digest: string;
  readonly arguments_json: string;
  readonly target_ref: string;
  readonly control_basis_digest: string;
  readonly state: string;
  readonly revision: number;
  readonly requested_at: string;
  readonly expires_at: string;
  readonly decided_at: string | null;
  readonly decided_by: string | null;
  readonly decision_reason: string | null;
  readonly consumed_at: string | null;
}

const toRecord = (row: Row): ControlApprovalRecord => ({
  approvalId: row.approval_id,
  projectId: row.project_id as never,
  workspaceId: row.workspace_id as never,
  executionId: row.execution_id as never,
  stableActionId: row.stable_action_id,
  actionDigest: row.action_digest,
  argumentsJson: row.arguments_json,
  targetRef: row.target_ref,
  controlBasisDigest: row.control_basis_digest,
  state: row.state as ControlApprovalRecord["state"],
  revision: Number(row.revision),
  requestedAt: row.requested_at,
  expiresAt: row.expires_at,
  decidedAt: row.decided_at,
  decidedBy: row.decided_by,
  decisionReason: row.decision_reason,
  consumedAt: row.consumed_at,
});

const params = (record: ControlApprovalRecord): ReadonlyArray<unknown> => [
  record.approvalId,
  record.projectId,
  record.workspaceId,
  record.executionId,
  record.stableActionId,
  record.actionDigest,
  record.argumentsJson,
  record.targetRef,
  record.controlBasisDigest,
  record.state,
  record.revision,
  record.requestedAt,
  record.expiresAt,
  record.decidedAt,
  record.decidedBy,
  record.decisionReason,
  record.consumedAt,
];

const unifiedParams = (
  record: ControlApprovalRecord,
): ReadonlyArray<unknown> => [
  record.approvalId,
  record.projectId,
  record.workspaceId,
  record.executionId,
  `Execution:${record.executionId}`,
  record.stableActionId,
  "1",
  record.actionDigest,
  record.argumentsJson,
  record.targetRef,
  record.controlBasisDigest,
  record.state,
  record.revision,
  record.requestedAt,
  record.expiresAt,
  record.decidedAt,
  record.decidedBy,
  record.decisionReason,
  record.consumedAt,
];

export const ControlApprovalStoreLive: Layer.Layer<
  ControlApprovalStore,
  never,
  SqlClient
> = Layer.effect(
  ControlApprovalStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = repositoryFailure("ControlApprovalStore", "sql");
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(
        Effect.mapError((cause): ControlApprovalStoreError => failure(cause)),
      );
    const hasUnifiedLedger = Effect.gen(function* () {
      yield* TransactionScope;
      const rows = yield* run(
        sql.unsafe<{ n: number }>(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'action_approvals'",
        ),
      );
      return Number(rows[0]?.n ?? 0) === 1;
    });
    return ControlApprovalStore.of({
      putPending: (record) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          if (yield* hasUnifiedLedger) {
            yield* run(
              sql.unsafe(
                "INSERT INTO action_approvals (approval_id, route_kind, project_id, workspace_id, execution_id, subject_ref, stable_action_id, action_version, side_effect_semantics, action_digest, arguments_json, target_ref, target_resource_space_ids_json, control_basis_digest, state, revision, requested_at, expires_at, decided_at, decided_by, decision_reason, consumed_at, consumed_by, binding_proven, source_state) VALUES (?,'Control',?,?,?,?,?,?,'InternalControl',?,?,?,'[]',?,?,?,?,?,?,?,?,?,NULL,1,NULL) ON CONFLICT(approval_id) DO NOTHING",
                unifiedParams(record),
              ),
            );
          } else {
            yield* run(
              sql.unsafe(
                "INSERT INTO control_action_approvals (approval_id, project_id, workspace_id, execution_id, stable_action_id, action_digest, arguments_json, target_ref, control_basis_digest, state, revision, requested_at, expires_at, decided_at, decided_by, decision_reason, consumed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(approval_id) DO NOTHING",
                params(record),
              ),
            );
          }
        }),
      findById: (approvalId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const unified = yield* hasUnifiedLedger;
          const rows = yield* run(
            sql.unsafe<Row>(
              unified
                ? "SELECT approval_id, project_id, workspace_id, execution_id, stable_action_id, action_digest, arguments_json, target_ref, control_basis_digest, state, revision, requested_at, expires_at, decided_at, decided_by, decision_reason, consumed_at FROM action_approvals WHERE approval_id = ? AND route_kind = 'Control'"
                : "SELECT * FROM control_action_approvals WHERE approval_id = ?",
              [approvalId],
            ),
          );
          return rows[0] === undefined
            ? Option.none()
            : Option.some(toRecord(rows[0]));
        }),
      decide: (input) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const unified = yield* hasUnifiedLedger;
          const rows = yield* run(
            sql.unsafe<Row>(
              `UPDATE ${unified ? "action_approvals" : "control_action_approvals"} SET state = ?, revision = revision + 1, decided_at = ?, decided_by = ?, decision_reason = ? WHERE approval_id = ? AND revision = ? AND state = 'Pending' AND expires_at > ? RETURNING approval_id, project_id, workspace_id, execution_id, stable_action_id, action_digest, arguments_json, target_ref, control_basis_digest, state, revision, requested_at, expires_at, decided_at, decided_by, decision_reason, consumed_at`,
              [
                input.decision === "Approve" ? "Approved" : "Rejected",
                input.decidedAt,
                input.decidedBy,
                input.reason,
                input.approvalId,
                input.expectedRevision,
                input.decidedAt,
              ],
            ),
          );
          return rows[0] === undefined
            ? Option.none()
            : Option.some(toRecord(rows[0]));
        }),
      consumeApproved: (input) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const unified = yield* hasUnifiedLedger;
          const rows = yield* run(
            sql.unsafe<Row>(
              `UPDATE ${unified ? "action_approvals" : "control_action_approvals"} SET state = 'Consumed', revision = revision + 1, consumed_at = ? WHERE approval_id = ? AND revision = ? AND state = 'Approved' AND action_digest = ? AND control_basis_digest = ? AND expires_at > ? RETURNING approval_id, project_id, workspace_id, execution_id, stable_action_id, action_digest, arguments_json, target_ref, control_basis_digest, state, revision, requested_at, expires_at, decided_at, decided_by, decision_reason, consumed_at`,
              [
                input.consumedAt,
                input.approvalId,
                input.expectedRevision,
                input.actionDigest,
                input.controlBasisDigest,
                input.consumedAt,
              ],
            ),
          );
          return rows[0] === undefined
            ? Option.none()
            : Option.some(toRecord(rows[0]));
        }),
      listResolved: () =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const unified = yield* hasUnifiedLedger;
          const rows = yield* run(
            sql.unsafe<Row>(
              unified
                ? "SELECT approval_id, project_id, workspace_id, execution_id, stable_action_id, action_digest, arguments_json, target_ref, control_basis_digest, state, revision, requested_at, expires_at, decided_at, decided_by, decision_reason, consumed_at FROM action_approvals WHERE route_kind = 'Control' AND state IN ('Approved','Rejected','Expired') ORDER BY COALESCE(decided_at, expires_at), approval_id"
                : "SELECT * FROM control_action_approvals WHERE state IN ('Approved','Rejected','Expired') ORDER BY COALESCE(decided_at, expires_at), approval_id",
            ),
          );
          return rows.map(toRecord);
        }),
      expireDue: (now) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const unified = yield* hasUnifiedLedger;
          const rows = yield* run(
            sql.unsafe<Row>(
              `UPDATE ${unified ? "action_approvals" : "control_action_approvals"} SET state = 'Expired', revision = revision + 1 WHERE state = 'Pending' AND expires_at <= ?${unified ? " AND route_kind = 'Control'" : ""} RETURNING approval_id, project_id, workspace_id, execution_id, stable_action_id, action_digest, arguments_json, target_ref, control_basis_digest, state, revision, requested_at, expires_at, decided_at, decided_by, decision_reason, consumed_at`,
              [now],
            ),
          );
          return rows.map(toRecord);
        }),
    });
  }),
);
