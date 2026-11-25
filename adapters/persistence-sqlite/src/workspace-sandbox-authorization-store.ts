import {
  decodeCanonicalWorkspaceSandboxAuthorization,
  decodeWorkspaceSandboxAuthorization,
  encodeWorkspaceSandboxAuthorization,
} from "@arbor/domain";
import {
  TransactionScope,
  WorkspaceSandboxAuthorizationStore,
  type WorkspaceSandboxAuthorizationStoreError,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  persistenceCorruption,
  repositoryFailure,
} from "./repository-error.js";

interface AuthorizationRow {
  readonly project_id: string;
  readonly workspace_id: string;
  readonly authorization_revision: number;
  readonly command_id: string;
  readonly state: string;
  readonly record_json: string;
  readonly parent_workspace_id: string | null;
  readonly parent_authorization_revision: number | null;
  readonly receipt_project_id: string | null;
  readonly receipt_schema_version: string | null;
  readonly receipt_resolution: string | null;
  readonly receipt_result_json: string | null;
  readonly receipt_fingerprint_algorithm_version: number | null;
  readonly receipt_terminal_error_json: string | null;
}

const corruption = (
  operation: string,
): WorkspaceSandboxAuthorizationStoreError =>
  persistenceCorruption(
    "WorkspaceSandboxAuthorizationStore",
    operation,
    "workspace sandbox authorization or exact committed receipt is invalid",
  );

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const isAuthorizationReceipt = (
  value: Record<string, unknown>,
  schemaVersion: string | null,
  projectId: string,
  workspaceId: string,
): boolean => {
  if (Object.hasOwn(value, "authorization")) {
    return schemaVersion === "1" && hasExactKeys(value, ["authorization"]);
  }
  if (!Object.hasOwn(value, "workspaceAuthorization")) return false;
  if (
    schemaVersion === "2" &&
    hasExactKeys(value, [
      "projectId",
      "rootWorkspaceId",
      "primarySessionId",
      "workspaceAuthorization",
    ]) &&
    value.projectId === projectId &&
    value.rootWorkspaceId === workspaceId &&
    typeof value.primarySessionId === "string"
  )
    return true;
  return (
    schemaVersion === "1" &&
    hasExactKeys(value, [
      "workspaceId",
      "projectId",
      "parentWorkspaceId",
      "primarySessionId",
      "workspaceAuthorization",
    ]) &&
    value.projectId === projectId &&
    value.workspaceId === workspaceId &&
    typeof value.parentWorkspaceId === "string" &&
    typeof value.primarySessionId === "string"
  );
};

export const WorkspaceSandboxAuthorizationStoreLive = Layer.effect(
  WorkspaceSandboxAuthorizationStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return WorkspaceSandboxAuthorizationStore.of({
      findCurrent: (projectId, workspaceId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* sql
            .unsafe<AuthorizationRow>(
              `
          SELECT a.*, c.project_id AS receipt_project_id,
            c.schema_version AS receipt_schema_version, c.resolution AS receipt_resolution,
            c.result_json AS receipt_result_json,
            c.fingerprint_algorithm_version AS receipt_fingerprint_algorithm_version,
            c.terminal_error_json AS receipt_terminal_error_json
          FROM workspace_sandbox_authorizations a LEFT JOIN commands c ON c.command_id = a.command_id
          WHERE a.project_id = ? AND a.workspace_id = ?
          ORDER BY a.authorization_revision DESC LIMIT 1`,
              [projectId, workspaceId],
            )
            .pipe(
              Effect.mapError(
                repositoryFailure(
                  "WorkspaceSandboxAuthorizationStore",
                  "find-current",
                ),
              ),
            );
          const row = rows[0];
          if (row === undefined) return Option.none();
          const authorization = decodeCanonicalWorkspaceSandboxAuthorization(
            row.record_json,
          );
          let result: unknown;
          try {
            result = JSON.parse(row.receipt_result_json ?? "null");
          } catch {
            result = undefined;
          }
          const receipt =
            typeof result === "object" &&
            result !== null &&
            !Array.isArray(result)
              ? (result as Record<string, unknown>)
              : undefined;
          const receiptAuthorization =
            receipt?.authorization ?? receipt?.workspaceAuthorization;
          if (
            authorization === undefined ||
            authorization.projectId !== projectId ||
            authorization.workspaceId !== workspaceId ||
            authorization.projectId !== row.project_id ||
            authorization.workspaceId !== row.workspace_id ||
            authorization.authorizationRevision !==
              row.authorization_revision ||
            authorization.commandId !== row.command_id ||
            authorization.state !== row.state ||
            row.receipt_project_id !== projectId ||
            row.receipt_resolution !== "Committed" ||
            row.receipt_fingerprint_algorithm_version !== 1 ||
            row.receipt_terminal_error_json !== null ||
            receipt === undefined ||
            receiptAuthorization === undefined ||
            !isAuthorizationReceipt(
              receipt,
              row.receipt_schema_version,
              projectId,
              workspaceId,
            ) ||
            (() => {
              const fact =
                decodeWorkspaceSandboxAuthorization(receiptAuthorization);
              return (
                fact === undefined ||
                encodeWorkspaceSandboxAuthorization(fact) !== row.record_json
              );
            })() ||
            (authorization.state === "Granted" &&
            authorization.origin.kind === "Parent"
              ? row.parent_workspace_id !==
                  authorization.origin.parentWorkspaceId ||
                row.parent_authorization_revision !==
                  authorization.origin.parentAuthorizationRevision
              : row.parent_workspace_id !== null ||
                row.parent_authorization_revision !== null)
          )
            return yield* Effect.fail(corruption("find-current"));
          return Option.some(authorization);
        }),
      appendCommitted: (authorization) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const value = decodeWorkspaceSandboxAuthorization(authorization);
          if (value === undefined)
            return yield* Effect.fail(corruption("append-committed"));
          // BEGIN IMMEDIATE serializes cross-connection writers. Return a typed
          // conflict before INSERT; the trigger is a separate storage backstop.
          const current = yield* sql
            .unsafe<{ readonly revision: number }>(
              `SELECT COALESCE(MAX(authorization_revision), 0) AS revision
           FROM workspace_sandbox_authorizations WHERE project_id = ? AND workspace_id = ?`,
              [value.projectId, value.workspaceId],
            )
            .pipe(
              Effect.mapError(
                repositoryFailure(
                  "WorkspaceSandboxAuthorizationStore",
                  "append-head",
                ),
              ),
            );
          if (current[0]?.revision !== value.authorizationRevision - 1)
            return yield* Effect.fail<WorkspaceSandboxAuthorizationStoreError>({
              _tag: "WorkspaceSandboxAuthorizationStoreRevisionConflict",
            });
          const origin =
            value.state === "Granted" && value.origin.kind === "Parent"
              ? value.origin
              : undefined;
          yield* sql
            .unsafe(
              `INSERT INTO workspace_sandbox_authorizations
          (project_id, workspace_id, authorization_revision, previous_revision,
           command_id, state, record_json, parent_workspace_id, parent_authorization_revision)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                value.projectId,
                value.workspaceId,
                value.authorizationRevision,
                value.authorizationRevision === 1
                  ? null
                  : value.authorizationRevision - 1,
                value.commandId,
                value.state,
                encodeWorkspaceSandboxAuthorization(value),
                origin?.parentWorkspaceId ?? null,
                origin?.parentAuthorizationRevision ?? null,
              ],
            )
            .pipe(
              Effect.mapError(
                repositoryFailure(
                  "WorkspaceSandboxAuthorizationStore",
                  "append-committed",
                ),
              ),
            );
        }),
    });
  }),
);
