import type { CanonicalResourceRegion } from "@arbor/domain";
import { canonicalRegionString, compareUtf8BytesV1 } from "@arbor/domain";
import type { WorktreeRecord } from "@arbor/ports";
import {
  EnvironmentResolverPort,
  ResourceOwnershipRepository,
  type SandboxPolicyCandidateBoundaryReadFailureReasonV1,
  SandboxPolicyCandidateBoundaryReadPort,
  type SandboxPolicyCandidateBoundaryReadPortService,
  TransactionScope,
  WorkspaceRepository,
  WorktreeStore,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";

const failure = (reason: SandboxPolicyCandidateBoundaryReadFailureReasonV1) =>
  ({ _tag: "SandboxPolicyCandidateBoundaryReadFailure", reason }) as const;

const sameGitWorktreeAddress = (
  left: import("@arbor/ports").GitWorktreeAddress,
  right: import("@arbor/ports").GitWorktreeAddress,
): boolean =>
  left._tag === right._tag &&
  left.path === right.path &&
  (left.repositoryRef ?? undefined) === (right.repositoryRef ?? undefined) &&
  (left.branch ?? undefined) === (right.branch ?? undefined);

const resolvedObservationIsConsistent = (observation: {
  readonly entries: ReadonlyArray<{
    readonly resolved: CanonicalResourceRegion;
  }>;
  readonly changedRegions: ReadonlyArray<CanonicalResourceRegion>;
}): boolean => {
  try {
    const fromEntries = observation.entries.map((entry) =>
      canonicalRegionString(entry.resolved),
    );
    const fromRegions = observation.changedRegions.map(canonicalRegionString);
    const sortedUnique = (values: ReadonlyArray<string>) =>
      [...new Set(values)].sort(compareUtf8BytesV1);
    const entriesSet = sortedUnique(fromEntries);
    const regionsSet = sortedUnique(fromRegions);
    return (
      fromEntries.length === entriesSet.length &&
      fromRegions.length === regionsSet.length &&
      entriesSet.length === regionsSet.length &&
      entriesSet.every((value, index) => value === regionsSet[index])
    );
  } catch {
    return false;
  }
};

export const SandboxPolicyCandidateBoundaryReadPortLive = Layer.effect(
  SandboxPolicyCandidateBoundaryReadPort,
  Effect.gen(function* () {
    const workspaces = yield* WorkspaceRepository;
    const ownership = yield* ResourceOwnershipRepository;
    const worktrees = yield* WorktreeStore;
    const resolver = yield* EnvironmentResolverPort;

    const service: SandboxPolicyCandidateBoundaryReadPortService = {
      readCurrentForWorkspace: ({ projectId, workspaceId }) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const workspaceOption = yield* workspaces
            .findById(workspaceId)
            .pipe(Effect.mapError(() => failure("WorkspaceMissing")));
          if (Option.isNone(workspaceOption))
            return yield* Effect.fail(failure("WorkspaceMissing"));
          const workspace = workspaceOption.value;
          if (workspace.projectId !== projectId)
            return yield* Effect.fail(failure("WorkspaceProjectMismatch"));
          if (workspace.lifecycle !== "Active")
            return yield* Effect.fail(failure("WorkspaceInactive"));
          if (
            !Number.isSafeInteger(workspace.responsibilityRevision) ||
            workspace.responsibilityRevision < 0 ||
            !Number.isSafeInteger(workspace.resourceBoundaryRevision) ||
            workspace.resourceBoundaryRevision < 0 ||
            !Array.isArray(workspace.resourceBoundary?.addresses)
          )
            return yield* Effect.fail(failure("ResourceBoundaryInvalid"));
          if (
            workspace.resourceBoundary.basisResponsibilityRevision !==
            workspace.responsibilityRevision
          )
            return yield* Effect.fail(
              failure("ResponsibilityRevisionMismatch"),
            );

          if (ownership.listByWorkspace === undefined)
            return yield* Effect.fail(failure("OwnershipSourceUnavailable"));
          const ownershipClaims = yield* ownership
            .listByWorkspace(workspaceId)
            .pipe(Effect.mapError(() => failure("OwnershipSourceUnavailable")));
          const workspaceWorktrees = yield* worktrees
            .findByWorkspace(workspaceId)
            .pipe(Effect.mapError(() => failure("WorktreeSourceUnavailable")));
          if (
            workspaceWorktrees.some(
              (record) =>
                record.projectId !== projectId ||
                record.workspaceId !== workspaceId,
            )
          )
            return yield* Effect.fail(failure("PrimaryWorktreeForeignOrStale"));
          const activeWorktrees = workspaceWorktrees.filter(
            (record) => record.state === "Active",
          );
          if (activeWorktrees.length !== 1)
            return yield* Effect.fail(
              failure("PrimaryWorktreeMissingOrAmbiguous"),
            );
          const primaryWorktree = activeWorktrees[0] as WorktreeRecord;
          if (
            primaryWorktree.address?._tag !== "GitWorktree" ||
            typeof primaryWorktree.address.path !== "string" ||
            primaryWorktree.address.path.length === 0
          )
            return yield* Effect.fail(failure("PrimaryWorktreeForeignOrStale"));

          const observation = yield* resolver
            .observe(workspace.projectId, workspace.resourceBoundary.addresses)
            .pipe(
              Effect.mapError(() =>
                failure("EnvironmentObservationUnavailable"),
              ),
            );
          if (
            observation.projectId !== projectId ||
            !resolvedObservationIsConsistent(observation)
          )
            return yield* Effect.fail(
              failure("EnvironmentObservationInconsistent"),
            );

          const primaryBoundaryAddresses =
            workspace.resourceBoundary.addresses.filter(
              (address) =>
                address._tag === "GitWorktree" &&
                sameGitWorktreeAddress(address, primaryWorktree.address),
            );
          if (primaryBoundaryAddresses.length !== 1)
            return yield* Effect.fail(failure("PrimaryWorktreeNotInBoundary"));
          // The exact active GitWorktree type comes only from P11's durable
          // WorktreeStore binding. A full-boundary observation may collapse a
          // same-path FileTree alias as its representative, so do not infer
          // the primary binding's type from that representative.
          const primaryManagedGitWorktreeRegion: CanonicalResourceRegion = {
            resourceSpaceId: "filesystem",
            normalizedRegion: {
              kind: "GitWorktree",
              path: primaryWorktree.address.path,
            },
          };
          if (
            !observation.entries.some(
              (entry) =>
                canonicalRegionString(entry.resolved) ===
                canonicalRegionString(primaryManagedGitWorktreeRegion),
            )
          )
            return yield* Effect.fail(
              failure("PrimaryWorktreeNotResolvedAsGitWorktree"),
            );

          return {
            workspace,
            ownershipClaims,
            worktrees: workspaceWorktrees,
            resolvedRegions: observation.entries.map((entry) => entry.resolved),
            primaryManagedGitWorktreeRegion,
          };
        }),
    };
    return SandboxPolicyCandidateBoundaryReadPort.of(service);
  }),
);
