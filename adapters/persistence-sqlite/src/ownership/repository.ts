import {
  Clock,
  ResourceOwnershipRepository,
  TransactionScope,
} from "@arbor/ports";
import {
  Effect,
  Layer,
} from "effect";
import {
  SqlClient,
} from "effect/unstable/sql/SqlClient";
import type {
  SqlError,
} from "effect/unstable/sql/SqlError";
import {
  repositoryFailure,
} from "../repository-error.js";
import {
  type ClaimRow,
  toClaim,
} from "./claim-codec.js";

export const ResourceOwnershipRepositoryLive: Layer.Layer<
  ResourceOwnershipRepository,
  never,
  SqlClient | Clock
> = Layer.effect(
  ResourceOwnershipRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const clock = yield* Clock;
    const failure = repositoryFailure(
      "ResourceOwnershipRepository",
      "ownership",
    );
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    let carveoutColumnsAvailable: boolean | undefined;
    const supportsCarveouts = Effect.gen(function* () {
      if (carveoutColumnsAvailable !== undefined)
        return carveoutColumnsAvailable;
      const rows = yield* run(
        sql.unsafe<{ name: string }>("PRAGMA table_info(resource_ownership)"),
      );
      carveoutColumnsAvailable = rows.some(
        ({ name }) => name === "exclusions_json",
      );
      return carveoutColumnsAvailable;
    });
    return ResourceOwnershipRepository.of({
      loadActiveConflicts: (resourceSpaceId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<ClaimRow>(
              "SELECT * FROM resource_ownership WHERE resource_space_id = ? AND released_at IS NULL",
              [resourceSpaceId],
            ),
          );
          return rows.map(toClaim);
        }),
      insertClaim: (claim) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = yield* clock.now();
          if (yield* supportsCarveouts) {
            yield* run(
              sql.unsafe(
                "INSERT INTO resource_ownership (claim_id, workspace_id, resource_space_id, canonical_region, source_address_snapshot, resource_boundary_revision, resolved_at_environment_revision, created_at, released_at, exclusions_json, delegating_workspace_id, delegation_source_id, claim_revision) VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?,?)",
                [
                  claim.claimId,
                  claim.workspaceId,
                  claim.region.resourceSpaceId,
                  JSON.stringify(claim.region),
                  JSON.stringify(claim.sourceAddressSnapshot),
                  claim.resourceBoundaryRevision,
                  claim.resolvedAtEnvironmentRevision,
                  claim.createdAt === "" ? now : claim.createdAt,
                  JSON.stringify(claim.exclusions ?? []),
                  claim.delegatingWorkspaceId ?? null,
                  claim.delegationSourceId ?? null,
                  claim.claimRevision ?? 0,
                ],
              ),
            );
          } else {
            yield* run(
              sql.unsafe(
                "INSERT INTO resource_ownership (claim_id, workspace_id, resource_space_id, canonical_region, source_address_snapshot, resource_boundary_revision, resolved_at_environment_revision, created_at, released_at) VALUES (?,?,?,?,?,?,?,?,NULL)",
                [
                  claim.claimId,
                  claim.workspaceId,
                  claim.region.resourceSpaceId,
                  JSON.stringify(claim.region),
                  JSON.stringify(claim.sourceAddressSnapshot),
                  claim.resourceBoundaryRevision,
                  claim.resolvedAtEnvironmentRevision,
                  claim.createdAt === "" ? now : claim.createdAt,
                ],
              ),
            );
          }
        }),
      applyDelegation: (input) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const parent = input.parentPostImage;
          const updated = yield* run(
            sql.unsafe<{ claim_id: string }>(
              `UPDATE resource_ownership
                  SET exclusions_json = ?, claim_revision = ?, released_at = ?
                WHERE claim_id = ? AND claim_revision = ? AND released_at IS NULL
                RETURNING claim_id`,
              [
                JSON.stringify(parent.exclusions ?? []),
                parent.claimRevision ?? input.expectedParentClaimRevision + 1,
                parent.releasedAt ?? null,
                input.parentClaimId,
                input.expectedParentClaimRevision,
              ],
            ),
          );
          if (updated.length !== 1) {
            return yield* Effect.fail({
              _tag: "PersistenceConstraintViolation" as const,
              repository: "ResourceOwnershipRepository" as const,
              operation: "apply-delegation",
              constraintKind: "Constraint" as const,
              constraint: "stale-parent-claim-revision",
            });
          }
          const child = input.childClaim;
          const now = yield* clock.now();
          yield* run(
            sql.unsafe(
              `INSERT INTO resource_ownership (
                claim_id, workspace_id, resource_space_id, canonical_region,
                source_address_snapshot, resource_boundary_revision,
                resolved_at_environment_revision, created_at, released_at,
                exclusions_json, delegating_workspace_id, delegation_source_id,
                claim_revision
              ) VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?,?)`,
              [
                child.claimId,
                child.workspaceId,
                child.region.resourceSpaceId,
                JSON.stringify(child.region),
                JSON.stringify(child.sourceAddressSnapshot),
                child.resourceBoundaryRevision,
                child.resolvedAtEnvironmentRevision,
                child.createdAt === "" ? now : child.createdAt,
                JSON.stringify(child.exclusions ?? []),
                child.delegatingWorkspaceId ?? null,
                child.delegationSourceId ?? null,
                child.claimRevision ?? 0,
              ],
            ),
          );
        }),
      applyReclaim: (input) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const child = yield* run(
            sql.unsafe<{ claim_id: string }>(
              `UPDATE resource_ownership
                  SET released_at = ?, claim_revision = ?
                WHERE claim_id = ? AND claim_revision = ? AND released_at IS NULL
                RETURNING claim_id`,
              [
                input.childReleasedAt,
                input.childNextClaimRevision,
                input.childClaimId,
                input.expectedChildClaimRevision,
              ],
            ),
          );
          if (child.length !== 1) {
            return yield* Effect.fail({
              _tag: "PersistenceConstraintViolation" as const,
              repository: "ResourceOwnershipRepository" as const,
              operation: "apply-reclaim",
              constraintKind: "Constraint" as const,
              constraint: "stale-child-claim-revision",
            });
          }
          if (input.parentClaimId !== null && input.parentPostImage !== null) {
            const parent = yield* run(
              sql.unsafe<{ claim_id: string }>(
                `UPDATE resource_ownership
                    SET exclusions_json = ?, claim_revision = ?
                  WHERE claim_id = ? AND claim_revision = ? AND released_at IS NULL
                  RETURNING claim_id`,
                [
                  JSON.stringify(input.parentPostImage.exclusions ?? []),
                  input.parentPostImage.claimRevision,
                  input.parentClaimId,
                  input.expectedParentClaimRevision,
                ],
              ),
            );
            if (parent.length !== 1) {
              return yield* Effect.fail({
                _tag: "PersistenceConstraintViolation" as const,
                repository: "ResourceOwnershipRepository" as const,
                operation: "apply-reclaim",
                constraintKind: "Constraint" as const,
                constraint: "stale-parent-claim-revision",
              });
            }
          }
          if (input.restoredParentClaim !== null) {
            const parent = input.restoredParentClaim;
            const now = yield* clock.now();
            yield* run(
              sql.unsafe(
                `INSERT INTO resource_ownership (
                  claim_id, workspace_id, resource_space_id, canonical_region,
                  source_address_snapshot, resource_boundary_revision,
                  resolved_at_environment_revision, created_at, released_at,
                  exclusions_json, delegating_workspace_id, delegation_source_id,
                  claim_revision
                ) VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?,?)`,
                [
                  parent.claimId,
                  parent.workspaceId,
                  parent.region.resourceSpaceId,
                  JSON.stringify(parent.region),
                  JSON.stringify(parent.sourceAddressSnapshot),
                  parent.resourceBoundaryRevision,
                  parent.resolvedAtEnvironmentRevision,
                  parent.createdAt === "" ? now : parent.createdAt,
                  JSON.stringify(parent.exclusions ?? []),
                  parent.delegatingWorkspaceId ?? null,
                  parent.delegationSourceId ?? null,
                  parent.claimRevision ?? 0,
                ],
              ),
            );
          }
        }),
      releaseClaim: (claimId, releasedAt) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(
            sql.unsafe(
              "UPDATE resource_ownership SET released_at = ? WHERE claim_id = ? AND released_at IS NULL",
              [releasedAt, claimId],
            ),
          );
        }),
      listActiveByWorkspace: (workspaceId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<ClaimRow>(
              "SELECT * FROM resource_ownership WHERE workspace_id = ? AND released_at IS NULL",
              [workspaceId],
            ),
          );
          return rows.map(toClaim);
        }),
      listByWorkspace: (workspaceId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<ClaimRow>(
              "SELECT * FROM resource_ownership WHERE workspace_id = ? ORDER BY claim_id",
              [workspaceId],
            ),
          );
          return rows.map(toClaim);
        }),
    });
  }),
);

