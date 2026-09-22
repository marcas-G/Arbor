import type {
  PermissionGrant,
  PermissionGrantId,
  ProjectId,
} from "@arbor/domain";
import {
  PermissionGrantRepository,
  type PermissionGrantRepositoryError,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

interface PermissionGrantRow {
  readonly permission_grant_id: string;
  readonly scope: string;
  readonly issuer: string;
  readonly lifetime: string;
  readonly state: string;
}

const toPermissionGrant = (row: PermissionGrantRow): PermissionGrant =>
  ({
    permissionGrantId: row.permission_grant_id,
    scope: row.scope,
    issuer: row.issuer,
    lifetime: row.lifetime,
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
          (cause): PermissionGrantRepositoryError => ({
            _tag: "PermissionGrantRepositoryFailure",
            cause,
          }),
        ),
      );

    return PermissionGrantRepository.of({
      activeGrants: (projectId: ProjectId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<PermissionGrantRow>(
              "SELECT permission_grant_id, scope, issuer, lifetime, state FROM permission_grants WHERE project_id = ? AND state = 'Active'",
              [projectId],
            ),
          );
          return rows.map(toPermissionGrant);
        }),
      put: (grant: PermissionGrant, projectId: ProjectId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
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
