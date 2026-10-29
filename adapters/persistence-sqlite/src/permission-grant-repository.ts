import type {
  PermissionGrant,
  ProjectId,
  SandboxPolicyGrantIssuerProvenanceV1,
} from "@arbor/domain";
import { CommandId, PermissionGrantId, Principal, parse } from "@arbor/domain";
import {
  PermissionGrantRepository,
  type PermissionGrantRepositoryError,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { repositoryFailure } from "./repository-error.js";

interface PermissionGrantRow {
  readonly permission_grant_id: string;
  readonly scope: string;
  readonly issuer: string;
  readonly lifetime: string;
  readonly state: string;
  readonly subject_kind?: string | null;
  readonly subject_ref?: string | null;
  readonly capability?: string | null;
  readonly target?: string | null;
  readonly valid_from?: string | null;
  readonly expires_at?: string | null;
  readonly revision?: number | null;
}

const toPermissionGrant = (row: PermissionGrantRow): PermissionGrant =>
  ({
    permissionGrantId: row.permission_grant_id,
    scope: row.scope,
    issuer: row.issuer,
    lifetime: row.lifetime,
    ...(row.subject_kind === "HumanPrincipal" && row.subject_ref != null
      ? {
          subject: {
            _tag: "HumanPrincipal" as const,
            principal: row.subject_ref as never,
          },
        }
      : row.subject_kind === "WorkspaceAgent" && row.subject_ref != null
        ? {
            subject: {
              _tag: "WorkspaceAgent" as const,
              workspaceId: row.subject_ref as never,
            },
          }
        : row.subject_kind === "Execution" && row.subject_ref != null
          ? {
              subject: {
                _tag: "Execution" as const,
                executionId: row.subject_ref as never,
              },
            }
          : {}),
    ...(row.capability == null ? {} : { capability: row.capability }),
    ...(row.target === undefined ? {} : { target: row.target }),
    ...(row.valid_from == null ? {} : { validFrom: row.valid_from }),
    ...(row.expires_at === undefined ? {} : { expiresAt: row.expires_at }),
    ...(row.revision == null ? {} : { revision: Number(row.revision) }),
    state: row.state,
  }) as unknown as PermissionGrant;

/**
 * P12 `02` §5.1 — the durable `permission_grants` store.
 *
 * `activeGrants` loads only `state = 'Active'` (a revoked grant is never
 * loaded). `put` / `revoke` are durable canonical writes invoked only by the
 * `GrantPermission` / `RevokePermission` handlers inside the command gateway
 * transaction (CI-1).
 */
export const PermissionGrantRepositoryLive: Layer.Layer<
  PermissionGrantRepository,
  never,
  SqlClient
> = Layer.effect(
  PermissionGrantRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient;

    const run = <A>(
      effect: Effect.Effect<A, SqlError>,
    ): Effect.Effect<A, PermissionGrantRepositoryError> =>
      effect.pipe(
        Effect.mapError(
          repositoryFailure("PermissionGrantRepository", "permission-grant"),
        ),
      );

    return PermissionGrantRepository.of({
      activeGrants: (projectId: ProjectId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const columns = yield* run(
            sql.unsafe<{ name: string }>(
              "PRAGMA table_info(permission_grants)",
            ),
          );
          const v2 = columns.some((column) => column.name === "subject_kind");
          const rows = yield* run(
            sql.unsafe<PermissionGrantRow>(
              v2
                ? "SELECT permission_grant_id, scope, issuer, lifetime, state, subject_kind, subject_ref, capability, target, valid_from, expires_at, revision FROM permission_grants WHERE project_id = ? AND state = 'Active'"
                : "SELECT permission_grant_id, scope, issuer, lifetime, state FROM permission_grants WHERE project_id = ? AND state = 'Active'",
              [projectId],
            ),
          );
          return rows.map(toPermissionGrant);
        }),
      findById: (permissionGrantId: PermissionGrantId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<PermissionGrantRow>(
              `SELECT permission_grant_id, scope, issuer, lifetime, state,
                      subject_kind, subject_ref, capability, target,
                      valid_from, expires_at, revision
                 FROM permission_grants WHERE permission_grant_id = ?`,
              [permissionGrantId],
            ),
          );
          return rows[0] === undefined
            ? Option.none()
            : Option.some(toPermissionGrant(rows[0]));
        }),
      findSandboxPolicyGrantIssuerProvenanceByGrantId: (
        permissionGrantId: PermissionGrantId,
      ) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<{
              permission_grant_id: string;
              grant_permission_command_id: string;
              issuer_principal: string;
              operator_config_revision: number;
              operator_config_digest: string;
            }>(
              `SELECT permission_grant_id, grant_permission_command_id,
                      issuer_principal, operator_config_revision,
                      operator_config_digest
                 FROM sandbox_policy_grant_issuer_provenance
                WHERE permission_grant_id = ?`,
              [permissionGrantId],
            ),
          );
          const row = rows[0];
          if (row === undefined) return Option.none();
          if (
            !Number.isSafeInteger(row.operator_config_revision) ||
            row.operator_config_revision < 1 ||
            !/^[0-9a-f]{64}$/u.test(row.operator_config_digest) ||
            !row.issuer_principal.startsWith("user:")
          ) {
            return yield* Effect.fail({
              _tag: "PersistenceCorruption" as const,
              repository: "PermissionGrantRepository" as const,
              operation: "find-sandbox-policy-grant-provenance",
              reason: "stored sandbox grant provenance failed strict decoding",
            });
          }
          try {
            return Option.some({
              permissionGrantId: parse(PermissionGrantId)(
                row.permission_grant_id,
              ),
              grantPermissionCommandId: parse(CommandId)(
                row.grant_permission_command_id,
              ),
              issuerPrincipal: parse(Principal)(row.issuer_principal),
              operatorConfigRevision: row.operator_config_revision,
              operatorConfigDigest: row.operator_config_digest,
            });
          } catch {
            return yield* Effect.fail({
              _tag: "PersistenceCorruption" as const,
              repository: "PermissionGrantRepository" as const,
              operation: "find-sandbox-policy-grant-provenance",
              reason: "stored sandbox grant provenance failed strict decoding",
            });
          }
        }),
      insertSandboxPolicyGrantIssuerProvenance: (
        provenance: SandboxPolicyGrantIssuerProvenanceV1,
      ) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          if (
            !Number.isSafeInteger(provenance.operatorConfigRevision) ||
            provenance.operatorConfigRevision < 1 ||
            !/^[0-9a-f]{64}$/u.test(provenance.operatorConfigDigest) ||
            !provenance.issuerPrincipal.startsWith("user:")
          ) {
            return yield* Effect.fail({
              _tag: "PersistenceCorruption" as const,
              repository: "PermissionGrantRepository" as const,
              operation: "insert-sandbox-policy-grant-provenance",
              reason: "sandbox grant provenance failed strict validation",
            });
          }
          yield* run(
            sql.unsafe(
              `INSERT INTO sandbox_policy_grant_issuer_provenance (
                permission_grant_id, grant_permission_command_id,
                issuer_principal, operator_config_revision,
                operator_config_digest
              ) VALUES (?, ?, ?, ?, ?)`,
              [
                provenance.permissionGrantId,
                provenance.grantPermissionCommandId,
                provenance.issuerPrincipal,
                provenance.operatorConfigRevision,
                provenance.operatorConfigDigest,
              ],
            ),
          );
        }),
      put: (grant: PermissionGrant, projectId: ProjectId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const columns = yield* run(
            sql.unsafe<{ name: string }>(
              "PRAGMA table_info(permission_grants)",
            ),
          );
          const v2 = columns.some((column) => column.name === "subject_kind");
          if (!v2) {
            yield* run(
              sql.unsafe(
                "INSERT INTO permission_grants (permission_grant_id, project_id, scope, issuer, lifetime, state) VALUES (?,?,?,?,?,?)",
                [
                  grant.permissionGrantId,
                  projectId,
                  grant.scope,
                  grant.issuer,
                  grant.lifetime,
                  grant.state,
                ],
              ),
            );
            return;
          }
          yield* run(
            sql.unsafe(
              "INSERT INTO permission_grants (permission_grant_id, project_id, scope, issuer, lifetime, state, subject_kind, subject_ref, capability, target, valid_from, expires_at, revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
              [
                grant.permissionGrantId,
                projectId,
                grant.scope,
                grant.issuer,
                grant.lifetime,
                grant.state,
                grant.subject?._tag ?? null,
                grant.subject === undefined
                  ? null
                  : grant.subject._tag === "HumanPrincipal"
                    ? grant.subject.principal
                    : grant.subject._tag === "WorkspaceAgent"
                      ? grant.subject.workspaceId
                      : grant.subject.executionId,
                grant.capability ?? null,
                grant.target ?? null,
                grant.validFrom ?? null,
                grant.expiresAt ?? null,
                grant.revision ?? 0,
              ],
            ),
          );
        }),
      revoke: (permissionGrantId: PermissionGrantId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<{ permission_grant_id: string }>(
              "UPDATE permission_grants SET state = 'Revoked' WHERE permission_grant_id = ? AND state = 'Active' RETURNING permission_grant_id",
              [permissionGrantId],
            ),
          );
          if (rows.length === 0) {
            return yield* Effect.fail<PermissionGrantRepositoryError>({
              _tag: "PermissionGrantNotFound",
              permissionGrantId,
            });
          }
        }),
    });
  }),
);
