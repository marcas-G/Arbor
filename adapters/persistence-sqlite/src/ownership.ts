import {
  type CanonicalResourceRegion,
  type ProjectId,
  type ResourceAddress,
  type ResourceBoundaryRevision,
  regionsOverlap,
  type WorkspaceId,
} from "@arbor/domain";
import {
  Clock,
  type EnvironmentError,
  EnvironmentRevisionStore,
  type EnvironmentRevisionStoreError,
  type OwnershipWriteResult,
  OwnershipWriteService,
  ProjectEnvironmentPort,
  type ResourceOwnershipClaimRecord,
  ResourceOwnershipRepository,
  type ResourceOwnershipRepositoryError,
  type ResourceResolutionStale,
  resourceRegionComparator,
  type TransactionOperationalFailure,
  TransactionPort,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

interface ClaimRow {
  readonly claim_id: string;
  readonly workspace_id: string;
  readonly resource_space_id: string;
  readonly canonical_region: string;
  readonly source_address_snapshot: string;
  readonly resource_boundary_revision: number;
  readonly resolved_at_environment_revision: string;
  readonly created_at: string;
  readonly released_at: string | null;
}

const toClaim = (row: ClaimRow): ResourceOwnershipClaimRecord => ({
  claimId: row.claim_id,
  workspaceId: row.workspace_id as WorkspaceId,
  region: JSON.parse(row.canonical_region) as CanonicalResourceRegion,
  sourceAddressSnapshot: JSON.parse(
    row.source_address_snapshot,
  ) as ResourceAddress,
  resourceBoundaryRevision: Number(
    row.resource_boundary_revision,
  ) as ResourceBoundaryRevision,
  resolvedAtEnvironmentRevision: row.resolved_at_environment_revision,
  createdAt: row.created_at,
  releasedAt: row.released_at,
});

export const ResourceOwnershipRepositoryLive: Layer.Layer<
  ResourceOwnershipRepository,
  never,
  SqlClient | Clock
> = Layer.effect(
  ResourceOwnershipRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const clock = yield* Clock;
    const failure = (cause: unknown): ResourceOwnershipRepositoryError => ({
      _tag: "ResourceOwnershipRepositoryFailure",
      cause,
    });
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
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
    });
  }),
);

export const EnvironmentRevisionStoreLive: Layer.Layer<
  EnvironmentRevisionStore,
  never,
  SqlClient | Clock
> = Layer.effect(
  EnvironmentRevisionStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const clock = yield* Clock;
    const failure = (cause: unknown): EnvironmentRevisionStoreError => ({
      _tag: "EnvironmentRevisionStoreFailure",
      cause,
    });
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    return EnvironmentRevisionStore.of({
      current: (projectId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<{ revision: string | null }>(
              "SELECT revision FROM environment_revisions WHERE project_id = ?",
              [projectId],
            ),
          );
          const revision = rows[0]?.revision;
          return revision === undefined || revision === null
            ? Option.none()
            : Option.some(revision);
        }),
      record: (projectId, revision) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = yield* clock.now();
          yield* run(
            sql.unsafe(
              "INSERT INTO environment_revisions (project_id, revision, updated_at) VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at",
              [projectId, revision, now],
            ),
          );
        }),
      // P11 `01` §2 (P1-DG-08): first successful ownership write records the
      // initial anchor "1"; no event, no wake. No-op afterwards.
      lazyInitAnchor: (projectId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = yield* clock.now();
          yield* run(
            sql.unsafe(
              "INSERT INTO environment_revisions (project_id, revision, updated_at) VALUES (?, '1', ?) ON CONFLICT(project_id) DO NOTHING",
              [projectId, now],
            ),
          );
        }),
      // P12 `05` §5.1 (TR-1): `advanceAnchor` is no longer on the public
      // `EnvironmentRevisionStore` port. CAS successor advancement is the
      // internal, non-exported `EnvironmentRevisionAdvancement` capability
      // (see `environment-advancement.ts`); the governed
      // `RecordEnvironmentChange` command path is the sole production
      // advancement authority (CI-1).
    });
  }),
);

export const OwnershipWriteServiceLive: Layer.Layer<
  OwnershipWriteService,
  never,
  | ProjectEnvironmentPort
  | TransactionPort
  | ResourceOwnershipRepository
  | EnvironmentRevisionStore
> = Layer.effect(
  OwnershipWriteService,
  Effect.gen(function* () {
    const environment = yield* ProjectEnvironmentPort;
    const tx = yield* TransactionPort;
    const repository = yield* ResourceOwnershipRepository;
    const revisions = yield* EnvironmentRevisionStore;

    const resolveAndWrite = (
      projectId: ProjectId,
      addresses: ReadonlyArray<ResourceAddress>,
      claims: ReadonlyArray<ResourceOwnershipClaimRecord>,
    ): Effect.Effect<
      OwnershipWriteResult,
      | EnvironmentError
      | ResourceOwnershipRepositoryError
      | ResourceResolutionStale
      | TransactionOperationalFailure
      | EnvironmentRevisionStoreError
    > =>
      Effect.gen(function* () {
        const resolved = yield* environment.resolve(projectId, addresses);
        yield* tx.transact(
          Effect.gen(function* () {
            const current = yield* revisions.current(projectId);
            if (
              Option.isSome(current) &&
              current.value !== resolved.observedEnvironmentRevision
            ) {
              return yield* Effect.fail<ResourceResolutionStale>({
                _tag: "ResourceResolutionStale",
                observed: resolved.observedEnvironmentRevision,
                current: current.value,
              });
            }
            const conflicts = yield* Effect.forEach(
              resolved.regions,
              (region) =>
                repository.loadActiveConflicts(region.resourceSpaceId),
            );
            const active = conflicts.flat();
            const overlap = claims.some((claim) =>
              active.some((existing) =>
                regionsOverlap(
                  existing.region,
                  claim.region,
                  resourceRegionComparator,
                ),
              ),
            );
            if (overlap) {
              return yield* Effect.fail<ResourceOwnershipRepositoryError>({
                _tag: "ResourceOwnershipRepositoryFailure",
                cause: "resource ownership overlap",
              });
            }
            yield* Effect.forEach(claims, (claim) =>
              repository.insertClaim(claim),
            );
            yield* revisions.record(
              projectId,
              resolved.observedEnvironmentRevision,
            );
          }),
        );
        return { regions: resolved.regions, claims };
      });

    return OwnershipWriteService.of({ resolveAndWrite });
  }),
);
