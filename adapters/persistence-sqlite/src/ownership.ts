import {
  Actor,
  type CanonicalResourceRegion,
  type ProjectId,
  parse,
  type ResourceAddress,
  type ResourceBoundaryRevision,
  regionsOverlap,
  type WorkspaceId,
} from "@arbor/domain";
import {
  Clock,
  DomainEventJournal,
  type EnvironmentError,
  EnvironmentResolverPort,
  EnvironmentRevisionStore,
  type EnvironmentRevisionStoreError,
  IdGenerator,
  type OwnershipWriteResult,
  OwnershipWriteService,
  type OwnershipWriteServiceService,
  type PendingDomainEvent,
  ProjectEnvironmentPort,
  type ResourceOwnershipClaimRecord,
  ResourceOwnershipRepository,
  type ResourceOwnershipRepositoryError,
  type ResourceResolutionStale,
  resourceRegionComparator,
  type TransactionOperationalFailure,
  TransactionPort,
  TransactionScope,
  WorkspaceRepository,
  WorkspaceResourceActivationStore,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { repositoryFailure } from "./repository-error.js";

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

export interface WorkspaceResourceActivationQualificationEvent {
  readonly boundary: "P11BeforeActivationCommit" | "P11AfterActivationCommit";
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly resourceBoundaryRevision: ResourceBoundaryRevision;
}

/** Process-local test seam for the two durable activation boundaries. */
export type WorkspaceResourceActivationQualificationProbe = (
  event: WorkspaceResourceActivationQualificationEvent,
) => Promise<void>;

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

const sourceAddressForRegion = (
  region: CanonicalResourceRegion,
  addresses: ReadonlyArray<ResourceAddress>,
): ResourceAddress | undefined => {
  const normalized = region.normalizedRegion as {
    readonly kind?: unknown;
    readonly _tag?: unknown;
    readonly path?: unknown;
    readonly namespace?: unknown;
    readonly address?: unknown;
  };
  const kind = normalized.kind ?? normalized._tag;
  return addresses.find((address) => {
    if (
      (kind === "FileTree" || kind === "GitWorktree") &&
      (address._tag === "FileTree" || address._tag === "GitWorktree")
    ) {
      return (
        address.path.replaceAll("\\", "/").toLowerCase() ===
        String(normalized.path).replaceAll("\\", "/").toLowerCase()
      );
    }
    if (kind === "DatabaseNamespace" && address._tag === "DatabaseNamespace") {
      return address.namespace === normalized.namespace;
    }
    return (
      kind === "ExternalResource" &&
      address._tag === "ExternalResource" &&
      address.address === normalized.address
    );
  });
};

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
    const failure = repositoryFailure(
      "EnvironmentRevisionStore",
      "environment-revision",
    );
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

const makeOwnershipWriteServiceEffect = (
  qualificationProbe?: WorkspaceResourceActivationQualificationProbe,
) =>
  Effect.gen(function* () {
    const environment = yield* ProjectEnvironmentPort;
    const environmentResolver = yield* Effect.serviceOption(
      EnvironmentResolverPort,
    );
    const tx = yield* TransactionPort;
    const repository = yield* ResourceOwnershipRepository;
    const revisions = yield* EnvironmentRevisionStore;
    const clock = yield* Clock;
    const workspaces = yield* WorkspaceRepository;
    const activationIntents = yield* WorkspaceResourceActivationStore;
    const journal = yield* DomainEventJournal;
    const ids = yield* IdGenerator;
    const activationActor = parse(Actor)(
      "system:workspace-resource-activation",
    );

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
                _tag: "PersistenceConstraintViolation",
                repository: "ResourceOwnershipRepository",
                operation: "insert-active-claim",
                constraintKind: "Constraint",
                constraint: "active-resource-overlap",
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

    const activatePendingWorkspaceResource: OwnershipWriteServiceService["activatePendingWorkspaceResource"] =
      (projectId, workspaceId, resourceBoundaryRevision, addresses) =>
        Effect.gen(function* () {
          const initial = yield* tx.transact(
            Effect.gen(function* () {
              const intent = yield* activationIntents.find(
                projectId,
                workspaceId,
                resourceBoundaryRevision,
              );
              if (Option.isNone(intent)) {
                return yield* Effect.fail({
                  _tag: "PersistenceCorruption" as const,
                  repository: "WorkspaceResourceActivationStore" as const,
                  operation: "activate",
                  reason: "the exact Pending activation intent does not exist",
                });
              }
              if (intent.value.status === "Active") {
                return { _tag: "AlreadyActive" as const };
              }
              const workspace = yield* workspaces.findById(workspaceId);
              if (
                Option.isNone(workspace) ||
                workspace.value.projectId !== projectId ||
                workspace.value.resourceBoundaryRevision !==
                  resourceBoundaryRevision ||
                JSON.stringify(workspace.value.resourceBoundary.addresses) !==
                  JSON.stringify(addresses)
              ) {
                return yield* Effect.fail({
                  _tag: "PersistenceCorruption" as const,
                  repository: "WorkspaceResourceActivationStore" as const,
                  operation: "activate",
                  reason:
                    "the supplied addresses do not match the pinned canonical Workspace boundary",
                });
              }
              return { _tag: "Pending" as const };
            }),
          );
          if (initial._tag === "AlreadyActive") {
            return { _tag: "AlreadyActive" as const };
          }
          if (addresses.length === 0) {
            return yield* Effect.fail<EnvironmentError>({
              _tag: "EnvironmentError",
              cause:
                "a Pending activation intent requires a non-empty boundary",
            });
          }

          // Resolve the exact persisted Workspace boundary before entering the
          // claim transaction. No Profile catalog or request path is read.
          const resolved = yield* Effect.gen(function* () {
            if (Option.isNone(environmentResolver)) {
              return yield* Effect.fail<EnvironmentError>({
                _tag: "EnvironmentError",
                cause: "the pinned resource boundary cannot be verified",
              });
            }
            // The legacy ProjectEnvironmentPort intentionally drops probe
            // facts such as exists:false. Activation is narrower: a pinned
            // host boundary may become Active only when the full P11
            // resolver can currently observe each FileTree/GitWorktree.
            const observation = yield* environmentResolver.value
              .observe(projectId, addresses)
              .pipe(
                Effect.mapError(
                  (error): EnvironmentError => ({
                    _tag: "EnvironmentError",
                    cause: { _tag: error._tag },
                  }),
                ),
              );
            if (
              observation.entries.some(
                (entry) =>
                  (entry.address._tag === "FileTree" ||
                    entry.address._tag === "GitWorktree") &&
                  !entry.probe.exists,
              )
            ) {
              return yield* Effect.fail<EnvironmentError>({
                _tag: "EnvironmentError",
                cause: "the pinned resource boundary is unavailable",
              });
            }
            return {
              regions: observation.changedRegions,
              observedEnvironmentRevision: observation.observedRevision,
            };
          });
          const claims = yield* Effect.forEach(resolved.regions, (region) =>
            Effect.gen(function* () {
              const sourceAddress = sourceAddressForRegion(region, addresses);
              if (sourceAddress === undefined) {
                return yield* Effect.fail<EnvironmentError>({
                  _tag: "EnvironmentError",
                  cause:
                    "resource resolver produced a region without a source address",
                });
              }
              const claimId = yield* ids.generate<string>(
                "ResourceOwnershipClaim",
              );
              const createdAt = yield* clock.now();
              return {
                claimId,
                workspaceId,
                region,
                sourceAddressSnapshot: sourceAddress,
                resourceBoundaryRevision,
                resolvedAtEnvironmentRevision:
                  resolved.observedEnvironmentRevision,
                createdAt,
                releasedAt: null,
              } satisfies ResourceOwnershipClaimRecord;
            }),
          );
          if (claims.length === 0) {
            return yield* Effect.fail<EnvironmentError>({
              _tag: "EnvironmentError",
              cause:
                "resource resolver returned no claims for a non-empty boundary",
            });
          }

          const activation = yield* tx.transact(
            Effect.gen(function* () {
              const currentIntent = yield* activationIntents.find(
                projectId,
                workspaceId,
                resourceBoundaryRevision,
              );
              if (Option.isNone(currentIntent)) {
                return yield* Effect.fail({
                  _tag: "PersistenceCorruption" as const,
                  repository: "WorkspaceResourceActivationStore" as const,
                  operation: "activate",
                  reason:
                    "the exact activation intent disappeared before commit",
                });
              }
              if (currentIntent.value.status === "Active") {
                return { _tag: "AlreadyActive" as const };
              }
              const currentWorkspace = yield* workspaces.findById(workspaceId);
              if (
                Option.isNone(currentWorkspace) ||
                currentWorkspace.value.projectId !== projectId ||
                currentWorkspace.value.resourceBoundaryRevision !==
                  resourceBoundaryRevision ||
                JSON.stringify(
                  currentWorkspace.value.resourceBoundary.addresses,
                ) !== JSON.stringify(addresses)
              ) {
                return yield* Effect.fail({
                  _tag: "PersistenceCorruption" as const,
                  repository: "WorkspaceResourceActivationStore" as const,
                  operation: "activate",
                  reason:
                    "the pinned Workspace boundary changed while activation was resolving",
                });
              }
              const currentEnvironment = yield* revisions.current(projectId);
              if (
                Option.isSome(currentEnvironment) &&
                currentEnvironment.value !==
                  resolved.observedEnvironmentRevision
              ) {
                return yield* Effect.fail<ResourceResolutionStale>({
                  _tag: "ResourceResolutionStale",
                  observed: resolved.observedEnvironmentRevision,
                  current: currentEnvironment.value,
                });
              }
              const conflicts = yield* Effect.forEach(
                resolved.regions,
                (region) =>
                  repository.loadActiveConflicts(region.resourceSpaceId),
              );
              const activeClaims = conflicts.flat();
              const overlap = claims.some((claim) =>
                activeClaims.some((existing) =>
                  regionsOverlap(
                    existing.region,
                    claim.region,
                    resourceRegionComparator,
                  ),
                ),
              );
              if (overlap) {
                return yield* Effect.fail<ResourceOwnershipRepositoryError>({
                  _tag: "PersistenceConstraintViolation",
                  repository: "ResourceOwnershipRepository",
                  operation: "insert-active-claim",
                  constraintKind: "Constraint",
                  constraint: "active-resource-overlap",
                });
              }
              yield* Effect.forEach(claims, (claim) =>
                repository.insertClaim(claim),
              );
              yield* revisions.record(
                projectId,
                resolved.observedEnvironmentRevision,
              );
              const activatedAt = yield* clock.now();
              const changed = yield* activationIntents.compareAndSetActive(
                projectId,
                workspaceId,
                resourceBoundaryRevision,
                activatedAt,
                activatedAt,
              );
              if (!changed) {
                return yield* Effect.fail({
                  _tag: "PersistenceCorruption" as const,
                  repository: "WorkspaceResourceActivationStore" as const,
                  operation: "activate",
                  reason:
                    "Pending intent CAS lost after the transaction-local state check",
                });
              }
              const event: PendingDomainEvent = {
                projectId,
                eventType: "WorkspaceResourceActivationChanged",
                eventVersion: 1,
                occurredAt: activatedAt,
                aggregateRef: workspaceId,
                actor: activationActor,
                payload: {
                  _tag: "WorkspaceResourceActivationChanged",
                  workspaceId,
                  resourceBoundaryRevision,
                  status: "Active",
                },
              };
              yield* journal
                .append([event])
                .pipe(Effect.provideService(IdGenerator, ids));
              if (qualificationProbe !== undefined) {
                yield* Effect.promise(() =>
                  qualificationProbe({
                    boundary: "P11BeforeActivationCommit",
                    projectId,
                    workspaceId,
                    resourceBoundaryRevision,
                  }),
                );
              }
              return { _tag: "Activated" as const };
            }),
          );
          if (
            activation._tag === "Activated" &&
            qualificationProbe !== undefined
          ) {
            yield* Effect.promise(() =>
              qualificationProbe({
                boundary: "P11AfterActivationCommit",
                projectId,
                workspaceId,
                resourceBoundaryRevision,
              }),
            );
          }
          return activation;
        });

    return OwnershipWriteService.of({
      resolveAndWrite,
      activatePendingWorkspaceResource,
    });
  });

export const OwnershipWriteServiceWithQualificationProbe = (
  qualificationProbe?: WorkspaceResourceActivationQualificationProbe,
): Layer.Layer<
  OwnershipWriteService,
  never,
  | ProjectEnvironmentPort
  | TransactionPort
  | ResourceOwnershipRepository
  | EnvironmentRevisionStore
  | WorkspaceRepository
  | WorkspaceResourceActivationStore
  | DomainEventJournal
  | IdGenerator
  | Clock
> =>
  Layer.effect(
    OwnershipWriteService,
    makeOwnershipWriteServiceEffect(qualificationProbe),
  );

export const OwnershipWriteServiceLive =
  OwnershipWriteServiceWithQualificationProbe();
