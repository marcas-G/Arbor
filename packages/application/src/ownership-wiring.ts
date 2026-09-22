import type {
  CanonicalResourceRegion,
  ProjectId,
  ResourceAddress,
  ResourceBoundaryRevision,
  WorkspaceId,
} from "@arbor/domain";
import { regionsOverlap } from "@arbor/domain";
import type {
  ClockService,
  EnvironmentError,
  EnvironmentRevisionStoreError,
  IdGeneratorService,
  OwnershipWriteServiceService,
  ProjectEnvironmentPortService,
  ResourceOwnershipClaimRecord,
  ResourceOwnershipRepositoryError,
  ResourceOwnershipRepositoryService,
  TransactionOperationalFailure,
  TransactionPortService,
} from "@arbor/ports";
import { resourceRegionComparator } from "@arbor/ports";
import { Effect } from "effect";

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
  Effect.forEach(payload.addresses, (address, index) => {
    const region = regions[index];
    if (region === undefined) {
      return Effect.fail<EnvironmentError>({
        _tag: "EnvironmentError",
        cause: "resolver region/address arity mismatch",
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
