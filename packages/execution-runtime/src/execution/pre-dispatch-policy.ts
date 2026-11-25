import { workspaceSandboxPolicyBindingIsAuthorized } from "@arbor/application";
import {
  type Execution,
  type ExecutionId,
  encodeExecutionEpisodeBinding,
  executionEpisode,
  type SandboxAuthorityBundleSnapshotCurrent,
} from "@arbor/domain";
import {
  type AttentionProjectionStoreService,
  type ClockService,
  type CommittedSandboxPolicyDecisionV1,
  type CurrentSandboxAuthoritySnapshotPortService,
  type P39RecoveryEvidenceStoreService,
  type SandboxPolicyDecisionStoreService,
  type SandboxPolicyRequirementReadPortService,
  type SandboxProviderUnavailableStoreService,
  type TransactionPortService,
  type WorkspaceRepositoryService,
  type WorkspaceSandboxAuthorizationStoreService,
  WorkspaceSandboxPolicyBindingPort,
} from "@arbor/ports";
import { Effect, Option } from "effect";

/** P2 pre-dispatch check. P4 still performs the final currentness check at
 * effect admission; this earlier guard prevents a known-stale policy from
 * acquiring a lease or dispatching a Worker. */
const sandboxPolicyDecisionIsCurrentForRequirement = (input: {
  readonly execution: Execution;
  readonly requirement: import("@arbor/ports").SandboxPolicyRequirementV1;
  readonly committed: CommittedSandboxPolicyDecisionV1;
  readonly authority: SandboxAuthorityBundleSnapshotCurrent;
  readonly now: string;
}): boolean => {
  const { execution, requirement, committed, authority } = input;
  const decision = committed.decision;
  const result = committed.result;
  const snapshot = result.effectivePolicySnapshot;
  const currentEpisode = executionEpisode(execution);
  if (currentEpisode === undefined) return false;
  const episodeJson = encodeExecutionEpisodeBinding(currentEpisode);
  const bundle = authority.bundle;
  const commonCurrent =
    execution.projectId === requirement.projectId &&
    execution.workspaceId === requirement.workspaceId &&
    execution.executionId === requirement.executionId &&
    encodeExecutionEpisodeBinding(requirement.episodeBinding) === episodeJson &&
    decision.projectId === requirement.projectId &&
    decision.workspaceId === requirement.workspaceId &&
    decision.executionId === requirement.executionId &&
    encodeExecutionEpisodeBinding(decision.episodeBinding) === episodeJson &&
    decision.expectedExecutionRevision ===
      requirement.expectedEpisodeRevision &&
    result.commandId === decision.decisionCommandId &&
    result.projectId === decision.projectId &&
    result.workspaceId === decision.workspaceId &&
    result.executionId === decision.executionId &&
    encodeExecutionEpisodeBinding(result.episodeBinding) === episodeJson &&
    result.policyRevision === decision.policyRevision &&
    result.policyDigest === decision.policyDigest &&
    snapshot.projectId === decision.projectId &&
    snapshot.workspaceId === decision.workspaceId &&
    snapshot.executionId === decision.executionId &&
    encodeExecutionEpisodeBinding(snapshot.episodeBinding) === episodeJson &&
    snapshot.policyRevision === decision.policyRevision &&
    snapshot.expiresAt === decision.expiresAt &&
    Date.parse(decision.expiresAt) > Date.parse(input.now) &&
    snapshot.authorityBundleRevision === bundle.bundleRevision &&
    snapshot.authorityBundleDigest === authority.bundleDigest;
  if (!commonCurrent) return false;

  if (snapshot.kind === "TrustedLocalUnconfinedV1") {
    const trustedMatches =
      snapshot.trustedRuntimeIdentity === "TrustedLocal" &&
      snapshot.trustedRuntimeVersion === "builtin-v1" &&
      snapshot.profile === "FullAccess" &&
      snapshot.networkBoundary === "Unconfined" &&
      decision.providerId === "TrustedLocal" &&
      decision.profile === "FullAccess" &&
      decision.networkPolicy.kind === "TrustedLocalUnconfinedV1" &&
      decision.networkPolicy.version === 1;
    return trustedMatches;
  }

  return (
    decision.providerId === snapshot.providerId &&
    decision.profile === snapshot.profile &&
    decision.networkPolicy.kind === "OsEnforced" &&
    JSON.stringify(decision.networkPolicy.policy) ===
      JSON.stringify(snapshot.networkPolicy) &&
    snapshot.providerRegistryRevision === bundle.providerRegistryRevision &&
    snapshot.providerRegistryDigest === bundle.providerRegistryDigest
  );
};

/** The pre-dispatch policy gate never grants authority or admits a tool effect. */
export const checkExecutionPolicyBeforeDispatch = (
  execution: Execution,
  executionId: ExecutionId,
  tx: TransactionPortService,
  clock: ClockService,
  sandboxPolicyRequirements: Option.Option<SandboxPolicyRequirementReadPortService>,
  currentAuthoritySnapshotPort: Option.Option<CurrentSandboxAuthoritySnapshotPortService>,
  sandboxPolicyDecisions: Option.Option<SandboxPolicyDecisionStoreService>,
  workspaceAuthorizations: Option.Option<WorkspaceSandboxAuthorizationStoreService>,
  policyWorkspaces: Option.Option<WorkspaceRepositoryService>,
  attentionProjection: Option.Option<AttentionProjectionStoreService>,
  p39RecoveryEvidence: Option.Option<P39RecoveryEvidenceStoreService>,
  sandboxUnavailableStore: Option.Option<SandboxProviderUnavailableStoreService>,
) =>
  Effect.gen(function* () {
    // Standing authority is converted to an exact execution snapshot before
    // any policy-dependent recovery gate can block the same admitted episode.
    const workspacePolicyBinding = yield* Effect.serviceOption(
      WorkspaceSandboxPolicyBindingPort,
    );
    if (Option.isSome(workspacePolicyBinding)) {
      yield* workspacePolicyBinding.value.ensureForExecution(executionId);
    }
    if (Option.isSome(sandboxPolicyRequirements)) {
      const pendingRequirement = yield* tx.transact(
        sandboxPolicyRequirements.value.findPendingByExecution({
          projectId: execution.projectId,
          workspaceId: execution.workspaceId,
          executionId,
        }),
      );
      let policyMustWaitForHuman = false;
      if (
        Option.isSome(pendingRequirement) &&
        pendingRequirement.value._tag === "SandboxPolicyRequirementV1"
      ) {
        const currentAuthority = Option.isSome(currentAuthoritySnapshotPort)
          ? yield* currentAuthoritySnapshotPort.value.loadCurrentVerifiedV2()
          : { _tag: "Unavailable" as const, failure: "SourceMissing" as const };
        const now = yield* clock.now();
        policyMustWaitForHuman = yield* tx.transact(
          Effect.gen(function* () {
            // Re-read the exact proof after the effectful P5 source/high-water
            // load. This closes a requirement change during that read window.
            const requirement =
              yield* sandboxPolicyRequirements.value.findPendingByExecution({
                projectId: execution.projectId,
                workspaceId: execution.workspaceId,
                executionId,
              });
            if (
              Option.isNone(requirement) ||
              requirement.value._tag !== "SandboxPolicyRequirementV1"
            )
              return false;
            if (
              currentAuthority._tag !== "Available" ||
              Option.isNone(sandboxPolicyDecisions)
            ) {
              return true;
            }
            const current =
              yield* sandboxPolicyDecisions.value.findCurrentForExecution(
                execution.projectId,
                execution.workspaceId,
                executionId,
              );
            if (Option.isNone(current)) return true;
            if (
              current.value.decision.authorityKind === "WorkspaceAuthorization"
            ) {
              if (
                Option.isNone(workspaceAuthorizations) ||
                Option.isNone(policyWorkspaces)
              )
                return true;
              const authorized =
                yield* workspaceSandboxPolicyBindingIsAuthorized(
                  {
                    workspaces: policyWorkspaces.value,
                    authorizations: workspaceAuthorizations.value,
                  },
                  { ...current.value, now },
                );
              if (!authorized) return true;
            }
            return !sandboxPolicyDecisionIsCurrentForRequirement({
              execution: execution,
              requirement: requirement.value,
              committed: current.value,
              authority: currentAuthority.snapshot,
              now,
            });
          }),
        );
      }
      if (policyMustWaitForHuman) {
        return { _tag: "RecoveryBlocked" as const };
      }
    }
    if (
      Option.isSome(attentionProjection) &&
      Option.isSome(p39RecoveryEvidence) &&
      attentionProjection.value.listSandboxPolicyDecisionRequired !== undefined
    ) {
      const now = yield* clock.now();
      const required = yield* tx.transact(
        attentionProjection.value.listSandboxPolicyDecisionRequired(
          execution.projectId,
          now,
        ),
      );
      if (required.some((item) => item.executionId === executionId)) {
        return { _tag: "RecoveryBlocked" as const };
      }
    }
    if (
      Option.isSome(sandboxUnavailableStore) &&
      Option.isSome(sandboxPolicyDecisions)
    ) {
      const currentPolicy = yield* tx.transact(
        sandboxPolicyDecisions.value.findCurrentForExecution(
          execution.projectId,
          execution.workspaceId,
          executionId,
        ),
      );
      if (Option.isSome(currentPolicy)) {
        const decision = currentPolicy.value.decision;
        const snapshot = currentPolicy.value.result.effectivePolicySnapshot;
        const fact = yield* tx.transact(
          sandboxUnavailableStore.value.findByExecutionAndRevision(
            executionId,
            decision.policyRevision,
          ),
        );
        if (fact !== undefined) {
          if (
            snapshot.kind !== "OsEnforced" ||
            fact.projectId !== decision.projectId ||
            fact.workspaceId !== decision.workspaceId ||
            encodeExecutionEpisodeBinding(fact.episodeBinding) !==
              encodeExecutionEpisodeBinding(decision.episodeBinding) ||
            fact.policyDigest !== decision.policyDigest ||
            fact.profileId !== snapshot.profile ||
            fact.providerId !== snapshot.providerId ||
            fact.providerVersion !== snapshot.providerVersion
          ) {
            return yield* Effect.fail({
              _tag: "SandboxProviderUnavailableFactInvariantConflict" as const,
              reason:
                "current policy head conflicts with its immutable unavailable fact",
            });
          }
          return { _tag: "RecoveryBlocked" as const };
        }
      }
    }
    return undefined;
  });
