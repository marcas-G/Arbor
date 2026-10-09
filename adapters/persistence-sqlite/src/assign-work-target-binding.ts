import type { CommandId, ExecutionId } from "@arbor/domain";
import type {
  AssignWorkTargetBinding,
  AssignWorkTargetBindingStoreError,
} from "@arbor/ports";
import {
  AssignWorkTargetBindingRepository,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { repositoryFailure } from "./repository-error.js";

interface BindingRow {
  readonly schema_version: number;
  readonly command_id: string;
  readonly project_id: string;
  readonly execution_id: string;
  readonly provider_turn_id: string;
  readonly logical_action_id: string;
  readonly call_ref: string;
  readonly parent_workspace_id: string;
  readonly parent_work_id: string;
  readonly parent_work_revision_at_command: number;
  readonly target_workspace_ref: string;
  readonly target_ref_encoding_version: number;
  readonly parent_workspace_revision_at_command: number;
  readonly target_workspace_revision_at_resolution: number;
  readonly target_workspace_id: string;
  readonly target_lifecycle_at_commit: string;
  readonly work_id: string;
  readonly predecessor_work_id: string;
  readonly work_provenance_json: string;
  readonly authority_evidence_json: string;
  readonly authority_checked_at: string;
}

const decode = (row: BindingRow): AssignWorkTargetBinding => {
  const authority: unknown = JSON.parse(row.authority_evidence_json);
  if (
    typeof authority !== "object" ||
    authority === null ||
    ((authority as { _tag?: unknown })._tag !== "PermissionGrant" &&
      (authority as { _tag?: unknown })._tag !== "ActionApproval") ||
    row.schema_version !== 1 ||
    row.target_ref_encoding_version !== 1 ||
    row.target_lifecycle_at_commit !== "Active"
  ) {
    throw new Error("malformed AssignWork target binding row");
  }
  return {
    schemaVersion: 1,
    commandId: row.command_id as never,
    projectId: row.project_id as never,
    executionId: row.execution_id as never,
    providerTurnId: row.provider_turn_id as never,
    logicalActionId: row.logical_action_id,
    callRef: row.call_ref,
    parentWorkspaceId: row.parent_workspace_id as never,
    parentWorkId: row.parent_work_id as never,
    parentWorkRevisionAtCommand: Number(row.parent_work_revision_at_command),
    targetWorkspaceRef: row.target_workspace_ref,
    targetRefEncodingVersion: 1,
    parentWorkspaceRevisionAtCommand: Number(
      row.parent_workspace_revision_at_command,
    ),
    targetWorkspaceRevisionAtResolution: Number(
      row.target_workspace_revision_at_resolution,
    ),
    targetWorkspaceId: row.target_workspace_id as never,
    targetLifecycleAtCommit: "Active",
    workId: row.work_id as never,
    predecessorWorkId: row.predecessor_work_id as never,
    workProvenanceJson: row.work_provenance_json,
    authority: authority as AssignWorkTargetBinding["authority"],
    authorityCheckedAt: row.authority_checked_at,
  };
};

const columns = `schema_version, command_id, project_id, execution_id,
  provider_turn_id, logical_action_id, call_ref, parent_workspace_id,
  parent_work_id, parent_work_revision_at_command, target_workspace_ref,
  target_ref_encoding_version, parent_workspace_revision_at_command,
  target_workspace_revision_at_resolution, target_workspace_id,
  target_lifecycle_at_commit, work_id, predecessor_work_id,
  work_provenance_json, authority_evidence_json, authority_checked_at`;

export const AssignWorkTargetBindingRepositoryLive: Layer.Layer<
  AssignWorkTargetBindingRepository,
  never,
  SqlClient
> = Layer.effect(
  AssignWorkTargetBindingRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(
        Effect.mapError(
          repositoryFailure(
            "AssignWorkTargetBindingRepository",
            "assign-work-target-binding",
          ),
        ),
      );
    const decodeRows = (rows: ReadonlyArray<BindingRow>) => {
      try {
        return Effect.succeed(rows.map(decode));
      } catch (cause) {
        return Effect.fail<AssignWorkTargetBindingStoreError>({
          _tag: "PersistenceCorruption",
          repository: "AssignWorkTargetBindingRepository",
          operation: "decode",
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    };
    return AssignWorkTargetBindingRepository.of({
      findByCommandId: (commandId: CommandId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<BindingRow>(
              `SELECT ${columns} FROM assign_work_target_bindings WHERE command_id = ?`,
              [commandId],
            ),
          );
          const decoded = yield* decodeRows(rows);
          return decoded[0] === undefined
            ? Option.none()
            : Option.some(decoded[0]);
        }),
      findByExecutionAndAction: (
        executionId: ExecutionId,
        logicalActionId: string,
      ) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<BindingRow>(
              `SELECT ${columns} FROM assign_work_target_bindings WHERE execution_id = ? AND logical_action_id = ? ORDER BY command_id`,
              [executionId, logicalActionId],
            ),
          );
          return yield* decodeRows(rows);
        }),
      insert: (binding: AssignWorkTargetBinding) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(
            sql.unsafe(
              `INSERT INTO assign_work_target_bindings (
                command_id, schema_version, project_id, execution_id,
                provider_turn_id, logical_action_id, call_ref,
                parent_workspace_id, parent_work_id,
                parent_work_revision_at_command, target_workspace_ref,
                target_ref_encoding_version, parent_workspace_revision_at_command,
                target_workspace_revision_at_resolution, target_workspace_id,
                target_lifecycle_at_commit, work_id, predecessor_work_id,
                work_provenance_json, authority_kind, permission_grant_id,
                action_approval_id, authority_evidence_json, authority_checked_at,
                created_at
              ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              [
                binding.commandId,
                binding.schemaVersion,
                binding.projectId,
                binding.executionId,
                binding.providerTurnId,
                binding.logicalActionId,
                binding.callRef,
                binding.parentWorkspaceId,
                binding.parentWorkId,
                binding.parentWorkRevisionAtCommand,
                binding.targetWorkspaceRef,
                binding.targetRefEncodingVersion,
                binding.parentWorkspaceRevisionAtCommand,
                binding.targetWorkspaceRevisionAtResolution,
                binding.targetWorkspaceId,
                binding.targetLifecycleAtCommit,
                binding.workId,
                binding.predecessorWorkId,
                binding.workProvenanceJson,
                binding.authority._tag,
                binding.authority._tag === "PermissionGrant"
                  ? binding.authority.permissionGrantId
                  : null,
                binding.authority._tag === "ActionApproval"
                  ? binding.authority.approvalId
                  : null,
                JSON.stringify(binding.authority),
                binding.authorityCheckedAt,
                binding.authorityCheckedAt,
              ],
            ),
          );
        }),
    });
  }),
);
