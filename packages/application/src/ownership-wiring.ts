import type {
  Actor,
  CanonicalResourceRegion,
  CommandId,
  Principal,
  ProjectId,
  ResourceAddress,
  ResourceBoundaryRevision,
  Revision,
  WorkspaceId,
} from "@arbor/domain";
import {
  canonicalRegionString,
  regionsOverlap,
  retireWorkspace,
} from "@arbor/domain";
import type {
  ClockService,
  DependencyRepositoryError,
  DependencyRepositoryService,
  DomainEventJournalError,
  EnvironmentError,
  EnvironmentRevisionStoreError,
  ExecutionRepositoryError,
  ExecutionRepositoryService,
  IdGeneratorService,
  OwnershipWriteServiceService,
  ProjectEnvironmentPortService,
  ResourceOwnershipClaimRecord,
  ResourceOwnershipRepositoryError,
  ResourceOwnershipRepositoryService,
  ResourceResolutionStale,
  ToolInvocationStoreError,
  ToolInvocationStoreService,
  TransactionOperationalFailure,
  TransactionPortService,
  WorkRepositoryError,
  WorkRepositoryService,
  WorkspaceRepositoryError,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { resourceRegionComparator } from "@arbor/ports";
import { Context, Effect, Option } from "effect";

/** P11 `10` §1 — ownership claim/release wiring (scope-fenced).
 *
 * Minimal call sites only; the frozen P1 contracts stay untouched:
 * `CreateChildWorkspace` (payload/result/events) is NOT modified, the
 * `OwnershipWriteService` CAS sequence is consumed as published, and P4
 * admission remains validate-only (ownership changes are governance
 * commands, v1.8 G4). The scope fence (`10` §2 verbatim OUT list) is
 * mechanically asserted by tests/p11-ownership-wiring.test.ts. */

export type OwnershipWiringOperationalError =
  | EnvironmentError
  | ResourceOwnershipRepositoryError
  | TransactionOperationalFailure
  | EnvironmentRevisionStoreError;

// --- A. claim call site: workspace boundary activation ----------------------

export interface ActivateWorkspaceBoundaryPayload {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly resourceBoundaryRevision: ResourceBoundaryRevision;
  readonly addresses: ReadonlyArray<ResourceAddress>;
}

export interface ActivateWorkspaceBoundaryDependencies {
  readonly environment: Pick<ProjectEnvironmentPortService, "resolve">;
  readonly ownershipWrite: Pick<
    OwnershipWriteServiceService,
    "resolveAndWrite"
  >;
  readonly clock: Pick<ClockService, "now">;
  readonly ids: Pick<IdGeneratorService, "generate">;
}

export type BoundaryClaimOutcome =
  | {
      readonly _tag: "ClaimsWritten";
      readonly claims: ReadonlyArray<ResourceOwnershipClaimRecord>;
      readonly reResolved: boolean;
    }
  | {
      /** Bounded give-up after exactly one re-resolve (P11 `04` §2: stale
       * is a retryable operational failure, never an authoritative
       * rejection). Claims are governance objects: the workspace creation
       * that preceded this call is neither blocked nor rolled back —
       * re-running the activation is a governance retry. */
      readonly _tag: "ClaimsAbandonedStale";
      readonly attempts: 2;
      readonly lastObserved: string;
      readonly lastCurrent: string;
    };

const buildClaims = (
  payload: ActivateWorkspaceBoundaryPayload,
  observedRevision: string,
  regions: ReadonlyArray<CanonicalResourceRegion>,
  deps: ActivateWorkspaceBoundaryDependencies,
): Effect.Effect<
  ReadonlyArray<ResourceOwnershipClaimRecord>,
  EnvironmentError
> =>
  Effect.forEach(regions, (region) => {
    const normalized = region.normalizedRegion as {
      readonly kind?: unknown;
      readonly path?: unknown;
      readonly namespace?: unknown;
      readonly address?: unknown;
    };
    const address = payload.addresses.find((candidate) => {
      if (
        (normalized.kind === "FileTree" || normalized.kind === "GitWorktree") &&
        (candidate._tag === "FileTree" || candidate._tag === "GitWorktree")
      ) {
        return (
          candidate.path.replaceAll("\\", "/").toLowerCase() ===
          String(normalized.path).replaceAll("\\", "/").toLowerCase()
        );
      }
      if (
        normalized.kind === "DatabaseNamespace" &&
        candidate._tag === "DatabaseNamespace"
      ) {
        return candidate.namespace === normalized.namespace;
      }
      return (
        normalized.kind === "ExternalResource" &&
        candidate._tag === "ExternalResource" &&
        candidate.address === normalized.address
      );
    });
    if (address === undefined) {
      return Effect.fail<EnvironmentError>({
        _tag: "EnvironmentError",
        cause: "resolver produced a canonical region without a source address",
      });
    }
    return Effect.gen(function* () {
      const claimId = yield* deps.ids.generate<string>(
        "ResourceOwnershipClaim",
      );
      const createdAt = yield* deps.clock.now();
      return {
        claimId,
        workspaceId: payload.workspaceId,
        region,
        sourceAddressSnapshot: address,
        resourceBoundaryRevision: payload.resourceBoundaryRevision,
        resolvedAtEnvironmentRevision: observedRevision,
        createdAt,
        releasedAt: null,
      } satisfies ResourceOwnershipClaimRecord;
    });
  });

/** One activation attempt: pre-resolve (to build the claims anchored at
 * the observed revision), then the frozen CAS write, which re-resolves
 * internally and refuses on counter drift. Anchoring note: the claim
 * anchor is the revision observed by the pre-resolve, which by
 * construction precedes (or equals) the CAS re-resolve inside the write —
 * the anchor is therefore never fresher than what was actually observed. */
const attemptActivation = (
  payload: ActivateWorkspaceBoundaryPayload,
  deps: ActivateWorkspaceBoundaryDependencies,
) => {
  const resolveAndWrite = deps.ownershipWrite.resolveAndWrite;
  return Effect.gen(function* () {
    const resolved = yield* deps.environment.resolve(
      payload.projectId,
      payload.addresses,
    );
    const claims = yield* buildClaims(
      payload,
      resolved.observedEnvironmentRevision,
      resolved.regions,
      deps,
    );
    return yield* resolveAndWrite(payload.projectId, payload.addresses, claims);
  });
};

/** Boundary activation runs AFTER the CreateChildWorkspace command
 * transaction commits (the composition-root call site): the frozen
 * OwnershipWriteService opens its own transaction, so joining the command
 * transaction is structurally impossible (nested transactions are
 * rejected). A typed stale abandonment never blocks the creation. */
export const activateWorkspaceBoundary = (
  payload: ActivateWorkspaceBoundaryPayload,
  deps: ActivateWorkspaceBoundaryDependencies,
): Effect.Effect<BoundaryClaimOutcome, OwnershipWiringOperationalError> => {
  if (payload.addresses.length === 0) {
    return Effect.succeed({
      _tag: "ClaimsWritten",
      claims: [],
      reResolved: false,
    });
  }
  return attemptActivation(payload, deps).pipe(
    Effect.map(
      (written): BoundaryClaimOutcome => ({
        _tag: "ClaimsWritten",
        claims: written.claims,
        reResolved: false,
      }),
    ),
    Effect.catchTag("ResourceResolutionStale", () =>
      attemptActivation(payload, deps).pipe(
        Effect.map(
          (written): BoundaryClaimOutcome => ({
            _tag: "ClaimsWritten",
            claims: written.claims,
            reResolved: true,
          }),
        ),
        Effect.catchTag("ResourceResolutionStale", (second) =>
          Effect.succeed<BoundaryClaimOutcome>({
            _tag: "ClaimsAbandonedStale",
            attempts: 2,
            lastObserved: second.observed,
            lastCurrent: second.current,
          }),
        ),
      ),
    ),
  );
};

// --- B. release call sites ---------------------------------------------------

export interface ReleasedClaimsResult {
  readonly releasedClaimIds: ReadonlyArray<string>;
}

/** Boundary shrink: resolve the removed addresses, then release (soft —
 * rows are retained, never hard-deleted) the workspace's ACTIVE claims
 * overlapping the removed regions. Resolve happens outside the write
 * transaction (DID §1.5); the release itself is one transaction. */
export interface ReleaseShrunkRegionsPayload {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly removedAddresses: ReadonlyArray<ResourceAddress>;
}

export interface ReleaseShrunkRegionsDependencies {
  readonly environment: Pick<ProjectEnvironmentPortService, "resolve">;
  readonly ownership: Pick<
    ResourceOwnershipRepositoryService,
    "listActiveByWorkspace" | "releaseClaim"
  >;
  readonly tx: Pick<TransactionPortService, "transact">;
  readonly clock: Pick<ClockService, "now">;
}

export const releaseShrunkRegions = (
  payload: ReleaseShrunkRegionsPayload,
  deps: ReleaseShrunkRegionsDependencies,
): Effect.Effect<ReleasedClaimsResult, OwnershipWiringOperationalError> =>
  Effect.gen(function* () {
    const resolved = yield* deps.environment.resolve(
      payload.projectId,
      payload.removedAddresses,
    );
    const releasedAt = yield* deps.clock.now();
    return yield* deps.tx.transact(
      Effect.gen(function* () {
        const active = yield* deps.ownership.listActiveByWorkspace(
          payload.workspaceId,
        );
        const overlapping = active.filter((claim) =>
          resolved.regions.some((region) =>
            regionsOverlap(claim.region, region, resourceRegionComparator),
          ),
        );
        yield* Effect.forEach(overlapping, (claim) =>
          deps.ownership.releaseClaim(claim.claimId, releasedAt),
        );
        return {
          releasedClaimIds: overlapping.map((claim) => claim.claimId),
        };
      }),
    );
  });

/** §1.4A (DID:653/:4217) — enforce, not bypass. Application-layer retire
 * precondition check for the wiring ahead of the frozen P1/P6 domain
 * transition `retireWorkspace` (which already carries
 * `hasActiveResourceOwnershipClaim`); no RetireWorkspace command is
 * created here. The typed refusal points the operator at the `10`
 * release paths FIRST — boundary shrink or worktree retirement.
 * Retirement itself never auto-releases claims. */
export type RetirePreconditionOutcome =
  | { readonly _tag: "RetirePreconditionsSatisfied" }
  | {
      readonly _tag: "ActiveOwnershipClaimsExist";
      readonly workspaceId: WorkspaceId;
      readonly claimIds: ReadonlyArray<string>;
      readonly releasePaths: ReadonlyArray<
        "boundary-shrink" | "worktree-retirement"
      >;
    };

export interface RetirePreconditionDependencies {
  readonly ownership: Pick<
    ResourceOwnershipRepositoryService,
    "listActiveByWorkspace"
  >;
  readonly tx: Pick<TransactionPortService, "transact">;
}

export const enforceRetirePreconditions = (
  workspaceId: WorkspaceId,
  deps: RetirePreconditionDependencies,
): Effect.Effect<
  RetirePreconditionOutcome,
  ResourceOwnershipRepositoryError | TransactionOperationalFailure
> =>
  deps.tx.transact(
    Effect.gen(function* () {
      const active = yield* deps.ownership.listActiveByWorkspace(workspaceId);
      if (active.length === 0) {
        return { _tag: "RetirePreconditionsSatisfied" } as const;
      }
      return {
        _tag: "ActiveOwnershipClaimsExist",
        workspaceId,
        claimIds: active.map((claim) => claim.claimId),
        releasePaths: ["boundary-shrink", "worktree-retirement"],
      } as const;
    }),
  );

// --- C. exact-provenance Child retirement -----------------------------------

export interface RetireWorkspaceRequest {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly expectedRevision: Revision;
  readonly principal: Principal;
  readonly commandId: CommandId;
}

export type RetireWorkspaceOutcome =
  | {
      readonly _tag: "Retired";
      readonly childWorkspaceId: WorkspaceId;
      readonly parentWorkspaceId: WorkspaceId;
      readonly delegationSourceId: string;
      readonly ownership: {
        readonly _tag: "Reclaimed" | "AlreadyReclaimed";
        readonly parentClaim: ResourceOwnershipClaimRecord;
        readonly childClaim: ResourceOwnershipClaimRecord;
        readonly childRetired: boolean;
      };
    }
  | {
      readonly _tag: "Refused";
      readonly reason:
        | "NotAuthorized"
        | "WorkspaceNotFound"
        | "WorkspaceRevisionConflict"
        | "WorkspaceNotActive"
        | "RootWorkspace"
        | "NoExactDelegatedClaim"
        | "RetirePreconditionFailed";
      readonly detail?: string;
    };

export type RetireWorkspaceApplicationError =
  | DependencyRepositoryError
  | DomainEventJournalError
  | EnvironmentError
  | EnvironmentRevisionStoreError
  | ExecutionRepositoryError
  | ResourceOwnershipRepositoryError
  | ResourceResolutionStale
  | ToolInvocationStoreError
  | TransactionOperationalFailure
  | WorkRepositoryError
  | WorkspaceRepositoryError;

export interface RetireWorkspaceApplicationDependencies {
  readonly workspaces: Pick<
    WorkspaceRepositoryService,
    "findById" | "hasOpenWork" | "countActiveChildren"
  >;
  readonly works: Pick<WorkRepositoryService, "findById">;
  readonly executions: Pick<
    ExecutionRepositoryService,
    "findActiveMainByWorkspace" | "findUnsettledExecutions"
  >;
  readonly dependencies: Pick<
    DependencyRepositoryService,
    "listUnsatisfiedByProject"
  >;
  readonly invocations: Pick<ToolInvocationStoreService, "findUnsettled">;
  readonly ownership: Pick<
    ResourceOwnershipRepositoryService,
    "listActiveByWorkspace" | "listByWorkspace"
  >;
  readonly ownershipWrite: Pick<
    OwnershipWriteServiceService,
    "reclaimDelegatedOwnership"
  >;
  readonly tx: Pick<TransactionPortService, "transact">;
  readonly isAuthorizedHuman: (principal: Principal) => boolean;
}

export interface RetireWorkspaceApplicationService {
  readonly retire: (
    request: RetireWorkspaceRequest,
  ) => Effect.Effect<RetireWorkspaceOutcome, RetireWorkspaceApplicationError>;
}

export class RetireWorkspaceService extends Context.Service<
  RetireWorkspaceService,
  RetireWorkspaceApplicationService
>()("arbor/RetireWorkspaceService") {}

/** The application caller supplies authenticated identity, target, expected
 * Child revision, and command identity. Provenance, all CAS anchors, and
 * quiescence facts are read from canonical stores here; callers cannot assert
 * the negative quiescence facts themselves. The persistence operation then
 * rechecks the exact provenance/revisions and atomically reclaims ownership
 * with lifecycle retirement. */
export const makeRetireWorkspaceApplicationService = (
  deps: RetireWorkspaceApplicationDependencies,
): RetireWorkspaceApplicationService => ({
  retire: (request) => {
    if (!deps.isAuthorizedHuman(request.principal)) {
      return Effect.succeed({ _tag: "Refused", reason: "NotAuthorized" });
    }

    return Effect.gen(function* () {
      const snapshot = yield* deps.tx.transact(
        Effect.gen(function* () {
          const childOption = yield* deps.workspaces.findById(
            request.workspaceId,
          );
          if (Option.isNone(childOption)) return { _tag: "NotFound" } as const;
          const child = childOption.value;
          if (child.projectId !== request.projectId) {
            return { _tag: "NotFound" } as const;
          }
          if (child.revision !== request.expectedRevision) {
            return { _tag: "RevisionConflict" } as const;
          }
          if (child.lifecycle !== "Active") {
            return { _tag: "NotActive" } as const;
          }
          if (child.parentWorkspaceId === null) {
            return { _tag: "Root" } as const;
          }

          const parentOption = yield* deps.workspaces.findById(
            child.parentWorkspaceId,
          );
          if (
            Option.isNone(parentOption) ||
            parentOption.value.projectId !== request.projectId ||
            parentOption.value.lifecycle !== "Active"
          ) {
            return { _tag: "NoExactDelegation" } as const;
          }
          const parent = parentOption.value;
          const childClaims = yield* deps.ownership.listActiveByWorkspace(
            child.workspaceId,
          );
          if (childClaims.length !== 1) {
            return { _tag: "NoExactDelegation" } as const;
          }
          const childClaim = childClaims[0];
          if (
            childClaim === undefined ||
            childClaim.delegatingWorkspaceId !== parent.workspaceId ||
            typeof childClaim.delegationSourceId !== "string" ||
            childClaim.delegationSourceId.length === 0 ||
            !Number.isSafeInteger(childClaim.claimRevision)
          ) {
            return { _tag: "NoExactDelegation" } as const;
          }

          const parentClaims = yield* deps.ownership.listActiveByWorkspace(
            parent.workspaceId,
          );
          const matchingParentClaims = parentClaims.filter((claim) =>
            (claim.exclusions ?? []).some(
              (region) =>
                canonicalRegionString(region) ===
                canonicalRegionString(childClaim.region),
            ),
          );
          let parentClaimRevision: number | undefined;
          if (matchingParentClaims.length === 1) {
            parentClaimRevision = matchingParentClaims[0]?.claimRevision;
          } else if (matchingParentClaims.length === 0) {
            // Equality-only regions transfer the complete claim to the Child;
            // their exact Parent revision is retained as released history.
            const parentHistory =
              deps.ownership.listByWorkspace === undefined
                ? []
                : yield* deps.ownership.listByWorkspace(parent.workspaceId);
            const exactReleasedHistory = parentHistory.filter(
              (claim) =>
                claim.releasedAt !== null &&
                canonicalRegionString(claim.region) ===
                  canonicalRegionString(childClaim.region) &&
                Number.isSafeInteger(claim.claimRevision),
            );
            if (
              parentClaims.length === 0 &&
              exactReleasedHistory.length === 1
            ) {
              parentClaimRevision = exactReleasedHistory[0]?.claimRevision;
            }
          }
          if (!Number.isSafeInteger(parentClaimRevision)) {
            return { _tag: "NoExactDelegation" } as const;
          }

          const activeMain = yield* deps.executions.findActiveMainByWorkspace(
            child.workspaceId,
          );
          const openWork = yield* deps.workspaces.hasOpenWork(
            child.workspaceId,
          );
          const activeChildren = yield* deps.workspaces.countActiveChildren(
            child.workspaceId,
          );
          const unsettledExecutions =
            (yield* deps.executions.findUnsettledExecutions()).filter(
              (execution) => execution.workspaceId === child.workspaceId,
            );
          const unsettledInvocations = yield* Effect.forEach(
            unsettledExecutions,
            (execution) =>
              deps.invocations.findUnsettled(execution.executionId),
          );
          const incomingDependencies =
            yield* deps.dependencies.listUnsatisfiedByProject(
              request.projectId,
            );
          const incoming = yield* Effect.forEach(
            incomingDependencies,
            (dependency) =>
              Effect.gen(function* () {
                let producerWorkWorkspaceId: WorkspaceId | null = null;
                if (dependency.producerBinding._tag === "WorkBound") {
                  const producer = yield* deps.works.findById(
                    dependency.producerBinding.workId,
                  );
                  if (Option.isSome(producer)) {
                    producerWorkWorkspaceId = producer.value.workspaceId;
                  }
                }
                return {
                  dependency,
                  producerWorkWorkspaceId,
                  blocks:
                    dependency.producerBinding._tag === "WorkspaceBound"
                      ? dependency.producerBinding.workspaceId ===
                        child.workspaceId
                      : dependency.producerBinding._tag === "WorkBound" &&
                        producerWorkWorkspaceId === child.workspaceId,
                };
              }),
          );

          return {
            _tag: "Ready" as const,
            child,
            parent,
            childClaim,
            parentClaimRevision: parentClaimRevision as number,
            activeMain: Option.isSome(activeMain),
            hasUnsettledExecution: unsettledExecutions.length > 0,
            openWork: openWork || child.currentWorkId !== null,
            activeChildren: activeChildren > 0,
            noUnresolvedEffects: unsettledInvocations.every(
              (invocations) => invocations.length === 0,
            ),
            incoming,
          };
        }),
      );

      if (snapshot._tag === "NotFound") {
        return { _tag: "Refused", reason: "WorkspaceNotFound" } as const;
      }
      if (snapshot._tag === "RevisionConflict") {
        return {
          _tag: "Refused",
          reason: "WorkspaceRevisionConflict",
        } as const;
      }
      if (snapshot._tag === "NotActive") {
        return { _tag: "Refused", reason: "WorkspaceNotActive" } as const;
      }
      if (snapshot._tag === "Root") {
        return { _tag: "Refused", reason: "RootWorkspace" } as const;
      }
      if (snapshot._tag === "NoExactDelegation") {
        return { _tag: "Refused", reason: "NoExactDelegatedClaim" } as const;
      }

      const domainCheck = retireWorkspace(snapshot.child, {
        authorized: true,
        expectedRevision: request.expectedRevision,
        isRoot: false,
        hasActiveMainExecution: snapshot.activeMain,
        hasOpenWork: snapshot.openWork,
        hasActiveChildWorkspace: snapshot.activeChildren,
        // This exact claim is consumed by the atomic ownership operation.
        hasActiveResourceOwnershipClaim: false,
        incomingDependencies: snapshot.incoming.map(
          ({ dependency, producerWorkWorkspaceId }) => ({
            producerBinding: dependency.producerBinding,
            producerWorkWorkspaceId,
            unresolved: true,
            resolvedOrReplacedInSameGovernanceChange: false,
          }),
        ),
      });
      if (
        !domainCheck.ok ||
        snapshot.hasUnsettledExecution ||
        !snapshot.noUnresolvedEffects ||
        snapshot.incoming.some((entry) => entry.blocks)
      ) {
        return {
          _tag: "Refused",
          reason: "RetirePreconditionFailed",
          detail: !domainCheck.ok
            ? domainCheck.error._tag
            : snapshot.hasUnsettledExecution
              ? "active execution remains bound to the Child"
              : !snapshot.noUnresolvedEffects
                ? "unresolved effect remains bound to the Child region"
                : "unresolved incoming Dependency is bound to the Child",
        } as const;
      }

      const reclaimed = yield* deps.ownershipWrite.reclaimDelegatedOwnership({
        projectId: request.projectId,
        childWorkspaceId: snapshot.child.workspaceId,
        delegationSourceId: snapshot.childClaim.delegationSourceId as string,
        expectedParentWorkspaceRevision: snapshot.parent.revision,
        expectedChildWorkspaceRevision: snapshot.child.revision,
        expectedParentBoundaryRevision:
          snapshot.parent.resourceBoundaryRevision,
        expectedChildBoundaryRevision: snapshot.child.resourceBoundaryRevision,
        expectedParentClaimRevision: snapshot.parentClaimRevision,
        expectedChildClaimRevision: snapshot.childClaim.claimRevision as number,
        actor: request.principal as unknown as Actor,
        causedByCommandId: request.commandId,
        retireChild: true,
        quiescence: {
          noUnresolvedEffects: snapshot.noUnresolvedEffects,
          noActiveExecution:
            !snapshot.activeMain && !snapshot.hasUnsettledExecution,
          noOpenWork: !snapshot.openWork,
          noActiveChildren: !snapshot.activeChildren,
          noUnresolvedIncomingDependencies: !snapshot.incoming.some(
            (entry) => entry.blocks,
          ),
        },
      });
      return {
        _tag: "Retired",
        childWorkspaceId: snapshot.child.workspaceId,
        parentWorkspaceId: snapshot.parent.workspaceId,
        delegationSourceId: snapshot.childClaim.delegationSourceId as string,
        ownership: reclaimed,
      } as const;
    });
  },
});

/** Operator release face for the worktree-retirement flow (P11 `09` §3,
 * CI-3): given resolved canonical regions, release every ACTIVE claim
 * overlapping them in one transaction. Non-overlapping claims are
 * untouched. */
export interface ReleaseClaimsInRegionsDependencies {
  readonly ownership: Pick<
    ResourceOwnershipRepositoryService,
    "loadActiveConflicts" | "releaseClaim"
  >;
  readonly tx: Pick<TransactionPortService, "transact">;
  readonly clock: Pick<ClockService, "now">;
}

export const releaseClaimsInRegions = (
  regions: ReadonlyArray<CanonicalResourceRegion>,
  deps: ReleaseClaimsInRegionsDependencies,
): Effect.Effect<
  ReleasedClaimsResult,
  ResourceOwnershipRepositoryError | TransactionOperationalFailure
> => {
  const spaceIds: ReadonlyArray<string> = [
    ...new Set(regions.map((region) => region.resourceSpaceId)),
  ];
  return Effect.gen(function* () {
    const releasedAt = yield* deps.clock.now();
    return yield* deps.tx.transact(
      Effect.gen(function* () {
        const loaded = yield* Effect.forEach(spaceIds, (spaceId) =>
          deps.ownership.loadActiveConflicts(spaceId),
        );
        const overlapping = loaded
          .flat()
          .filter((claim) =>
            regions.some((region) =>
              regionsOverlap(claim.region, region, resourceRegionComparator),
            ),
          );
        yield* Effect.forEach(overlapping, (claim) =>
          deps.ownership.releaseClaim(claim.claimId, releasedAt),
        );
        return {
          releasedClaimIds: overlapping.map((claim) => claim.claimId),
        };
      }),
    );
  });
};
