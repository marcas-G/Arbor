import {
  type CanonicalResourceRegion,
  type CommandId,
  canonicalRegionString,
  incrementOrdinal,
  isEqualityOnlyCanonicalRegion,
  ownershipRegionsOverlap,
  parse,
  Revision,
  removeOwnershipExclusion,
} from "@arbor/domain";
import {
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

export const makeReclamationWrites = (context: OwnershipContext): Pick<OwnershipWriteServiceService, "reclaimDelegatedOwnership"> => {
  const { environment, tx, runOwnershipQuery, repository, revisions, clock, workspaces, journal, ids } = context;
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

  return { reclaimDelegatedOwnership };
};
