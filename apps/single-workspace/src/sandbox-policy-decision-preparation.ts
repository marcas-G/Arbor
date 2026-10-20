import type {
  CommandAuthorityFact,
  DecideSandboxPolicyPayload,
  DecideSandboxPolicyPreparation,
} from "@arbor/application";
import {
  canonicalRegionString,
  compareUtf8BytesV1,
  decodeSandboxNetworkPolicySelectionV1,
  type EffectivePolicySummaryV1,
  type Execution,
  encodeExecutionEpisodeBinding,
  executionEpisode,
  produceSandboxBoundaryV1,
  type SandboxAuthorityBundleSnapshotV2,
  type SandboxPolicyPreconditionsV1,
  type SandboxProfile,
  sandboxEnvironmentBasisDigestOfV1,
  type Workspace,
} from "@arbor/domain";
import {
  type EnvironmentResolverService,
  type ExecutionRepositoryError,
  type ExecutionRepositoryService,
  type ResourceOwnershipRepositoryError,
  type ResourceOwnershipRepositoryService,
  type SandboxPolicyDecisionStoreError,
  type SandboxPolicyDecisionStoreService,
  sha256Hex,
  type TransactionOperationalFailure,
  type TransactionPortService,
  type TransactionScope,
  type WorkspaceRepositoryError,
  type WorkspaceRepositoryService,
  type WorktreeRecord,
  type WorktreeStoreError,
  type WorktreeStoreService,
} from "@arbor/ports";
import { Effect, Option } from "effect";

type DecisionAuthority = Extract<
  CommandAuthorityFact,
  { readonly _tag: "SandboxPolicyDecisionAuthority" }
>;

export type SandboxPolicyPreparationReasonCode =
  | "AuthoritySnapshotUnavailable"
  | "WorkspaceProjectMismatch"
  | "WorkspaceInactive"
  | "ExecutionProjectMismatch"
  | "ExecutionWorkspaceMismatch"
  | "ExecutionInactive"
  | "EpisodeMissingOrMismatch"
  | "AuthorityBundleRevisionMismatch"
  | "AuthorityBundleDigestMismatch"
  | "AuthorityOperatorRevisionMismatch"
  | "AuthorityOperatorDigestMismatch";

export type SandboxPolicyDecisionPreparationQualificationProbe = (event: {
  readonly stage:
    | "Capture"
    | "Authority"
    | "Selection"
    | "PrimaryWorktree"
    | "CompleteBoundary"
    | "PrimaryWorktreeObservation"
    | "BoundaryMaterialization"
    | "Limits"
    | "CurrentPreconditions";
  readonly result: "Pass" | "Failure";
  readonly errorTag?: string;
  readonly repository?: string;
  readonly operation?: string;
  readonly reasonCode?: SandboxPolicyPreparationReasonCode;
}) => Promise<void>;

export interface SandboxPolicyDecisionPreparationDependencies {
  readonly transaction: TransactionPortService;
  readonly workspaces: Pick<WorkspaceRepositoryService, "findById">;
  readonly executions: Pick<
    ExecutionRepositoryService,
    "findById" | "findEpisodeRevision"
  >;
  readonly decisions: Pick<
    SandboxPolicyDecisionStoreService,
    "findCurrentForExecution"
  >;
  readonly ownership: Pick<
    ResourceOwnershipRepositoryService,
    "listActiveByWorkspace"
  >;
  readonly worktrees: Pick<WorktreeStoreService, "findByWorkspace">;
  readonly environmentResolver: Pick<EnvironmentResolverService, "observe">;
  readonly authoritySnapshot: SandboxAuthorityBundleSnapshotV2 | undefined;
  /** Process-local qualification observer. It is absent in production and
   * never participates in a decision, persistence, or wire contract. */
  readonly qualificationProbe?: SandboxPolicyDecisionPreparationQualificationProbe;
}

interface CapturedInputs {
  readonly workspace: Workspace;
  readonly execution: Execution;
  readonly episodeRevision: number;
  readonly latestPolicyRevision: number;
  readonly ownershipClaims: ReadonlyArray<
    import("@arbor/ports").ResourceOwnershipClaimRecord
  >;
  readonly worktrees: ReadonlyArray<WorktreeRecord>;
}

interface CurrentSourceRows {
  readonly workspace: Option.Option<Workspace>;
  readonly execution: Option.Option<Execution>;
  readonly episodeRevision: Option.Option<number>;
  readonly latestPolicyRevision: number;
  readonly ownershipClaims: ReadonlyArray<
    import("@arbor/ports").ResourceOwnershipClaimRecord
  >;
  readonly worktrees: ReadonlyArray<WorktreeRecord>;
}

type CurrentSourceReadError =
  | WorkspaceRepositoryError
  | ExecutionRepositoryError
  | SandboxPolicyDecisionStoreError
  | ResourceOwnershipRepositoryError
  | WorktreeStoreError;

interface PreparedInputs {
  readonly captured: CapturedInputs;
  readonly boundary: Workspace["resourceBoundary"];
  readonly resolvedRegions: ReadonlyArray<
    import("@arbor/domain").CanonicalResourceRegion
  >;
  readonly primaryWorktree: WorktreeRecord;
  readonly primaryRegion: import("@arbor/domain").CanonicalResourceRegion;
  readonly summary: EffectivePolicySummaryV1;
  readonly kind: SandboxPolicyPreconditionsV1["kind"];
}

const operationalFailure = (cause: string): TransactionOperationalFailure => ({
  _tag: "TransactionOperationalFailure",
  cause,
});

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "sandbox policy preparation failed";

const isTransactionOperationalFailure = (
  cause: unknown,
): cause is TransactionOperationalFailure =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  cause._tag === "TransactionOperationalFailure";

const readCurrentSourceRows = (
  dependencies: SandboxPolicyDecisionPreparationDependencies,
  payload: DecideSandboxPolicyPayload,
): Effect.Effect<CurrentSourceRows, CurrentSourceReadError, TransactionScope> =>
  Effect.gen(function* () {
    const workspace = yield* dependencies.workspaces.findById(
      payload.workspaceId,
    );
    const execution = yield* dependencies.executions.findById(
      payload.executionId,
    );
    const episodeRevision = yield* dependencies.executions.findEpisodeRevision(
      payload.executionId,
    );
    const currentDecision =
      yield* dependencies.decisions.findCurrentForExecution(
        payload.projectId,
        payload.workspaceId,
        payload.executionId,
      );
    const ownershipClaims = yield* dependencies.ownership.listActiveByWorkspace(
      payload.workspaceId,
    );
    const worktrees = yield* dependencies.worktrees.findByWorkspace(
      payload.workspaceId,
    );
    return {
      workspace,
      execution,
      episodeRevision,
      latestPolicyRevision: Option.isSome(currentDecision)
        ? currentDecision.value.decision.policyRevision
        : 0,
      ownershipClaims,
      worktrees,
    } satisfies CurrentSourceRows;
  });

const capturedFromRows = (
  rows: CurrentSourceRows,
): CapturedInputs | undefined =>
  Option.isSome(rows.workspace) &&
  Option.isSome(rows.execution) &&
  Option.isSome(rows.episodeRevision)
    ? {
        workspace: rows.workspace.value,
        execution: rows.execution.value,
        episodeRevision: rows.episodeRevision.value,
        latestPolicyRevision: rows.latestPolicyRevision,
        ownershipClaims: rows.ownershipClaims,
        worktrees: rows.worktrees,
      }
    : undefined;

const capture = (
  dependencies: SandboxPolicyDecisionPreparationDependencies,
  payload: DecideSandboxPolicyPayload,
): Effect.Effect<CapturedInputs, TransactionOperationalFailure> =>
  dependencies.transaction
    .transact(
      readCurrentSourceRows(dependencies, payload).pipe(
        Effect.flatMap((rows) => {
          const captured = capturedFromRows(rows);
          return captured === undefined
            ? Effect.fail(
                operationalFailure(
                  "required Workspace or Execution source row is missing",
                ),
              )
            : Effect.succeed(captured);
        }),
      ),
    )
    .pipe(
      Effect.mapError((cause) =>
        isTransactionOperationalFailure(cause)
          ? cause
          : operationalFailure(errorMessage(cause)),
      ),
    );

const exactActiveWorktree = (
  worktrees: ReadonlyArray<WorktreeRecord>,
): WorktreeRecord | undefined => {
  const active = worktrees.filter((record) => record.state === "Active");
  return active.length === 1 ? active[0] : undefined;
};

const sameWorktree = (left: WorktreeRecord, right: WorktreeRecord): boolean =>
  left.worktreeId === right.worktreeId &&
  left.projectId === right.projectId &&
  left.workspaceId === right.workspaceId &&
  left.state === right.state &&
  left.address.path === right.address.path &&
  left.address.repositoryRef === right.address.repositoryRef &&
  left.address.branch === right.address.branch;

const resolvedObservationIsConsistent = (observation: {
  readonly entries: ReadonlyArray<{
    readonly resolved: import("@arbor/domain").CanonicalResourceRegion;
  }>;
  readonly changedRegions: ReadonlyArray<
    import("@arbor/domain").CanonicalResourceRegion
  >;
}): boolean => {
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
};

const limitsForProfile = (
  snapshot: SandboxAuthorityBundleSnapshotV2,
  profile: SandboxProfile,
) =>
  snapshot.bundle.operatorConfig.limitsByProfile.find(
    (entry) => entry.profile === profile,
  )?.limits;

const makeCurrentPreconditions = (
  payload: DecideSandboxPolicyPayload,
  captured: CapturedInputs | undefined,
  prepared: PreparedInputs | undefined,
  authoritySnapshot: SandboxAuthorityBundleSnapshotV2 | undefined,
): SandboxPolicyPreconditionsV1 => {
  const bundle = authoritySnapshot?.bundle;
  const forceMismatch = prepared === undefined || captured === undefined;
  const differentRevision = (expected: number): number =>
    expected === Number.MAX_SAFE_INTEGER ? expected - 1 : expected + 1;
  const common = {
    expectedEpisodeRevision: forceMismatch
      ? differentRevision(payload.expectedEpisodeRevision)
      : captured.episodeRevision,
    latestCommittedPolicyRevision: captured?.latestPolicyRevision ?? 0,
    episodeBinding:
      (captured === undefined
        ? undefined
        : executionEpisode(captured.execution)) ?? payload.episodeBinding,
    workspaceRevision: forceMismatch
      ? differentRevision(payload.expectedWorkspaceRevision)
      : (captured?.workspace.revision ?? 0),
    resourceBoundaryRevision: forceMismatch
      ? differentRevision(payload.expectedResourceBoundaryRevision)
      : (captured?.workspace.resourceBoundaryRevision ?? 0),
    sandboxHandleBindingDigest:
      prepared?.summary.sandboxHandleBindingDigest ?? "0".repeat(64),
    authorityBundleRevision:
      bundle?.bundleRevision ??
      differentRevision(payload.expectedAuthorityBundleRevision),
    authorityBundleDigest: authoritySnapshot?.bundleDigest ?? "0".repeat(64),
    operatorConfigRevision:
      bundle?.operatorConfigRevision ??
      differentRevision(payload.expectedOperatorConfigRevision),
    operatorConfigDigest: bundle?.operatorConfigDigest ?? "0".repeat(64),
  };
  if (payload.networkPolicy.kind === "OsEnforced")
    return {
      ...common,
      kind: "OsEnforced",
      providerRegistryRevision:
        bundle?.providerRegistryRevision ??
        differentRevision(payload.expectedProviderRegistryRevision ?? 1),
      providerRegistryDigest: bundle?.providerRegistryDigest ?? "0".repeat(64),
    };
  return { ...common, kind: "TrustedLocalUnconfinedV1" };
};

/** Production P5/P11 materializer. It captures repositories in short read
 * transactions, resolves the complete P11 boundary outside SQLite, then
 * computes only provider-neutral/path-free P4 decision material. The only
 * Supported-provider branch is gated by a future exact producer; v1 currently
 * fails closed for OS decisions and never substitutes TrustedLocal. */
export const makeSandboxPolicyDecisionPreparation = (
  dependencies: SandboxPolicyDecisionPreparationDependencies,
): DecideSandboxPolicyPreparation => {
  const preparedByPayload = new WeakMap<object, PreparedInputs>();
  const probe = (
    stage: Parameters<SandboxPolicyDecisionPreparationQualificationProbe>[0]["stage"],
    result: "Pass" | "Failure",
    error?: unknown,
    reasonCode?: SandboxPolicyPreparationReasonCode,
  ): Effect.Effect<void> =>
    dependencies.qualificationProbe === undefined
      ? Effect.void
      : Effect.promise(async () => {
          const record =
            typeof error === "object" && error !== null
              ? (error as Record<string, unknown>)
              : undefined;
          const nested =
            typeof record?.cause === "object" && record.cause !== null
              ? (record.cause as Record<string, unknown>)
              : undefined;
          const safeIdentifier = (value: unknown): string | undefined =>
            typeof value === "string" &&
            /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/u.test(value)
              ? value
              : undefined;
          const errorTag =
            safeIdentifier(record?._tag) ?? safeIdentifier(nested?._tag);
          const repository =
            safeIdentifier(record?.repository) ??
            safeIdentifier(nested?.repository);
          const operation =
            safeIdentifier(record?.operation) ??
            safeIdentifier(nested?.operation);
          try {
            await dependencies.qualificationProbe?.({
              stage,
              result,
              ...(errorTag === undefined ? {} : { errorTag }),
              ...(repository === undefined ? {} : { repository }),
              ...(operation === undefined ? {} : { operation }),
              ...(reasonCode === undefined ? {} : { reasonCode }),
            });
          } catch {
            // Qualification observers never change policy preparation.
          }
        });

  return {
    prepare: (payload, authority: DecisionAuthority) =>
      Effect.gen(function* () {
        const captured = yield* capture(dependencies, payload).pipe(
          Effect.tapError((error) => probe("Capture", "Failure", error)),
          Effect.tap(() => probe("Capture", "Pass")),
        );
        const workspace = captured.workspace;
        const execution = captured.execution;
        const authoritySnapshot = dependencies.authoritySnapshot;
        const bundle = authoritySnapshot?.bundle;
        const episode = executionEpisode(execution);
        const authorityFailureReason:
          | SandboxPolicyPreparationReasonCode
          | undefined =
          bundle === undefined || authoritySnapshot === undefined
            ? "AuthoritySnapshotUnavailable"
            : workspace.projectId !== payload.projectId
              ? "WorkspaceProjectMismatch"
              : workspace.lifecycle !== "Active"
                ? "WorkspaceInactive"
                : execution.projectId !== payload.projectId
                  ? "ExecutionProjectMismatch"
                  : execution.workspaceId !== payload.workspaceId
                    ? "ExecutionWorkspaceMismatch"
                    : execution.state.status !== "Active"
                      ? "ExecutionInactive"
                      : episode === undefined ||
                          encodeExecutionEpisodeBinding(episode) !==
                            encodeExecutionEpisodeBinding(
                              payload.episodeBinding,
                            )
                        ? "EpisodeMissingOrMismatch"
                        : authority.authorityBundleRevision !==
                            bundle.bundleRevision
                          ? "AuthorityBundleRevisionMismatch"
                          : authority.authorityBundleDigest !==
                              authoritySnapshot.bundleDigest
                            ? "AuthorityBundleDigestMismatch"
                            : authority.operatorConfigRevision !==
                                bundle.operatorConfigRevision
                              ? "AuthorityOperatorRevisionMismatch"
                              : authority.operatorConfigDigest !==
                                  bundle.operatorConfigDigest
                                ? "AuthorityOperatorDigestMismatch"
                                : undefined;
        if (authorityFailureReason !== undefined) {
          yield* probe(
            "Authority",
            "Failure",
            operationalFailure(
              "sandbox authority or active Execution is stale",
            ),
            authorityFailureReason,
          );
          return yield* Effect.fail(
            operationalFailure(
              "sandbox authority or active Execution is stale",
            ),
          );
        }
        if (bundle === undefined || authoritySnapshot === undefined)
          return yield* Effect.fail(
            operationalFailure("sandbox authority snapshot is unavailable"),
          );
        yield* probe("Authority", "Pass");

        const selection = decodeSandboxNetworkPolicySelectionV1(
          payload.networkPolicy,
        );
        if (selection === undefined) {
          yield* probe(
            "Selection",
            "Failure",
            operationalFailure("network policy is invalid"),
          );
          return yield* Effect.fail(
            operationalFailure("network policy is invalid"),
          );
        }
        if (selection.kind !== "TrustedLocalUnconfinedV1") {
          yield* probe(
            "Selection",
            "Failure",
            operationalFailure(
              "no qualified Supported OS provider is available; no fallback is permitted",
            ),
          );
          return yield* Effect.fail(
            operationalFailure(
              "no qualified Supported OS provider is available; no fallback is permitted",
            ),
          );
        }
        if (
          payload.profile !== "FullAccess" ||
          payload.providerId !== "TrustedLocal"
        ) {
          yield* probe(
            "Selection",
            "Failure",
            operationalFailure(
              "TrustedLocal requires the exact FullAccess selection",
            ),
          );
          return yield* Effect.fail(
            operationalFailure(
              "TrustedLocal requires the exact FullAccess selection",
            ),
          );
        }
        yield* probe("Selection", "Pass");
        const primaryWorktree = exactActiveWorktree(captured.worktrees);
        if (primaryWorktree === undefined) {
          yield* probe(
            "PrimaryWorktree",
            "Failure",
            operationalFailure(
              "exactly one active managed P11 Worktree is required",
            ),
          );
          return yield* Effect.fail(
            operationalFailure(
              "exactly one active managed P11 Worktree is required",
            ),
          );
        }
        yield* probe("PrimaryWorktree", "Pass");
        const resolved = yield* dependencies.environmentResolver
          .observe(workspace.projectId, workspace.resourceBoundary.addresses)
          .pipe(
            Effect.mapError((cause) =>
              operationalFailure(
                "complete P11 boundary observation failed: " +
                  errorMessage(cause),
              ),
            ),
            Effect.tapError((error) =>
              probe("CompleteBoundary", "Failure", error),
            ),
            Effect.tap(() => probe("CompleteBoundary", "Pass")),
          );
        if (!resolvedObservationIsConsistent(resolved)) {
          yield* probe(
            "CompleteBoundary",
            "Failure",
            operationalFailure(
              "P11 observation entries and normalized region set differ",
            ),
          );
          return yield* Effect.fail(
            operationalFailure(
              "P11 observation entries and normalized region set differ",
            ),
          );
        }
        const primary = yield* dependencies.environmentResolver
          .observe(workspace.projectId, [primaryWorktree.address])
          .pipe(
            Effect.mapError((cause) =>
              operationalFailure(
                "primary P11 Worktree observation failed: " +
                  errorMessage(cause),
              ),
            ),
            Effect.tapError((error) =>
              probe("PrimaryWorktreeObservation", "Failure", error),
            ),
            Effect.tap(() => probe("PrimaryWorktreeObservation", "Pass")),
          );
        if (primary.entries.length !== 1 || primary.entries[0] === undefined) {
          yield* probe(
            "PrimaryWorktreeObservation",
            "Failure",
            operationalFailure(
              "primary managed Worktree did not resolve exactly once",
            ),
          );
          return yield* Effect.fail(
            operationalFailure(
              "primary managed Worktree did not resolve exactly once",
            ),
          );
        }
        if (!resolvedObservationIsConsistent(primary)) {
          yield* probe(
            "PrimaryWorktreeObservation",
            "Failure",
            operationalFailure(
              "primary P11 observation entries and normalized set differ",
            ),
          );
          return yield* Effect.fail(
            operationalFailure(
              "primary P11 observation entries and normalized set differ",
            ),
          );
        }
        const primaryRegion = primary.entries[0].resolved;
        const boundary = produceSandboxBoundaryV1(
          {
            workspaceId: workspace.workspaceId,
            resourceBoundaryRevision: workspace.resourceBoundaryRevision,
            responsibilityRevision: workspace.responsibilityRevision,
            boundary: workspace.resourceBoundary,
            resolvedRegions: resolved.entries.map((entry) => entry.resolved),
            primaryManagedGitWorktreeRegion: primaryRegion,
            ownershipClaims: captured.ownershipClaims,
            policyKind: "TrustedLocalUnconfinedV1",
            profile: "FullAccess",
          },
          sha256Hex,
        );
        const limits = limitsForProfile(authoritySnapshot, "FullAccess");
        if (boundary === undefined) {
          yield* probe(
            "BoundaryMaterialization",
            "Failure",
            operationalFailure("P11 boundary materialization failed"),
          );
          return yield* Effect.fail(
            operationalFailure(
              "P11 boundary or operator policy materialization failed",
            ),
          );
        }
        yield* probe("BoundaryMaterialization", "Pass");
        if (limits === undefined) {
          yield* probe(
            "Limits",
            "Failure",
            operationalFailure("operator profile limits are missing"),
          );
          return yield* Effect.fail(
            operationalFailure(
              "P11 boundary or operator policy materialization failed",
            ),
          );
        }
        yield* probe("Limits", "Pass");
        const sandboxEnvironmentBasisDigest = sandboxEnvironmentBasisDigestOfV1(
          {
            version: 1,
            kind: "TrustedLocalUnconfinedV1",
            workspaceId: workspace.workspaceId,
            resourceBoundaryRevision: boundary.resourceBoundaryRevision,
            mounts: boundary.mounts,
            environmentAllowlist: bundle.operatorConfig.environmentAllowlist,
            limits,
            authorityBundleRevision: bundle.bundleRevision,
            authorityBundleDigest: authoritySnapshot.bundleDigest,
            operatorConfigRevision: bundle.operatorConfigRevision,
            operatorConfigDigest: bundle.operatorConfigDigest,
            trustedRuntimeVersion: "builtin-v1",
          },
          sha256Hex,
        );
        const summary: EffectivePolicySummaryV1 = {
          version: 1,
          kind: "TrustedLocalUnconfinedV1",
          projectId: payload.projectId,
          workspaceId: payload.workspaceId,
          executionId: payload.executionId,
          episodeBinding: payload.episodeBinding,
          workspaceRevision: workspace.revision,
          resourceBoundaryRevision: boundary.resourceBoundaryRevision,
          resourceBoundaryDigest: boundary.resourceBoundaryDigest,
          sandboxEnvironmentBasisDigest,
          policyRevision: captured.latestPolicyRevision + 1,
          expiresAt: payload.decisionExpiresAt,
          trustedRuntimeIdentity: "TrustedLocal",
          trustedRuntimeVersion: "builtin-v1",
          profile: "FullAccess",
          networkBoundary: "Unconfined",
          sandboxHandleBindingDigest: boundary.sandboxHandleBindingDigest,
          mounts: boundary.mounts,
          environmentAllowlist: bundle.operatorConfig.environmentAllowlist,
          limits,
          auditRefs: [String(authority.commandId)],
          authorityBundleRevision: bundle.bundleRevision,
          authorityBundleDigest: authoritySnapshot.bundleDigest,
          operatorConfigRevision: bundle.operatorConfigRevision,
          operatorConfigDigest: bundle.operatorConfigDigest,
        };
        const prepared: PreparedInputs = {
          captured,
          boundary: workspace.resourceBoundary,
          resolvedRegions: resolved.entries.map((entry) => entry.resolved),
          primaryWorktree,
          primaryRegion,
          summary,
          kind: "TrustedLocalUnconfinedV1",
        };
        preparedByPayload.set(payload, prepared);
        return summary;
      }),

    currentPreconditions: (payload) =>
      readCurrentSourceRows(dependencies, payload).pipe(
        Effect.tapError((error) =>
          probe("CurrentPreconditions", "Failure", error),
        ),
        Effect.map((rows) => {
          const captured = capturedFromRows(rows);
          const prepared = preparedByPayload.get(payload);
          preparedByPayload.delete(payload);
          if (
            captured === undefined ||
            prepared === undefined ||
            captured.workspace.lifecycle !== "Active" ||
            captured.workspace.revision !==
              prepared.captured.workspace.revision ||
            captured.workspace.resourceBoundaryRevision !==
              prepared.captured.workspace.resourceBoundaryRevision ||
            captured.workspace.responsibilityRevision !==
              prepared.captured.workspace.responsibilityRevision ||
            JSON.stringify(captured.workspace.resourceBoundary) !==
              JSON.stringify(prepared.boundary)
          )
            return makeCurrentPreconditions(
              payload,
              captured,
              undefined,
              dependencies.authoritySnapshot,
            );
          const activePrimary = exactActiveWorktree(captured.worktrees);
          if (
            activePrimary === undefined ||
            !sameWorktree(activePrimary, prepared.primaryWorktree)
          )
            return makeCurrentPreconditions(
              payload,
              captured,
              undefined,
              dependencies.authoritySnapshot,
            );
          const boundary = produceSandboxBoundaryV1(
            {
              workspaceId: captured.workspace.workspaceId,
              resourceBoundaryRevision:
                captured.workspace.resourceBoundaryRevision,
              responsibilityRevision: captured.workspace.responsibilityRevision,
              boundary: captured.workspace.resourceBoundary,
              resolvedRegions: prepared.resolvedRegions,
              primaryManagedGitWorktreeRegion: prepared.primaryRegion,
              ownershipClaims: captured.ownershipClaims,
              policyKind: "TrustedLocalUnconfinedV1",
              profile: "FullAccess",
            },
            sha256Hex,
          );
          return makeCurrentPreconditions(
            payload,
            captured,
            boundary === undefined
              ? undefined
              : {
                  ...prepared,
                  summary: {
                    ...prepared.summary,
                    sandboxHandleBindingDigest:
                      boundary.sandboxHandleBindingDigest,
                  },
                },
            dependencies.authoritySnapshot,
          );
        }),
        Effect.tap(() => probe("CurrentPreconditions", "Pass")),
      ),
  };
};
