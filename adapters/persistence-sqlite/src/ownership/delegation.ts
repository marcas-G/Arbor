import {
  addOwnershipExclusion,
  canonicalRegionString,
  claimWithinBoundary,
  isEqualityOnlyCanonicalRegion,
  ownershipRegionRelation,
  ownershipRegionsOverlap,
  type ResourceAddress,
} from "@arbor/domain";
import {
  type EnvironmentError,
  IdGenerator,
  type OwnershipWriteServiceService,
  type PendingDomainEvent,
  type ResourceOwnershipClaimRecord,
  type ResourceOwnershipRepositoryError,
  type ResourceResolutionStale,
  resourceRegionComparator,
} from "@arbor/ports";
import {
  Effect,
  Option,
} from "effect";
import type { OwnershipContext } from "./context.js";

export const makeDelegationWrites = (context: OwnershipContext): Pick<OwnershipWriteServiceService, "activateDelegatedOwnership"> => {
  const { environmentResolver, tx, repository, revisions, clock, workspaces, activationIntents, journal, ids, activationActor } = context;
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

  return { activateDelegatedOwnership };
};
