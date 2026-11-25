import {
  type ProjectId,
  type ResourceAddress,
  regionsOverlap,
} from "@arbor/domain";
import {
  type EnvironmentError,
  type EnvironmentRevisionStoreError,
  IdGenerator,
  type OwnershipWriteResult,
  type OwnershipWriteServiceService,
  type PendingDomainEvent,
  type ResourceOwnershipClaimRecord,
  type ResourceOwnershipRepositoryError,
  type ResourceResolutionStale,
  resourceRegionComparator,
  type TransactionOperationalFailure,
} from "@arbor/ports";
import {
  Effect,
  Option,
} from "effect";
import {
  sourceAddressForRegion,
} from "./claim-codec.js";
import type { OwnershipContext } from "./context.js";

export const makeActivationWrites = (context: OwnershipContext): Pick<OwnershipWriteServiceService, "resolveAndWrite" | "activatePendingWorkspaceResource"> => {
  const { environment, environmentResolver, tx, repository, revisions, clock, workspaces, activationIntents, journal, ids, activationActor, qualificationProbe } = context;
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

  return { resolveAndWrite, activatePendingWorkspaceResource };
};
