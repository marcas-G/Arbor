import type {
  ProjectId,
  ResourceBoundaryRevision,
  Revision,
  WorkspaceId,
} from "@arbor/domain";
import type {
  WorkspaceResourceActivationIntent,
  WorkspaceResourceActivationStoreError,
  WorkspaceResourceActivationStoreService,
  WorkspaceResourceDelegationIntent,
} from "@arbor/ports";
import {
  TransactionScope,
  WorkspaceResourceActivationStore,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { repositoryFailure } from "./repository-error.js";

interface ActivationIntentRow {
  readonly project_id: string;
  readonly workspace_id: string;
  readonly resource_boundary_revision: number;
  readonly status: "Pending" | "Active";
  readonly created_at: string;
  readonly updated_at: string;
  readonly activated_at: string | null;
  readonly parent_workspace_id: string | null;
  readonly delegation_source_id: string | null;
  readonly delegation_json: string | null;
  readonly expected_parent_workspace_revision: number | null;
  readonly expected_child_workspace_revision: number | null;
  readonly expected_parent_boundary_revision: number | null;
  readonly expected_parent_ownership_revision: number | null;
  readonly expected_child_ownership_revision: number | null;
}

const columns = `project_id, workspace_id, resource_boundary_revision,
  status, created_at, updated_at, activated_at, parent_workspace_id,
  delegation_source_id, delegation_json, expected_parent_workspace_revision,
  expected_child_workspace_revision, expected_parent_boundary_revision,
  expected_parent_ownership_revision, expected_child_ownership_revision`;

const decode = (
  row: ActivationIntentRow,
): WorkspaceResourceActivationIntent => {
  let delegation: WorkspaceResourceDelegationIntent | null = null;
  if (row.delegation_source_id !== null || row.delegation_json !== null) {
    if (
      row.delegation_source_id === null ||
      row.delegation_json === null ||
      row.parent_workspace_id === null ||
      row.expected_parent_workspace_revision === null ||
      row.expected_child_workspace_revision === null ||
      row.expected_parent_boundary_revision === null ||
      row.expected_parent_ownership_revision === null ||
      row.expected_child_ownership_revision === null
    ) {
      throw new Error("incomplete S3 delegation activation intent");
    }
    const stored = JSON.parse(row.delegation_json) as Omit<
      WorkspaceResourceDelegationIntent,
      | "delegationSourceId"
      | "parentWorkspaceId"
      | "expectedParentWorkspaceRevision"
      | "expectedChildWorkspaceRevision"
      | "expectedParentBoundaryRevision"
      | "expectedParentOwnershipRevision"
      | "expectedChildOwnershipRevision"
    >;
    delegation = {
      ...stored,
      delegationSourceId: row.delegation_source_id,
      parentWorkspaceId: row.parent_workspace_id as WorkspaceId,
      expectedParentWorkspaceRevision:
        row.expected_parent_workspace_revision as Revision,
      expectedChildWorkspaceRevision:
        row.expected_child_workspace_revision as Revision,
      expectedParentBoundaryRevision:
        row.expected_parent_boundary_revision as ResourceBoundaryRevision,
      expectedParentOwnershipRevision: row.expected_parent_ownership_revision,
      expectedChildOwnershipRevision: row.expected_child_ownership_revision,
    };
  }
  return {
    projectId: row.project_id as ProjectId,
    workspaceId: row.workspace_id as WorkspaceId,
    resourceBoundaryRevision: Number(
      row.resource_boundary_revision,
    ) as ResourceBoundaryRevision,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activatedAt: row.activated_at,
    ...(delegation === null ? {} : { delegation }),
  };
};

export const WorkspaceResourceActivationStoreLive: Layer.Layer<
  WorkspaceResourceActivationStore,
  never,
  SqlClient
> = Layer.effect(
  WorkspaceResourceActivationStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(
        Effect.mapError(
          repositoryFailure(
            "WorkspaceResourceActivationStore",
            "activation-intent",
          ),
        ),
      );
    const read = (
      query: string,
      parameters: ReadonlyArray<unknown>,
    ): Effect.Effect<
      ReadonlyArray<WorkspaceResourceActivationIntent>,
      WorkspaceResourceActivationStoreError,
      TransactionScope
    > =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const rows = yield* run(
          sql.unsafe<ActivationIntentRow>(query, parameters),
        );
        return rows.map(decode);
      });
    return WorkspaceResourceActivationStore.of({
      insertPending: (intent) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const delegation = intent.delegation ?? null;
          yield* run(
            sql.unsafe(
              `INSERT INTO workspace_resource_activation_intents (
                project_id, workspace_id, resource_boundary_revision,
                status, created_at, updated_at, activated_at, parent_workspace_id,
                delegation_source_id, delegation_json,
                expected_parent_workspace_revision,
                expected_child_workspace_revision, expected_parent_boundary_revision,
                expected_parent_ownership_revision, expected_child_ownership_revision
              ) VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?)`,
              [
                intent.projectId,
                intent.workspaceId,
                intent.resourceBoundaryRevision,
                intent.status,
                intent.createdAt,
                intent.updatedAt,
                delegation?.parentWorkspaceId ?? null,
                delegation?.delegationSourceId ?? null,
                delegation === null
                  ? null
                  : JSON.stringify({
                      formationProposalId: delegation.formationProposalId,
                      formationProposalRevision:
                        delegation.formationProposalRevision,
                      addresses: delegation.addresses,
                      approvedBy: delegation.approvedBy,
                      causedByCommandId: delegation.causedByCommandId,
                    }),
                delegation?.expectedParentWorkspaceRevision ?? null,
                delegation?.expectedChildWorkspaceRevision ?? null,
                delegation?.expectedParentBoundaryRevision ?? null,
                delegation?.expectedParentOwnershipRevision ?? null,
                delegation?.expectedChildOwnershipRevision ?? null,
              ],
            ),
          );
        }),
      find: (projectId, workspaceId, resourceBoundaryRevision) =>
        Effect.gen(function* () {
          const rows = yield* read(
            `SELECT ${columns} FROM workspace_resource_activation_intents
             WHERE project_id = ? AND workspace_id = ?
               AND resource_boundary_revision = ?`,
            [projectId, workspaceId, resourceBoundaryRevision],
          );
          return rows[0] === undefined ? Option.none() : Option.some(rows[0]);
        }),
      compareAndSetActive: (
        projectId,
        workspaceId,
        resourceBoundaryRevision,
        activatedAt,
        updatedAt,
        delegationSourceId,
      ) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<{ workspace_id: string }>(
              `UPDATE workspace_resource_activation_intents
               SET status = 'Active', activated_at = ?, updated_at = ?
               WHERE project_id = ? AND workspace_id = ?
               AND resource_boundary_revision = ? AND status = 'Pending'
               AND (? IS NULL OR delegation_source_id = ?)
               RETURNING workspace_id`,
              [
                activatedAt,
                updatedAt,
                projectId,
                workspaceId,
                resourceBoundaryRevision,
                delegationSourceId ?? null,
                delegationSourceId ?? null,
              ],
            ),
          );
          return rows.length === 1;
        }),
      listPending: (projectId) =>
        projectId === undefined
          ? read(
              `SELECT ${columns} FROM workspace_resource_activation_intents
               WHERE status = 'Pending'
               ORDER BY created_at, project_id, workspace_id,
                        resource_boundary_revision`,
              [],
            )
          : read(
              `SELECT ${columns} FROM workspace_resource_activation_intents
               WHERE status = 'Pending' AND project_id = ?
               ORDER BY created_at, workspace_id, resource_boundary_revision`,
              [projectId],
            ),
      listAll: () =>
        read(
          `SELECT ${columns} FROM workspace_resource_activation_intents
           ORDER BY created_at, project_id, workspace_id,
                    resource_boundary_revision`,
          [],
        ),
    } satisfies WorkspaceResourceActivationStoreService);
  }),
);
