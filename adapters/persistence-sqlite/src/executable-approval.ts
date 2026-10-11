import type { Actor, Principal, ToolInvocationId } from "@arbor/domain";
import {
  DomainEventJournal,
  type ExecutableApprovalBinding,
  type ExecutableApprovalConsumptionReceipt,
  type ExecutableApprovalKey,
  type ExecutableApprovalRecord,
  type ExecutableApprovalRequest,
  ExecutableApprovalStore,
  executableApprovalBindingMatches,
  executableApprovalKeyOf,
  IdGenerator,
  InboxProjectionStore,
  sha256Hex,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  persistenceCorruption,
  repositoryFailure,
} from "./repository-error.js";

interface ApprovalRow {
  readonly approval_id: string;
  readonly route_kind: string;
  readonly project_id: string | null;
  readonly workspace_id: string | null;
  readonly execution_id: string | null;
  readonly subject_ref: string;
  readonly stable_action_id: string;
  readonly action_version: string;
  readonly side_effect_semantics: string;
  readonly action_digest: string;
  readonly arguments_json: string;
  readonly target_ref: string;
  readonly target_resource_space_ids_json: string;
  readonly control_basis_digest: string;
  readonly state: string;
  readonly revision: number;
  readonly requested_at: string;
  readonly expires_at: string;
  readonly decided_at: string | null;
  readonly decided_by: string | null;
  readonly decision_reason: string | null;
  readonly consumed_at: string | null;
  readonly consumed_by: string | null;
  readonly binding_proven: number;
  readonly source_state: string | null;
  readonly logical_step_no: number | null;
  readonly repair_attempt: number | null;
  readonly action_index: number | null;
  readonly logical_action_id: string | null;
  readonly call_ref: string | null;
  readonly tool_invocation_id: string | null;
  readonly cancelled_at: string | null;
  readonly cancelled_by: string | null;
  readonly cancellation_reason: string | null;
  readonly execution_project_id?: string;
  readonly execution_workspace_id?: string;
}

const toApproval = (row: ApprovalRow): ExecutableApprovalRecord => ({
  approvalId: row.approval_id,
  routeKind: row.route_kind as "Executable",
  projectId: row.project_id as ExecutableApprovalRecord["projectId"],
  workspaceId: row.workspace_id as ExecutableApprovalRecord["workspaceId"],
  executionId: row.execution_id as ExecutableApprovalRecord["executionId"],
  subject: row.subject_ref as Principal,
  logicalStepNo: Number(row.logical_step_no),
  repairAttempt: Number(row.repair_attempt),
  actionIndex: Number(row.action_index),
  logicalActionId: row.logical_action_id as string,
  callRef: row.call_ref as string,
  toolInvocationId: row.tool_invocation_id as ToolInvocationId,
  toolName: row.stable_action_id,
  toolVersion: row.action_version,
  sideEffectSemantics:
    row.side_effect_semantics as ExecutableApprovalRecord["sideEffectSemantics"],
  argumentsJson: row.arguments_json,
  actionDigest: row.action_digest,
  targetResourceSpaceIds: JSON.parse(
    row.target_resource_space_ids_json,
  ) as ReadonlyArray<string>,
  controlBasisDigest: row.control_basis_digest,
  revision: Number(row.revision),
  requestedAt: row.requested_at,
  expiresAt: row.expires_at,
  state: row.state as ExecutableApprovalRecord["state"],
  decidedAt: row.decided_at,
  decidedBy: row.decided_by as Principal | null,
  decisionReason: row.decision_reason,
  cancelledAt: row.cancelled_at,
  cancelledBy: row.cancelled_by as Principal | null,
  cancellationReason: row.cancellation_reason,
  consumedAt: row.consumed_at,
  consumedBy: row.consumed_by as ToolInvocationId | null,
});

const immutableBindingOf = (
  row: ExecutableApprovalRecord,
): ExecutableApprovalBinding => ({
  projectId: row.projectId,
  workspaceId: row.workspaceId,
  executionId: row.executionId,
  logicalStepNo: row.logicalStepNo,
  repairAttempt: row.repairAttempt,
  actionIndex: row.actionIndex,
  logicalActionId: row.logicalActionId,
  subject: row.subject,
  callRef: row.callRef,
  toolInvocationId: row.toolInvocationId,
  toolName: row.toolName,
  toolVersion: row.toolVersion,
  sideEffectSemantics: row.sideEffectSemantics,
  argumentsJson: row.argumentsJson,
  actionDigest: row.actionDigest,
  targetResourceSpaceIds: row.targetResourceSpaceIds,
  controlBasisDigest: row.controlBasisDigest,
});

const consumptionReceiptOf = (
  record: ExecutableApprovalRecord,
  preConsumeRevision: number,
): ExecutableApprovalConsumptionReceipt => {
  const binding = immutableBindingOf(record);
  const digestInput = {
    approvalId: record.approvalId,
    preConsumeRevision,
    consumedRevision: record.revision,
    binding,
    expiresAt: record.expiresAt,
    consumedBy: record.consumedBy,
  };
  return {
    approvalId: record.approvalId,
    preConsumeRevision,
    consumedRevision: record.revision,
    approvalDigest: sha256Hex(JSON.stringify(digestInput)),
    binding,
    expiresAt: record.expiresAt,
    consumedBy: record.consumedBy as ToolInvocationId,
  };
};

const keyWhere =
  "route_kind = 'Executable' AND binding_proven = 1 AND execution_id = ? AND logical_step_no = ? AND repair_attempt = ? AND action_index = ? AND logical_action_id = ?";

export const ExecutableApprovalStoreLive: Layer.Layer<
  ExecutableApprovalStore,
  never,
  SqlClient | InboxProjectionStore | DomainEventJournal | IdGenerator
> = Layer.effect(
  ExecutableApprovalStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const inbox = yield* InboxProjectionStore;
    const journal = yield* DomainEventJournal;
    const ids = yield* IdGenerator;
    const failure = repositoryFailure(
      "ToolInvocationStore",
      "executable-approval",
    );
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));

    const findByActionKey = (
      key: ExecutableApprovalKey,
    ): Effect.Effect<
      Option.Option<ExecutableApprovalRecord>,
      import("@arbor/ports").ToolInvocationStoreError,
      TransactionScope
    > =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const rows = yield* run(
          sql.unsafe<ApprovalRow>(
            `SELECT * FROM action_approvals WHERE ${keyWhere}`,
            [
              key.executionId,
              key.logicalStepNo,
              key.repairAttempt,
              key.actionIndex,
              key.logicalActionId,
            ],
          ),
        );
        const row = rows[0];
        if (row === undefined) return Option.none();
        if (
          row.project_id === null ||
          row.workspace_id === null ||
          row.execution_id === null ||
          row.logical_step_no === null ||
          row.repair_attempt === null ||
          row.action_index === null ||
          row.logical_action_id === null ||
          row.call_ref === null ||
          row.tool_invocation_id === null
        ) {
          return yield* Effect.fail(
            persistenceCorruption(
              "ToolInvocationStore",
              "executable-approval-read",
              "proven Executable approval has an incomplete binding",
            ),
          );
        }
        return Option.some(toApproval(row));
      });

    const findById = (approvalId: string) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const rows = yield* run(
          sql.unsafe<ApprovalRow>(
            "SELECT * FROM action_approvals WHERE approval_id = ? AND route_kind = 'Executable' AND binding_proven = 1",
            [approvalId],
          ),
        );
        const row = rows[0];
        return row === undefined ? Option.none() : Option.some(toApproval(row));
      });

    const validateWorkerAndAction = (
      request: ExecutableApprovalRequest,
    ): Effect.Effect<
      "Ready" | "ExecutionStopping",
      import("@arbor/ports").ToolInvocationStoreError,
      TransactionScope
    > =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const fence = request.executionFence;
        if (fence.executionId !== request.executionId) {
          return yield* Effect.fail({
            _tag: "LeaseFencingRejected" as const,
            executionId: request.executionId,
            generation: fence.fencingGeneration,
          });
        }
        const executions = yield* run(
          sql.unsafe<{
            project_id: string;
            workspace_id: string;
            stop_requested_at: string | null;
            settled_at: string | null;
          }>(
            `SELECT e.project_id, e.workspace_id, e.stop_requested_at, e.settled_at
               FROM executions e
               JOIN execution_leases l ON l.execution_id = e.execution_id
              WHERE e.execution_id = ?
                AND l.worker_id = ?
                AND l.worker_incarnation_id = ?
                AND l.generation = ?
                AND l.expires_at > ?`,
            [
              request.executionId,
              fence.workerId,
              fence.workerIncarnationId,
              fence.fencingGeneration,
              request.requestedAt,
            ],
          ),
        );
        const execution = executions[0];
        if (execution === undefined) {
          return yield* Effect.fail({
            _tag: "LeaseFencingRejected" as const,
            executionId: request.executionId,
            generation: fence.fencingGeneration,
          });
        }
        if (
          execution.settled_at !== null ||
          execution.stop_requested_at !== null
        ) {
          return "ExecutionStopping" as const;
        }
        if (
          execution.project_id !== request.projectId ||
          execution.workspace_id !== request.workspaceId
        ) {
          return yield* Effect.fail(
            persistenceCorruption(
              "ToolInvocationStore",
              "executable-approval-write",
              "approval binding does not match the fenced Execution",
            ),
          );
        }

        const actions = yield* run(
          sql.unsafe<{
            step_state: string;
            action_state: string;
            action_input_hash: string;
            action_kind: string;
            action_call_ref: string;
            action_route_kind: string;
          }>(
            `SELECT s.state AS step_state, a.state AS action_state,
                    a.input_hash AS action_input_hash, a.action_kind,
                    a.call_ref AS action_call_ref, a.route_kind AS action_route_kind
               FROM agent_loop_steps s
               JOIN agent_loop_step_actions a
                 ON a.execution_id = s.execution_id
                AND a.logical_step_no = s.logical_step_no
                AND a.repair_attempt = s.repair_attempt
              WHERE s.execution_id = ? AND s.logical_step_no = ?
                AND s.repair_attempt = ? AND a.action_index = ?
                AND a.logical_action_id = ?`,
            [
              request.executionId,
              request.logicalStepNo,
              request.repairAttempt,
              request.actionIndex,
              request.logicalActionId,
            ],
          ),
        );
        const action = actions[0];
        if (
          action === undefined ||
          action.step_state !== "ActionsInProgress" ||
          action.action_state !== "Pending" ||
          action.action_route_kind !== "Executable" ||
          action.action_call_ref !== request.callRef ||
          action.action_kind !== request.toolName ||
          action.action_input_hash !== sha256Hex(request.argumentsJson)
        ) {
          return yield* Effect.fail(
            persistenceCorruption(
              "ToolInvocationStore",
              "executable-approval-write",
              "approval does not bind the exact Pending Executable action",
            ),
          );
        }
        return "Ready" as const;
      });

    return ExecutableApprovalStore.of({
      findByActionKey,
      findById,
      decide: (input) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const before = yield* findById(input.approvalId);
          if (Option.isNone(before)) return Option.none();
          const changed = yield* run(
            sql.unsafe<ApprovalRow>(
              `UPDATE action_approvals
                  SET state = CASE WHEN expires_at <= ? THEN 'Expired' ELSE ? END,
                      revision = revision + 1,
                      decided_at = CASE WHEN expires_at <= ? THEN decided_at ELSE ? END,
                      decided_by = CASE WHEN expires_at <= ? THEN decided_by ELSE ? END,
                      decision_reason = CASE WHEN expires_at <= ? THEN decision_reason ELSE ? END
                WHERE approval_id = ? AND route_kind = 'Executable'
                  AND binding_proven = 1 AND revision = ? AND state = 'Pending'
                RETURNING *`,
              [
                input.decidedAt,
                input.decision === "Approve" ? "Approved" : "Rejected",
                input.decidedAt,
                input.decidedAt,
                input.decidedAt,
                input.decidedBy,
                input.decidedAt,
                input.reason,
                input.approvalId,
                input.expectedRevision,
              ],
            ),
          );
          const row = changed[0];
          if (row === undefined) return Option.none();
          const record = toApproval(row);
          const inboxKey = `eap:${record.approvalId}:${input.expectedRevision}`;
          const inboxRows = yield* run(
            sql.unsafe<{ consumed_at: string | null }>(
              "SELECT consumed_at FROM inbox_entries WHERE workspace_id = ? AND entry_key = ?",
              [record.workspaceId, inboxKey],
            ),
          );
          if (inboxRows.length !== 1 || inboxRows[0]?.consumed_at !== null) {
            return yield* Effect.fail(
              persistenceCorruption(
                "ToolInvocationStore",
                "executable-approval-decide",
                "approval decision has no exact unconsumed Inbox entry",
              ),
            );
          }
          yield* inbox
            .markConsumed(record.workspaceId, inboxKey)
            .pipe(Effect.mapError(failure));
          yield* journal
            .append([
              {
                projectId: record.projectId,
                eventType: "ExecutableApprovalResolved",
                eventVersion: 1,
                occurredAt: input.decidedAt,
                aggregateRef: record.approvalId,
                actor: input.decidedBy as unknown as Actor,
                causedByCommandId: input.commandId,
                correlationRef: record.logicalActionId,
                payload: {
                  approvalId: record.approvalId,
                  routeKind: "Executable",
                  executionId: record.executionId,
                  workspaceId: record.workspaceId,
                  logicalActionId: record.logicalActionId,
                  toolInvocationId: record.toolInvocationId,
                  revision: record.revision,
                  resolution: record.state,
                  ...(record.state === "Expired"
                    ? { reasonCode: "TTLExpired" }
                    : {}),
                },
              },
            ])
            .pipe(
              Effect.provideService(IdGenerator, ids),
              Effect.mapError(failure),
            );
          return Option.some(record);
        }),
      expireDue: (input) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const batchSize = Math.max(
            1,
            Math.min(1000, Math.floor(input.batchSize ?? 100)),
          );
          const candidates = yield* run(
            sql.unsafe<ApprovalRow>(
              `SELECT * FROM action_approvals
                WHERE route_kind = 'Executable' AND binding_proven = 1
                  AND state IN ('Pending','Approved')
                  AND expires_at <= ? AND consumed_by IS NULL
                ORDER BY expires_at, approval_id
                LIMIT ?`,
              [input.now, batchSize],
            ),
          );
          const expired: Array<ExecutableApprovalRecord> = [];
          for (const candidate of candidates) {
            if (
              candidate.project_id === null ||
              candidate.workspace_id === null ||
              candidate.execution_id === null ||
              candidate.logical_step_no === null ||
              candidate.repair_attempt === null ||
              candidate.action_index === null ||
              candidate.logical_action_id === null ||
              candidate.call_ref === null ||
              candidate.tool_invocation_id === null
            ) {
              return yield* Effect.fail(
                persistenceCorruption(
                  "ToolInvocationStore",
                  "executable-approval-expire",
                  "proven Executable approval has an incomplete binding",
                ),
              );
            }
            const inboxKey = `eap:${candidate.approval_id}:0`;
            const inboxRows = yield* run(
              sql.unsafe<{ consumed_at: string | null }>(
                "SELECT consumed_at FROM inbox_entries WHERE workspace_id = ? AND entry_key = ?",
                [candidate.workspace_id, inboxKey],
              ),
            );
            if (
              inboxRows.length !== 1 ||
              (candidate.state === "Pending"
                ? inboxRows[0]?.consumed_at !== null
                : inboxRows[0]?.consumed_at === null)
            ) {
              return yield* Effect.fail(
                persistenceCorruption(
                  "ToolInvocationStore",
                  "executable-approval-expire",
                  "approval expiry has no exact Inbox revision to resolve",
                ),
              );
            }
            const changed = yield* run(
              sql.unsafe<ApprovalRow>(
                `UPDATE action_approvals
                    SET state = 'Expired', revision = revision + 1
                  WHERE approval_id = ? AND route_kind = 'Executable'
                    AND binding_proven = 1 AND revision = ?
                    AND state = ? AND expires_at <= ? AND consumed_by IS NULL
                  RETURNING *`,
                [
                  candidate.approval_id,
                  candidate.revision,
                  candidate.state,
                  input.now,
                ],
              ),
            );
            const row = changed[0];
            if (row === undefined) continue;
            const record = toApproval(row);
            if (candidate.state === "Pending") {
              yield* inbox
                .markConsumed(record.workspaceId, inboxKey)
                .pipe(Effect.mapError(failure));
            }
            yield* journal
              .append([
                {
                  projectId: record.projectId,
                  eventType: "ExecutableApprovalResolved",
                  eventVersion: 1,
                  occurredAt: input.now,
                  aggregateRef: record.approvalId,
                  actor: input.expiredBy as unknown as Actor,
                  correlationRef: record.logicalActionId,
                  payload: {
                    approvalId: record.approvalId,
                    routeKind: "Executable",
                    executionId: record.executionId,
                    workspaceId: record.workspaceId,
                    logicalActionId: record.logicalActionId,
                    toolInvocationId: record.toolInvocationId,
                    revision: record.revision,
                    resolution: "Expired",
                    reasonCode: "TTLExpired",
                  },
                },
              ])
              .pipe(
                Effect.provideService(IdGenerator, ids),
                Effect.mapError(failure),
              );
            expired.push(record);
          }
          return expired;
        }),
      consumeApproved: (input) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const current = yield* findById(input.approvalId);
          if (Option.isNone(current)) return false;
          const record = current.value;
          if (
            !executableApprovalBindingMatches(
              immutableBindingOf(record),
              input.binding,
            )
          ) {
            return false;
          }
          if (
            record.state === "Consumed" &&
            record.consumedBy === input.consumedBy &&
            record.revision === input.expectedRevision + 1
          ) {
            const invocation = yield* run(
              sql.unsafe<{ invocation_id: string }>(
                "SELECT invocation_id FROM tool_invocations WHERE invocation_id = ? AND execution_id = ?",
                [input.consumedBy, record.executionId],
              ),
            );
            return invocation.length === 1
              ? consumptionReceiptOf(record, input.expectedRevision)
              : false;
          }
          if (
            record.state !== "Approved" ||
            record.revision !== input.expectedRevision ||
            record.expiresAt <= input.consumedAt
          ) {
            return false;
          }
          const ready = yield* validateWorkerAndAction({
            ...input.binding,
            approvalId: input.approvalId,
            requestedAt: input.consumedAt,
            expiresAt: record.expiresAt,
            executionFence: input.executionFence,
          });
          if (ready === "ExecutionStopping") return ready;
          const consumed = yield* run(
            sql.unsafe<ApprovalRow>(
              `UPDATE action_approvals
                  SET state = 'Consumed', revision = revision + 1,
                      consumed_at = ?, consumed_by = ?
                WHERE approval_id = ? AND route_kind = 'Executable'
                  AND binding_proven = 1 AND revision = ?
                  AND state = 'Approved' AND consumed_by IS NULL
                RETURNING *`,
              [
                input.consumedAt,
                input.consumedBy,
                input.approvalId,
                input.expectedRevision,
              ],
            ),
          );
          const row = consumed[0];
          return row === undefined
            ? false
            : consumptionReceiptOf(toApproval(row), input.expectedRevision);
        }),
      putPendingExact: (request) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const ready = yield* validateWorkerAndAction(request);
          if (ready === "ExecutionStopping") return ready;

          const resourceIdsJson = JSON.stringify(
            request.targetResourceSpaceIds,
          );
          const inserted = yield* run(
            sql.unsafe<ApprovalRow>(
              `INSERT INTO action_approvals (
                 approval_id, route_kind, project_id, workspace_id, execution_id,
                 subject_ref, stable_action_id, action_version, side_effect_semantics,
                 action_digest, arguments_json, target_ref,
                 target_resource_space_ids_json, control_basis_digest,
                 state, revision, requested_at, expires_at, decided_at, decided_by,
                 decision_reason, consumed_at, consumed_by, binding_proven,
                 source_state, logical_step_no, repair_attempt, action_index,
                 logical_action_id, call_ref, tool_invocation_id,
                 cancelled_at, cancelled_by, cancellation_reason
               ) VALUES (?, 'Executable', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                         'Pending', 0, ?, ?, NULL, NULL, NULL, NULL, NULL, 1,
                         NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
               ON CONFLICT DO NOTHING
               RETURNING *`,
              [
                request.approvalId,
                request.projectId,
                request.workspaceId,
                request.executionId,
                request.subject,
                request.toolName,
                request.toolVersion,
                request.sideEffectSemantics,
                request.actionDigest,
                request.argumentsJson,
                resourceIdsJson,
                resourceIdsJson,
                request.controlBasisDigest,
                request.requestedAt,
                request.expiresAt,
                request.logicalStepNo,
                request.repairAttempt,
                request.actionIndex,
                request.logicalActionId,
                request.callRef,
                request.toolInvocationId,
              ],
            ),
          );
          const insertedRow = inserted[0];
          if (insertedRow !== undefined) {
            const inboxKey = `eap:${request.approvalId}:0`;
            yield* inbox
              .admitUpsert({
                recipientWorkspaceId: request.workspaceId,
                entryKey: inboxKey,
                kind: "Governance",
                summary: JSON.stringify({
                  kind: "ExecutableApproval",
                  approvalId: request.approvalId,
                  revision: 0,
                  toolName: request.toolName,
                  toolVersion: request.toolVersion,
                  targetResourceSpaceIds: request.targetResourceSpaceIds,
                  expiresAt: request.expiresAt,
                }),
                correlationId: request.logicalActionId,
                admittedAt: request.requestedAt,
              })
              .pipe(Effect.mapError(failure));
            yield* journal
              .append([
                {
                  projectId: request.projectId,
                  eventType: "ExecutableApprovalRequested",
                  eventVersion: 1,
                  occurredAt: request.requestedAt,
                  aggregateRef: request.approvalId,
                  actor: request.subject as unknown as Actor,
                  correlationRef: request.logicalActionId,
                  payload: {
                    approvalId: request.approvalId,
                    routeKind: "Executable",
                    executionId: request.executionId,
                    workspaceId: request.workspaceId,
                    logicalActionId: request.logicalActionId,
                    toolInvocationId: request.toolInvocationId,
                    revision: 0,
                    expiresAt: request.expiresAt,
                    actionDigest: request.actionDigest,
                  },
                },
              ])
              .pipe(
                Effect.provideService(IdGenerator, ids),
                Effect.mapError(failure),
              );
            return toApproval(insertedRow);
          }

          const winner = yield* findByActionKey(
            executableApprovalKeyOf(request),
          );
          if (
            Option.isNone(winner) ||
            !executableApprovalBindingMatches(
              immutableBindingOf(winner.value),
              request,
            )
          ) {
            return yield* Effect.fail(
              persistenceCorruption(
                "ToolInvocationStore",
                "executable-approval-write",
                "unique-key conflict has no matching Executable approval winner",
              ),
            );
          }
          return winner.value;
        }),
      cancelForExecution: (input) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const versions = yield* run(
            sql.unsafe<{ user_version: number }>("PRAGMA user_version"),
          );
          if (Number(versions[0]?.user_version ?? 0) < 38) {
            // Pre-0038 databases cannot contain a proven Executable approval.
            // Once user_version reaches 38, all P38 columns are required and
            // any SQL/schema failure aborts the stop transaction.
            return [];
          }
          const stops = yield* run(
            sql.unsafe<{ execution_id: string }>(
              "SELECT execution_id FROM executions WHERE execution_id = ? AND stop_requested_at IS NOT NULL AND settled_at IS NULL",
              [input.executionId],
            ),
          );
          if (stops.length !== 1) {
            return yield* Effect.fail(
              persistenceCorruption(
                "ToolInvocationStore",
                "executable-approval-cancel",
                "StopExecution must commit its stop flag before approval cancellation",
              ),
            );
          }
          const candidates = yield* run(
            sql.unsafe<ApprovalRow>(
              `SELECT a.*, e.project_id AS execution_project_id,
                      e.workspace_id AS execution_workspace_id
                 FROM action_approvals a
                 JOIN executions e ON e.execution_id = a.execution_id
                WHERE a.route_kind = 'Executable' AND a.binding_proven = 1
                  AND a.execution_id = ? AND a.state IN ('Pending','Approved')
                  AND a.consumed_by IS NULL
                ORDER BY a.logical_step_no, a.repair_attempt, a.action_index,
                         a.logical_action_id`,
              [input.executionId],
            ),
          );
          const cancelled: Array<ExecutableApprovalRecord> = [];
          for (const candidate of candidates) {
            if (
              candidate.project_id === null ||
              candidate.workspace_id === null ||
              candidate.project_id !== candidate.execution_project_id ||
              candidate.workspace_id !== candidate.execution_workspace_id ||
              candidate.execution_id === null ||
              candidate.logical_step_no === null ||
              candidate.repair_attempt === null ||
              candidate.action_index === null ||
              candidate.logical_action_id === null ||
              candidate.call_ref === null ||
              candidate.tool_invocation_id === null
            ) {
              return yield* Effect.fail(
                persistenceCorruption(
                  "ToolInvocationStore",
                  "executable-approval-cancel",
                  "proven Executable approval has an incomplete or foreign binding",
                ),
              );
            }
            const changed = yield* run(
              sql.unsafe<ApprovalRow>(
                `UPDATE action_approvals
                    SET state = 'Cancelled', revision = revision + 1,
                        cancelled_at = ?, cancelled_by = ?,
                        cancellation_reason = ?
                  WHERE approval_id = ? AND route_kind = 'Executable'
                    AND binding_proven = 1 AND project_id = ?
                    AND execution_id = ? AND revision = ?
                    AND state IN ('Pending','Approved') AND consumed_by IS NULL
                  RETURNING *`,
                [
                  input.cancelledAt,
                  input.cancelledBy,
                  input.reason,
                  candidate.approval_id,
                  candidate.project_id,
                  input.executionId,
                  candidate.revision,
                ],
              ),
            );
            const row = changed[0];
            if (row === undefined) {
              const latestRows = yield* run(
                sql.unsafe<ApprovalRow>(
                  `SELECT * FROM action_approvals
                    WHERE approval_id = ? AND route_kind = 'Executable'
                      AND binding_proven = 1 AND project_id = ?
                      AND execution_id = ?`,
                  [
                    candidate.approval_id,
                    candidate.project_id,
                    input.executionId,
                  ],
                ),
              );
              const latest = latestRows[0];
              if (latest === undefined) {
                return yield* Effect.fail(
                  persistenceCorruption(
                    "ToolInvocationStore",
                    "executable-approval-cancel",
                    "approval disappeared during Stop/Expire CAS",
                  ),
                );
              }
              const latestApproval = toApproval(latest);
              if (
                !executableApprovalBindingMatches(
                  immutableBindingOf(toApproval(candidate)),
                  immutableBindingOf(latestApproval),
                )
              ) {
                return yield* Effect.fail(
                  persistenceCorruption(
                    "ToolInvocationStore",
                    "executable-approval-cancel",
                    "approval binding changed during Stop/Expire CAS",
                  ),
                );
              }
              // Resolve/Expire/Consume won the same exact-revision CAS before
              // Stop. Its Inbox and wake fact already committed, so Stop keeps
              // its own stop transaction and does not emit a duplicate event.
              if (
                ["Rejected", "Expired", "Consumed", "Cancelled"].includes(
                  latestApproval.state,
                )
              ) {
                continue;
              }
              return yield* Effect.fail(
                persistenceCorruption(
                  "ToolInvocationStore",
                  "executable-approval-cancel",
                  "approval CAS lost without an exact terminal winner",
                ),
              );
            }
            const inboxConsumed = yield* run(
              sql.unsafe<{ entry_key: string }>(
                "UPDATE inbox_entries SET consumed_at = ? WHERE workspace_id = ? AND entry_key = ? AND consumed_at IS NULL RETURNING entry_key",
                [
                  input.cancelledAt,
                  candidate.workspace_id,
                  `eap:${candidate.approval_id}:0`,
                ],
              ),
            );
            // A still-Pending approval has never had its original Inbox item
            // consumed; absence here is a broken atomic-admission invariant.
            // An Approved row's revision-0 Inbox key may already be consumed
            // by the human decision, so preserve that historical state.
            if (candidate.state === "Pending" && inboxConsumed.length !== 1) {
              return yield* Effect.fail(
                persistenceCorruption(
                  "ToolInvocationStore",
                  "executable-approval-cancel",
                  "Pending approval has no unconsumed exact Inbox entry",
                ),
              );
            }
            cancelled.push(toApproval(row));
          }
          return cancelled;
        }),
    });
  }),
);
