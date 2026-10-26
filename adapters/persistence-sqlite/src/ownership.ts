import {
  Actor,
  addOwnershipExclusion,
  type CanonicalResourceRegion,
  type CommandId,
  canonicalRegionString,
  claimWithinBoundary,
  incrementOrdinal,
  isEqualityOnlyCanonicalRegion,
  ownershipRegionRelation,
  ownershipRegionsOverlap,
  type ProjectId,
  parse,
  type ResourceAddress,
  type ResourceBoundaryRevision,
  Revision,
  regionsOverlap,
  removeOwnershipExclusion,
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
  readonly exclusions_json: string;
  readonly delegating_workspace_id: string | null;
  readonly delegation_source_id: string | null;
  readonly claim_revision: number;
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
  exclusions: JSON.parse(
    row.exclusions_json,
  ) as ReadonlyArray<CanonicalResourceRegion>,
  delegatingWorkspaceId: row.delegating_workspace_id as WorkspaceId | null,
  delegationSourceId: row.delegation_source_id,
  claimRevision: Number(row.claim_revision),
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
    const sql = yield* SqlClient;
    const runOwnershipQuery = <A extends object>(
      statement: string,
      parameters: ReadonlyArray<unknown> = [],
    ) =>
      Effect.mapError(sql.unsafe<A>(statement, parameters), (cause) => ({
        _tag: "TransactionOperationalFailure" as const,
        cause,
      }));
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

    const activateDelegatedOwnership: OwnershipWriteServiceService["activateDelegatedOwnership"] =
      ({
        projectId,
        childWorkspaceId,
        childResourceBoundaryRevision,
        delegationSourceId,
      }) =>
        Effect.gen(function* () {
          const initial = yield* tx.transact(
            Effect.gen(function* () {
              const intent = yield* activationIntents.find(
                projectId,
                childWorkspaceId,
                childResourceBoundaryRevision,
              );
              if (
                Option.isNone(intent) ||
                intent.value.delegation?.delegationSourceId !==
                  delegationSourceId
              ) {
                return yield* Effect.fail({
                  _tag: "PersistenceCorruption" as const,
                  repository: "WorkspaceResourceActivationStore" as const,
                  operation: "activate-delegated-ownership",
                  reason: "the exact durable delegation intent is missing",
                });
              }
              const delegation = intent.value.delegation;
              if (
                delegation.delegationSourceId !==
                  `formation:${delegation.formationProposalId}:${delegation.formationProposalRevision}` ||
                !Number.isSafeInteger(delegation.formationProposalRevision) ||
                delegation.formationProposalRevision < 0
              ) {
                return yield* Effect.fail({
                  _tag: "PersistenceCorruption" as const,
                  repository: "WorkspaceResourceActivationStore" as const,
                  operation: "activate-delegated-ownership",
                  reason: "the durable delegation source identity is malformed",
                });
              }
              const child = yield* workspaces.findById(childWorkspaceId);
              const parent = yield* workspaces.findById(
                delegation.parentWorkspaceId,
              );
              if (Option.isNone(child) || Option.isNone(parent)) {
                return yield* Effect.fail({
                  _tag: "PersistenceCorruption" as const,
                  repository: "WorkspaceRepository" as const,
                  operation: "activate-delegated-ownership",
                  reason: "the exact Parent or Child Workspace is missing",
                });
              }
              if (intent.value.status === "Active") {
                const childClaims =
                  yield* repository.listActiveByWorkspace(childWorkspaceId);
                const parentClaims = yield* repository.listActiveByWorkspace(
                  delegation.parentWorkspaceId,
                );
                const childMatches = childClaims.filter(
                  (claim) => claim.delegationSourceId === delegationSourceId,
                );
                if (childMatches.length !== 1) {
                  return yield* Effect.fail({
                    _tag: "PersistenceCorruption" as const,
                    repository: "ResourceOwnershipRepository" as const,
                    operation: "replay-delegated-ownership",
                    reason:
                      "active delegation intent does not have exactly one matching Child claim",
                  });
                }
                const childClaim = childMatches[0];
                if (
                  childClaim === undefined ||
                  childClaim.delegatingWorkspaceId !==
                    delegation.parentWorkspaceId ||
                  JSON.stringify(childClaim.sourceAddressSnapshot) !==
                    JSON.stringify(delegation.addresses[0])
                ) {
                  return yield* Effect.fail({
                    _tag: "PersistenceCorruption" as const,
                    repository: "ResourceOwnershipRepository" as const,
                    operation: "replay-delegated-ownership",
                    reason:
                      "the persisted Child claim does not match the exact delegation provenance",
                  });
                }
                const matchingParents = parentClaims.filter((claim) =>
                  (claim.exclusions ?? []).some(
                    (region) =>
                      canonicalRegionString(region) ===
                      canonicalRegionString(childClaim.region),
                  ),
                );
                const exactTransferred =
                  isEqualityOnlyCanonicalRegion(childClaim.region) &&
                  parentClaims.length === 0;
                const historicalParentClaims =
                  exactTransferred && repository.listByWorkspace !== undefined
                    ? yield* repository.listByWorkspace(
                        delegation.parentWorkspaceId,
                      )
                    : [];
                const matchingParent = exactTransferred
                  ? historicalParentClaims.find(
                      (claim) =>
                        claim.releasedAt !== null &&
                        canonicalRegionString(claim.region) ===
                          canonicalRegionString(childClaim.region),
                    )
                  : matchingParents[0];
                if (
                  matchingParent === undefined ||
                  (exactTransferred
                    ? historicalParentClaims.filter(
                        (claim) =>
                          claim.releasedAt !== null &&
                          canonicalRegionString(claim.region) ===
                            canonicalRegionString(childClaim.region),
                      ).length !== 1
                    : matchingParents.length !== 1)
                ) {
                  return yield* Effect.fail({
                    _tag: "PersistenceCorruption" as const,
                    repository: "ResourceOwnershipRepository" as const,
                    operation: "replay-delegated-ownership",
                    reason:
                      "the exact Parent exclusion for the committed Child claim is missing or ambiguous",
                  });
                }
                return {
                  _tag: "AlreadyActive" as const,
                  parentClaim: matchingParent,
                  childClaim,
                };
              }
              return {
                _tag: "Pending" as const,
                intent: intent.value,
                parent: parent.value,
                child: child.value,
              };
            }),
          );
          if (initial._tag === "AlreadyActive") return initial;

          const delegation = initial.intent.delegation;
          if (delegation === undefined || delegation === null) {
            return yield* Effect.fail({
              _tag: "PersistenceCorruption" as const,
              repository: "WorkspaceResourceActivationStore" as const,
              operation: "activate-delegated-ownership",
              reason: "delegation provenance is absent",
            });
          }
          if (
            delegation.addresses.length !== 1 ||
            initial.intent.projectId !== projectId ||
            initial.intent.workspaceId !== childWorkspaceId ||
            initial.intent.resourceBoundaryRevision !==
              childResourceBoundaryRevision ||
            initial.parent.projectId !== projectId ||
            initial.child.projectId !== projectId ||
            initial.child.parentWorkspaceId !== delegation.parentWorkspaceId ||
            initial.parent.lifecycle !== "Active" ||
            initial.child.lifecycle !== "Active" ||
            initial.parent.revision !==
              delegation.expectedParentWorkspaceRevision ||
            initial.child.revision !==
              delegation.expectedChildWorkspaceRevision ||
            initial.parent.resourceBoundaryRevision !==
              delegation.expectedParentBoundaryRevision ||
            initial.child.resourceBoundaryRevision !==
              childResourceBoundaryRevision ||
            delegation.expectedParentOwnershipRevision < 0 ||
            delegation.expectedChildOwnershipRevision !== 0
          ) {
            return yield* Effect.fail({
              _tag: "WorkspaceRepositoryRevisionConflict" as const,
            });
          }
          const addresses = delegation.addresses;
          const allAddresses = [
            ...new Map(
              [...addresses, ...initial.child.resourceBoundary.addresses].map(
                (candidate) => [JSON.stringify(candidate), candidate] as const,
              ),
            ).values(),
          ];
          if (initial.child.resourceBoundary.addresses.length === 0) {
            return yield* Effect.fail<EnvironmentError>({
              _tag: "EnvironmentError",
              cause: "the Child resource boundary is empty",
            });
          }
          if (Option.isNone(environmentResolver)) {
            return yield* Effect.fail<EnvironmentError>({
              _tag: "EnvironmentError",
              cause: "the delegated canonical scope cannot be resolved",
            });
          }
          const observation = yield* environmentResolver.value
            .observe(projectId, allAddresses)
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
              cause: "a delegated or Child-boundary resource is unavailable",
            });
          }
          const resolvedFor = (address: ResourceAddress) =>
            observation.entries.filter(
              (entry) =>
                JSON.stringify(entry.address) === JSON.stringify(address),
            );
          const delegatedEntries = addresses.flatMap(resolvedFor);
          const boundaryEntries =
            initial.child.resourceBoundary.addresses.flatMap(resolvedFor);
          if (
            delegatedEntries.length !== addresses.length ||
            boundaryEntries.length !==
              initial.child.resourceBoundary.addresses.length
          ) {
            return yield* Effect.fail<EnvironmentError>({
              _tag: "EnvironmentError",
              cause:
                "resolver mapping does not cover the exact approved addresses",
            });
          }
          const region = delegatedEntries[0]?.resolved;
          if (region === undefined) {
            return yield* Effect.fail<EnvironmentError>({
              _tag: "EnvironmentError",
              cause: "resolver returned no delegated canonical region",
            });
          }
          const boundaryRegions = boundaryEntries.map(
            (entry) => entry.resolved,
          );
          if (
            !claimWithinBoundary(
              region,
              boundaryRegions,
              resourceRegionComparator,
            )
          ) {
            return yield* Effect.fail<ResourceOwnershipRepositoryError>({
              _tag: "PersistenceConstraintViolation",
              repository: "ResourceOwnershipRepository",
              operation: "activate-delegated-ownership",
              constraintKind: "Constraint",
              constraint: "delegated-region-outside-child-boundary",
            });
          }
          const sourceAddress = addresses[0];
          if (sourceAddress === undefined) {
            return yield* Effect.fail<EnvironmentError>({
              _tag: "EnvironmentError",
              cause: "the exact delegated source address is missing",
            });
          }
          const childClaimId = yield* ids.generate<string>(
            "ResourceOwnershipClaim",
          );
          const activatedAt = yield* clock.now();
          const childClaim: ResourceOwnershipClaimRecord = {
            claimId: childClaimId,
            workspaceId: childWorkspaceId,
            region,
            sourceAddressSnapshot: sourceAddress,
            resourceBoundaryRevision: childResourceBoundaryRevision,
            resolvedAtEnvironmentRevision: observation.observedRevision,
            createdAt: activatedAt,
            releasedAt: null,
            exclusions: [],
            delegatingWorkspaceId: delegation.parentWorkspaceId,
            delegationSourceId,
            claimRevision: delegation.expectedChildOwnershipRevision + 1,
          };

          const result = yield* tx.transact(
            Effect.gen(function* () {
              const currentIntent = yield* activationIntents.find(
                projectId,
                childWorkspaceId,
                childResourceBoundaryRevision,
              );
              if (Option.isNone(currentIntent)) {
                return yield* Effect.fail({
                  _tag: "PersistenceCorruption" as const,
                  repository: "WorkspaceResourceActivationStore" as const,
                  operation: "activate-delegated-ownership",
                  reason: "the durable activation intent disappeared",
                });
              }
              const currentDelegation = currentIntent.value.delegation;
              if (
                currentDelegation === undefined ||
                currentDelegation === null ||
                JSON.stringify(currentDelegation) !== JSON.stringify(delegation)
              ) {
                return yield* Effect.fail({
                  _tag: "PersistenceCorruption" as const,
                  repository: "WorkspaceResourceActivationStore" as const,
                  operation: "activate-delegated-ownership",
                  reason:
                    "the durable delegation identity changed before commit",
                });
              }
              if (currentIntent.value.status === "Active") {
                const childClaims =
                  yield* repository.listActiveByWorkspace(childWorkspaceId);
                const parentClaims = yield* repository.listActiveByWorkspace(
                  delegation.parentWorkspaceId,
                );
                const childMatches = childClaims.filter(
                  (claim) => claim.delegationSourceId === delegationSourceId,
                );
                const matchingParents = parentClaims.filter((claim) =>
                  (claim.exclusions ?? []).some(
                    (exclusion) =>
                      canonicalRegionString(exclusion) ===
                      canonicalRegionString(region),
                  ),
                );
                const childMatch = childMatches[0];
                const exactTransferred =
                  isEqualityOnlyCanonicalRegion(childMatch?.region ?? region) &&
                  parentClaims.length === 0;
                const historicalParentClaims =
                  exactTransferred && repository.listByWorkspace !== undefined
                    ? yield* repository.listByWorkspace(
                        delegation.parentWorkspaceId,
                      )
                    : [];
                const matchingParent = exactTransferred
                  ? historicalParentClaims.find(
                      (claim) =>
                        claim.releasedAt !== null &&
                        canonicalRegionString(claim.region) ===
                          canonicalRegionString(region),
                    )
                  : matchingParents[0];
                if (
                  childMatch === undefined ||
                  matchingParent === undefined ||
                  childMatches.length !== 1 ||
                  (exactTransferred
                    ? historicalParentClaims.filter(
                        (claim) =>
                          claim.releasedAt !== null &&
                          canonicalRegionString(claim.region) ===
                            canonicalRegionString(region),
                      ).length !== 1
                    : matchingParents.length !== 1)
                ) {
                  return yield* Effect.fail({
                    _tag: "PersistenceCorruption" as const,
                    repository: "ResourceOwnershipRepository" as const,
                    operation: "replay-delegated-ownership",
                    reason: "committed delegation post-image is incomplete",
                  });
                }
                return {
                  _tag: "AlreadyActive" as const,
                  parentClaim: matchingParent,
                  childClaim: childMatch,
                };
              }
              const parentWorkspace = yield* workspaces.findById(
                delegation.parentWorkspaceId,
              );
              const childWorkspace =
                yield* workspaces.findById(childWorkspaceId);
              if (
                Option.isNone(parentWorkspace) ||
                Option.isNone(childWorkspace) ||
                parentWorkspace.value.projectId !== projectId ||
                childWorkspace.value.projectId !== projectId ||
                childWorkspace.value.parentWorkspaceId !==
                  delegation.parentWorkspaceId ||
                parentWorkspace.value.lifecycle !== "Active" ||
                childWorkspace.value.lifecycle !== "Active" ||
                parentWorkspace.value.revision !==
                  delegation.expectedParentWorkspaceRevision ||
                childWorkspace.value.revision !==
                  delegation.expectedChildWorkspaceRevision ||
                parentWorkspace.value.resourceBoundaryRevision !==
                  delegation.expectedParentBoundaryRevision ||
                childWorkspace.value.resourceBoundaryRevision !==
                  childResourceBoundaryRevision
              ) {
                return yield* Effect.fail({
                  _tag: "WorkspaceRepositoryRevisionConflict" as const,
                });
              }
              if (
                JSON.stringify(
                  childWorkspace.value.resourceBoundary.addresses,
                ) !== JSON.stringify(initial.child.resourceBoundary.addresses)
              ) {
                return yield* Effect.fail({
                  _tag: "WorkspaceRepositoryRevisionConflict" as const,
                });
              }
              const currentEnvironment = yield* revisions.current(projectId);
              if (
                Option.isSome(currentEnvironment) &&
                currentEnvironment.value !== observation.observedRevision
              ) {
                return yield* Effect.fail<ResourceResolutionStale>({
                  _tag: "ResourceResolutionStale",
                  observed: observation.observedRevision,
                  current: currentEnvironment.value,
                });
              }
              const parentClaims = yield* repository.listActiveByWorkspace(
                delegation.parentWorkspaceId,
              );
              const childClaims =
                yield* repository.listActiveByWorkspace(childWorkspaceId);
              if (parentClaims.length !== 1 || childClaims.length !== 0) {
                return yield* Effect.fail<ResourceOwnershipRepositoryError>({
                  _tag: "PersistenceConstraintViolation",
                  repository: "ResourceOwnershipRepository",
                  operation: "activate-delegated-ownership",
                  constraintKind: "Constraint",
                  constraint: "delegation-ownership-revision-shape",
                });
              }
              const parentClaim = parentClaims[0];
              if (
                parentClaim === undefined ||
                (parentClaim.claimRevision ?? 0) !==
                  delegation.expectedParentOwnershipRevision ||
                parentClaim.resourceBoundaryRevision !==
                  parentWorkspace.value.resourceBoundaryRevision ||
                ownershipRegionRelation(
                  {
                    allow: parentClaim.region,
                    exclusions: parentClaim.exclusions ?? [],
                  },
                  region,
                  resourceRegionComparator,
                ) !== "Contained"
              ) {
                return yield* Effect.fail<ResourceOwnershipRepositoryError>({
                  _tag: "PersistenceConstraintViolation",
                  repository: "ResourceOwnershipRepository",
                  operation: "activate-delegated-ownership",
                  constraintKind: "Constraint",
                  constraint: "delegated-region-not-in-parent-effective-claim",
                });
              }
              const exactTransfer =
                isEqualityOnlyCanonicalRegion(region) &&
                canonicalRegionString(parentClaim.region) ===
                  canonicalRegionString(region) &&
                (parentClaim.exclusions ?? []).length === 0;
              const parentMutation = exactTransfer
                ? {
                    _tag: "Contained" as const,
                    region: {
                      allow: parentClaim.region,
                      exclusions: parentClaim.exclusions ?? [],
                    },
                  }
                : addOwnershipExclusion(
                    {
                      allow: parentClaim.region,
                      exclusions: parentClaim.exclusions ?? [],
                    },
                    region,
                    resourceRegionComparator,
                  );
              if (parentMutation._tag !== "Contained") {
                return yield* Effect.fail<ResourceOwnershipRepositoryError>({
                  _tag: "PersistenceConstraintViolation",
                  repository: "ResourceOwnershipRepository",
                  operation: "activate-delegated-ownership",
                  constraintKind: "Constraint",
                  constraint: "delegated-region-carveout-invalid",
                });
              }
              const committedAt = yield* clock.now();
              const parentPostImage: ResourceOwnershipClaimRecord = {
                ...parentClaim,
                exclusions: parentMutation.region.exclusions,
                releasedAt: exactTransfer ? committedAt : null,
                claimRevision: (parentClaim.claimRevision ?? 0) + 1,
              };
              const allClaims = yield* repository.loadActiveConflicts(
                region.resourceSpaceId,
              );
              const postImage = allClaims
                .filter((claim) => claim.claimId !== parentClaim.claimId)
                .concat(
                  parentPostImage.releasedAt === null ? [parentPostImage] : [],
                  childClaim,
                );
              for (let left = 0; left < postImage.length; left += 1) {
                const leftClaim = postImage[left];
                if (leftClaim === undefined) continue;
                for (
                  let right = left + 1;
                  right < postImage.length;
                  right += 1
                ) {
                  const rightClaim = postImage[right];
                  if (
                    rightClaim !== undefined &&
                    ownershipRegionsOverlap(
                      {
                        allow: leftClaim.region,
                        exclusions: leftClaim.exclusions ?? [],
                      },
                      {
                        allow: rightClaim.region,
                        exclusions: rightClaim.exclusions ?? [],
                      },
                      resourceRegionComparator,
                    )
                  ) {
                    return yield* Effect.fail<ResourceOwnershipRepositoryError>(
                      {
                        _tag: "PersistenceConstraintViolation",
                        repository: "ResourceOwnershipRepository",
                        operation: "activate-delegated-ownership",
                        constraintKind: "Constraint",
                        constraint: "effective-resource-ownership-overlap",
                      },
                    );
                  }
                }
              }
              yield* repository.applyDelegation({
                parentClaimId: parentClaim.claimId,
                expectedParentClaimRevision:
                  delegation.expectedParentOwnershipRevision,
                parentPostImage,
                childClaim,
              });
              yield* revisions.record(projectId, observation.observedRevision);
              const activated = yield* activationIntents.compareAndSetActive(
                projectId,
                childWorkspaceId,
                childResourceBoundaryRevision,
                committedAt,
                committedAt,
                delegationSourceId,
              );
              if (!activated) {
                return yield* Effect.fail({
                  _tag: "PersistenceCorruption" as const,
                  repository: "WorkspaceResourceActivationStore" as const,
                  operation: "activate-delegated-ownership",
                  reason: "the exact Pending delegation intent CAS failed",
                });
              }
              const ownershipEvent: PendingDomainEvent = {
                projectId,
                eventType: "ResourceOwnershipChanged",
                eventVersion: 2,
                occurredAt: committedAt,
                aggregateRef: delegation.parentWorkspaceId,
                actor: delegation.approvedBy,
                causedByCommandId: delegation.causedByCommandId,
                payload: {
                  _tag: "ResourceOwnershipChanged",
                  operation: exactTransfer ? "Transferred" : "Delegated",
                  delegation: {
                    delegationSourceId,
                    formationProposalId: delegation.formationProposalId,
                    formationProposalRevision:
                      delegation.formationProposalRevision,
                    parentWorkspaceId: delegation.parentWorkspaceId,
                    childWorkspaceId,
                    approvedBy: delegation.approvedBy,
                    causedByCommandId: delegation.causedByCommandId,
                  },
                  parentClaim: parentPostImage,
                  childClaim,
                },
              };
              const activationEvent: PendingDomainEvent = {
                projectId,
                eventType: "WorkspaceResourceActivationChanged",
                eventVersion: 1,
                occurredAt: committedAt,
                aggregateRef: childWorkspaceId,
                actor: activationActor,
                payload: {
                  _tag: "WorkspaceResourceActivationChanged",
                  workspaceId: childWorkspaceId,
                  resourceBoundaryRevision: childResourceBoundaryRevision,
                  status: "Active",
                },
              };
              yield* journal
                .append([ownershipEvent, activationEvent])
                .pipe(Effect.provideService(IdGenerator, ids));
              return {
                _tag: "Activated" as const,
                parentClaim: parentPostImage,
                childClaim,
              };
            }),
          );
          return result;
        });

    const reclaimDelegatedOwnership: OwnershipWriteServiceService["reclaimDelegatedOwnership"] =
      (input) =>
        Effect.gen(function* () {
          const initial = yield* tx.transact(
            Effect.gen(function* () {
              const childWorkspace = yield* workspaces.findById(
                input.childWorkspaceId,
              );
              if (Option.isNone(childWorkspace)) {
                return yield* Effect.fail({
                  _tag: "WorkspaceRepositoryRevisionConflict" as const,
                });
              }
              const parentId = childWorkspace.value.parentWorkspaceId;
              if (parentId === null) {
                return yield* Effect.fail({
                  _tag: "WorkspaceRepositoryRevisionConflict" as const,
                });
              }
              const parentWorkspace = yield* workspaces.findById(parentId);
              const childClaims = yield* repository.listActiveByWorkspace(
                input.childWorkspaceId,
              );
              const parentClaims =
                yield* repository.listActiveByWorkspace(parentId);
              const parentHistory =
                repository.listByWorkspace === undefined
                  ? []
                  : yield* repository.listByWorkspace(parentId);
              const matchingChildren = childClaims.filter(
                (claim) =>
                  claim.delegationSourceId === input.delegationSourceId &&
                  claim.delegatingWorkspaceId === parentId,
              );
              const matchingChild = matchingChildren[0];
              if (
                Option.isNone(parentWorkspace) ||
                matchingChildren.length !== 1 ||
                matchingChild === undefined
              ) {
                return yield* Effect.fail({
                  _tag: "PersistenceConstraintViolation" as const,
                  repository: "ResourceOwnershipRepository" as const,
                  operation: "reclaim-delegated-ownership",
                  constraintKind: "Constraint" as const,
                  constraint: "exact-delegation-evidence-missing-or-ambiguous",
                });
              }
              return {
                parentId,
                parentWorkspace: parentWorkspace.value,
                childWorkspace: childWorkspace.value,
                childClaim: matchingChild,
                parentClaims,
                parentHistory,
              };
            }),
          );
          const resolved = yield* environment.resolve(input.projectId, [
            initial.childClaim.sourceAddressSnapshot,
          ]);
          const resolvedRegion = resolved.regions[0];
          if (
            resolved.regions.length !== 1 ||
            resolvedRegion === undefined ||
            canonicalRegionString(resolvedRegion) !==
              canonicalRegionString(initial.childClaim.region)
          ) {
            return yield* Effect.fail<ResourceResolutionStale>({
              _tag: "ResourceResolutionStale",
              observed: initial.childClaim.resolvedAtEnvironmentRevision,
              current: resolved.observedEnvironmentRevision,
            });
          }
          const releasedAt = yield* clock.now();
          return yield* tx.transact(
            Effect.gen(function* () {
              const anchoredEnvironmentRevision = yield* revisions.current(
                input.projectId,
              );
              if (
                Option.isNone(anchoredEnvironmentRevision) ||
                anchoredEnvironmentRevision.value !==
                  resolved.observedEnvironmentRevision
              ) {
                return yield* Effect.fail<ResourceResolutionStale>({
                  _tag: "ResourceResolutionStale",
                  observed: resolved.observedEnvironmentRevision,
                  current: Option.isSome(anchoredEnvironmentRevision)
                    ? anchoredEnvironmentRevision.value
                    : "<uninitialized>",
                });
              }
              if (
                input.quiescence.noUnresolvedEffects !== true ||
                input.quiescence.noActiveExecution !== true ||
                input.quiescence.noOpenWork !== true ||
                input.quiescence.noActiveChildren !== true ||
                input.quiescence.noUnresolvedIncomingDependencies !== true
              ) {
                return yield* Effect.fail({
                  _tag: "PersistenceConstraintViolation" as const,
                  repository: "ResourceOwnershipRepository" as const,
                  operation: "reclaim-delegated-ownership",
                  constraintKind: "Constraint" as const,
                  constraint: "delegated-region-not-quiescent",
                });
              }
              // Reclaim authority is derived from canonical rows in this same
              // BEGIN IMMEDIATE transaction. Caller flags are an early hint
              // only; they cannot authorize transfer over a concurrent row.
              const activeExecutions = yield* runOwnershipQuery<{
                count: number;
              }>(
                "SELECT COUNT(*) AS count FROM executions WHERE workspace_id = ? AND settled_at IS NULL",
                [input.childWorkspaceId],
              );
              const openWorks = yield* runOwnershipQuery<{ count: number }>(
                "SELECT COUNT(*) AS count FROM works WHERE workspace_id = ? AND lifecycle = 'Open'",
                [input.childWorkspaceId],
              );
              const activeChildren = yield* runOwnershipQuery<{
                count: number;
              }>(
                "SELECT COUNT(*) AS count FROM workspaces WHERE parent_workspace_id = ? AND lifecycle = 'Active'",
                [input.childWorkspaceId],
              );
              const currentChild = yield* runOwnershipQuery<{
                current_work_id: string | null;
              }>(
                "SELECT current_work_id FROM workspaces WHERE workspace_id = ? AND lifecycle = 'Active'",
                [input.childWorkspaceId],
              );
              const invocationColumns = yield* runOwnershipQuery<{
                name: string;
              }>("PRAGMA table_info(tool_invocations)");
              const hasAdmissionState = invocationColumns.some(
                (column) => column.name === "effect_admission_state",
              );
              const unresolvedEffects = hasAdmissionState
                ? yield* runOwnershipQuery<{ resolved_regions_json: string }>(
                    "SELECT resolved_regions_json FROM tool_invocations WHERE workspace_id = ? AND effect_admission_state <> 'NotAdmitted' AND (settled_at IS NULL OR settlement_kind IN ('Interrupted','OutcomeUnknown','RuntimeFailure'))",
                    [input.childWorkspaceId],
                  )
                : yield* runOwnershipQuery<{ resolved_regions_json: string }>(
                    "SELECT resolved_regions_json FROM tool_invocations WHERE workspace_id = ? AND side_effect_semantics <> 'ReadOnly' AND settled_at IS NULL",
                    [input.childWorkspaceId],
                  );
              const incomingDependencies = yield* runOwnershipQuery<{
                producer_binding: string;
                consumer_workspace_id: string;
              }>(
                "SELECT d.producer_binding, consumer.workspace_id AS consumer_workspace_id FROM dependencies d JOIN works consumer ON consumer.work_id = d.consumer_work_id LEFT JOIN works producer ON producer.work_id = json_extract(d.producer_binding, '$.workId') WHERE d.project_id = ? AND d.state = 'Unsatisfied' AND consumer.workspace_id <> ? AND (json_extract(d.producer_binding, '$._tag') = 'WorkspaceBound' AND json_extract(d.producer_binding, '$.workspaceId') = ? OR json_extract(d.producer_binding, '$._tag') = 'WorkBound' AND producer.workspace_id = ?)",
                [
                  input.projectId,
                  input.childWorkspaceId,
                  input.childWorkspaceId,
                  input.childWorkspaceId,
                ],
              );
              let effectRegionUnproven = false;
              for (const invocation of unresolvedEffects) {
                try {
                  const regions: unknown = JSON.parse(
                    invocation.resolved_regions_json,
                  );
                  if (!Array.isArray(regions) || regions.length === 0) {
                    effectRegionUnproven = true;
                    break;
                  }
                  for (const region of regions) {
                    if (
                      typeof region !== "object" ||
                      region === null ||
                      !("resourceSpaceId" in region) ||
                      !("normalizedRegion" in region)
                    ) {
                      effectRegionUnproven = true;
                      break;
                    }
                    if (
                      ownershipRegionsOverlap(
                        {
                          allow: region as CanonicalResourceRegion,
                          exclusions: [],
                        },
                        {
                          allow: initial.childClaim.region,
                          exclusions: [],
                        },
                        resourceRegionComparator,
                      )
                    ) {
                      effectRegionUnproven = true;
                      break;
                    }
                  }
                } catch {
                  effectRegionUnproven = true;
                }
                if (effectRegionUnproven) break;
              }
              if (
                (activeExecutions[0]?.count ?? 0) > 0 ||
                (openWorks[0]?.count ?? 0) > 0 ||
                (activeChildren[0]?.count ?? 0) > 0 ||
                currentChild[0]?.current_work_id != null ||
                incomingDependencies.length > 0 ||
                effectRegionUnproven
              ) {
                return yield* Effect.fail({
                  _tag: "PersistenceConstraintViolation" as const,
                  repository: "ResourceOwnershipRepository" as const,
                  operation: "reclaim-delegated-ownership",
                  constraintKind: "Constraint" as const,
                  constraint: "canonical-delegated-region-not-quiescent",
                });
              }
              const parent = yield* workspaces.findById(initial.parentId);
              const child = yield* workspaces.findById(input.childWorkspaceId);
              if (
                Option.isNone(parent) ||
                Option.isNone(child) ||
                parent.value.projectId !== input.projectId ||
                child.value.projectId !== input.projectId ||
                parent.value.lifecycle !== "Active" ||
                child.value.lifecycle !== "Active" ||
                parent.value.revision !==
                  input.expectedParentWorkspaceRevision ||
                child.value.revision !== input.expectedChildWorkspaceRevision ||
                parent.value.resourceBoundaryRevision !==
                  input.expectedParentBoundaryRevision ||
                child.value.resourceBoundaryRevision !==
                  input.expectedChildBoundaryRevision
              ) {
                return yield* Effect.fail({
                  _tag: "WorkspaceRepositoryRevisionConflict" as const,
                });
              }
              const childClaims = yield* repository.listActiveByWorkspace(
                input.childWorkspaceId,
              );
              if (
                childClaims.length !== 1 ||
                childClaims[0]?.claimId !== initial.childClaim.claimId ||
                childClaims[0]?.claimRevision !==
                  input.expectedChildClaimRevision
              ) {
                return yield* Effect.fail<ResourceOwnershipRepositoryError>({
                  _tag: "PersistenceConstraintViolation",
                  repository: "ResourceOwnershipRepository",
                  operation: "reclaim-delegated-ownership",
                  constraintKind: "Constraint",
                  constraint: "stale-child-claim-revision",
                });
              }
              const parentClaims = yield* repository.listActiveByWorkspace(
                initial.parentId,
              );
              const exactTransfer = isEqualityOnlyCanonicalRegion(
                initial.childClaim.region,
              );
              const matchingParents = parentClaims.filter((claim) =>
                (claim.exclusions ?? []).some(
                  (region) =>
                    canonicalRegionString(region) ===
                    canonicalRegionString(initial.childClaim.region),
                ),
              );
              let parentClaim: ResourceOwnershipClaimRecord;
              let parentClaimId: string | null = null;
              let expectedParentClaimRevision: number | null = null;
              let parentPostImage: ResourceOwnershipClaimRecord | null = null;
              let restoredParentClaim: ResourceOwnershipClaimRecord | null =
                null;
              if (exactTransfer) {
                const exactReleasedParents = initial.parentHistory.filter(
                  (claim) =>
                    claim.releasedAt !== null &&
                    claim.claimRevision === input.expectedParentClaimRevision &&
                    canonicalRegionString(claim.region) ===
                      canonicalRegionString(initial.childClaim.region),
                );
                if (
                  parentClaims.length !== 0 ||
                  exactReleasedParents.length !== 1
                ) {
                  return yield* Effect.fail<ResourceOwnershipRepositoryError>({
                    _tag: "PersistenceConstraintViolation",
                    repository: "ResourceOwnershipRepository",
                    operation: "reclaim-delegated-ownership",
                    constraintKind: "Constraint",
                    constraint: "equality-transfer-parent-not-released",
                  });
                }
                const parentClaimIdNew = yield* ids.generate<string>(
                  "ResourceOwnershipClaim",
                );
                parentClaim = {
                  claimId: parentClaimIdNew,
                  workspaceId: initial.parentId,
                  region: initial.childClaim.region,
                  sourceAddressSnapshot:
                    initial.childClaim.sourceAddressSnapshot,
                  resourceBoundaryRevision:
                    input.expectedParentBoundaryRevision,
                  resolvedAtEnvironmentRevision:
                    resolved.observedEnvironmentRevision,
                  createdAt: releasedAt,
                  releasedAt: null,
                  exclusions: [],
                  delegatingWorkspaceId: null,
                  delegationSourceId: null,
                  claimRevision: input.expectedParentClaimRevision + 1,
                };
                restoredParentClaim = parentClaim;
              } else {
                if (
                  matchingParents.length !== 1 ||
                  matchingParents[0]?.claimRevision !==
                    input.expectedParentClaimRevision
                ) {
                  return yield* Effect.fail<ResourceOwnershipRepositoryError>({
                    _tag: "PersistenceConstraintViolation",
                    repository: "ResourceOwnershipRepository",
                    operation: "reclaim-delegated-ownership",
                    constraintKind: "Constraint",
                    constraint: "exact-parent-exclusion-missing-or-stale",
                  });
                }
                const matchedParent = matchingParents[0];
                if (matchedParent === undefined) {
                  return yield* Effect.fail<ResourceOwnershipRepositoryError>({
                    _tag: "PersistenceConstraintViolation",
                    repository: "ResourceOwnershipRepository",
                    operation: "reclaim-delegated-ownership",
                    constraintKind: "Constraint",
                    constraint: "exact-parent-exclusion-missing",
                  });
                }
                const mutation = removeOwnershipExclusion(
                  {
                    allow: matchedParent.region,
                    exclusions: matchedParent.exclusions ?? [],
                  },
                  initial.childClaim.region,
                  resourceRegionComparator,
                );
                if (mutation._tag !== "Contained") {
                  return yield* Effect.fail<ResourceOwnershipRepositoryError>({
                    _tag: "PersistenceConstraintViolation",
                    repository: "ResourceOwnershipRepository",
                    operation: "reclaim-delegated-ownership",
                    constraintKind: "Constraint",
                    constraint: "exact-parent-exclusion-missing-or-invalid",
                  });
                }
                parentClaimId = matchedParent.claimId;
                expectedParentClaimRevision = input.expectedParentClaimRevision;
                parentClaim = {
                  ...matchedParent,
                  exclusions: mutation.region.exclusions,
                  claimRevision: input.expectedParentClaimRevision + 1,
                };
                parentPostImage = parentClaim;
              }
              if (input.retireChild) {
                const hasOpenWork = yield* workspaces.hasOpenWork(
                  input.childWorkspaceId,
                );
                const activeChildren = yield* workspaces.countActiveChildren(
                  input.childWorkspaceId,
                );
                if (
                  child.value.currentWorkId !== null ||
                  hasOpenWork ||
                  activeChildren > 0
                ) {
                  return yield* Effect.fail({
                    _tag: "WorkspaceRepositoryRevisionConflict" as const,
                  });
                }
              }
              const others = yield* repository.loadActiveConflicts(
                initial.childClaim.region.resourceSpaceId,
              );
              const postImage = others
                .filter(
                  (claim) =>
                    claim.claimId !== initial.childClaim.claimId &&
                    claim.claimId !== parentClaimId,
                )
                .concat(parentClaim);
              for (let i = 0; i < postImage.length; i += 1) {
                const left = postImage[i];
                if (left === undefined) continue;
                for (let j = i + 1; j < postImage.length; j += 1) {
                  const right = postImage[j];
                  if (
                    right !== undefined &&
                    ownershipRegionsOverlap(
                      { allow: left.region, exclusions: left.exclusions ?? [] },
                      {
                        allow: right.region,
                        exclusions: right.exclusions ?? [],
                      },
                      resourceRegionComparator,
                    )
                  ) {
                    return yield* Effect.fail<ResourceOwnershipRepositoryError>(
                      {
                        _tag: "PersistenceConstraintViolation",
                        repository: "ResourceOwnershipRepository",
                        operation: "reclaim-delegated-ownership",
                        constraintKind: "Constraint",
                        constraint: "effective-resource-ownership-overlap",
                      },
                    );
                  }
                }
              }
              yield* repository.applyReclaim({
                childClaimId: initial.childClaim.claimId,
                expectedChildClaimRevision: input.expectedChildClaimRevision,
                childReleasedAt: releasedAt,
                childNextClaimRevision: input.expectedChildClaimRevision + 1,
                parentClaimId,
                expectedParentClaimRevision,
                parentPostImage,
                restoredParentClaim,
              });
              const parentRevision = incrementOrdinal(Revision)(
                parent.value.revision,
              );
              yield* workspaces.bumpRevisionIfRevision(
                initial.parentId,
                parent.value.revision,
                parentRevision,
              );
              if (input.retireChild) {
                yield* workspaces.retireIfRevision(
                  input.childWorkspaceId,
                  child.value.revision,
                  incrementOrdinal(Revision)(child.value.revision),
                );
              } else {
                yield* workspaces.bumpRevisionIfRevision(
                  input.childWorkspaceId,
                  child.value.revision,
                  incrementOrdinal(Revision)(child.value.revision),
                );
              }
              yield* revisions.record(
                input.projectId,
                resolved.observedEnvironmentRevision,
              );
              const [proposalId, proposalRevisionText] =
                input.delegationSourceId.slice("formation:".length).split(":");
              const proposalRevision = Number(proposalRevisionText);
              const ownershipEvent: PendingDomainEvent = {
                projectId: input.projectId,
                eventType: "ResourceOwnershipChanged",
                eventVersion: 2,
                occurredAt: releasedAt,
                aggregateRef: initial.parentId,
                actor: input.actor,
                causedByCommandId: input.causedByCommandId as CommandId,
                payload: {
                  _tag: "ResourceOwnershipChanged",
                  operation: "Reclaimed",
                  delegation: {
                    delegationSourceId: input.delegationSourceId,
                    formationProposalId: proposalId,
                    formationProposalRevision: proposalRevision,
                    parentWorkspaceId: initial.parentId,
                    childWorkspaceId: input.childWorkspaceId,
                    approvedBy: input.actor,
                    causedByCommandId: input.causedByCommandId as CommandId,
                  },
                  parentClaim,
                  childClaim: {
                    ...initial.childClaim,
                    releasedAt,
                    claimRevision: input.expectedChildClaimRevision + 1,
                  },
                },
              };
              const events: PendingDomainEvent[] = [ownershipEvent];
              if (input.retireChild) {
                events.push({
                  projectId: input.projectId,
                  eventType: "WorkspaceRetired",
                  eventVersion: 1,
                  occurredAt: releasedAt,
                  aggregateRef: input.childWorkspaceId,
                  actor: input.actor,
                  causedByCommandId: input.causedByCommandId as CommandId,
                  payload: { _tag: "WorkspaceRetired" },
                });
              }
              yield* journal
                .append(events)
                .pipe(Effect.provideService(IdGenerator, ids));
              return {
                _tag: "Reclaimed" as const,
                parentClaim,
                childClaim: {
                  ...initial.childClaim,
                  releasedAt,
                  claimRevision: input.expectedChildClaimRevision + 1,
                },
                childRetired: input.retireChild,
              };
            }),
          );
        });

    return OwnershipWriteService.of({
      resolveAndWrite,
      activatePendingWorkspaceResource,
      activateDelegatedOwnership,
      reclaimDelegatedOwnership,
    });
  });

export const OwnershipWriteServiceWithQualificationProbe = (
  qualificationProbe?: WorkspaceResourceActivationQualificationProbe,
): Layer.Layer<
  OwnershipWriteService,
  never,
  | ProjectEnvironmentPort
  | SqlClient
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
