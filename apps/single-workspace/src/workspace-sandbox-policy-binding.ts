import {
  type AuthorityResolverPortService,
  type BindWorkspaceSandboxPolicyPayload,
  type CommandGatewayService,
  loadWorkspaceSandboxAuthorizationSnapshot,
  newUuid7,
  semanticRequestFingerprint,
  workspaceSandboxPolicyBindingIsAuthorized,
} from "@arbor/application";
import {
  Actor,
  CommandId,
  encodeExecutionEpisodeBinding,
  encodeSandboxEnforcementRuleSetV2,
  executionEpisode,
  isIsoTimestamp,
  makeProjectPolicy,
  Principal,
  parse,
  produceSandboxBoundaryV1,
  resolveWorkspaceSandboxAuthorization,
  sandboxEnforcementRuleSetV2ForProvider,
} from "@arbor/domain";
import {
  type ClockService,
  type CurrentSandboxAuthoritySnapshotPortService,
  type ExecutionRepositoryService,
  type IdGeneratorService,
  type SandboxPolicyCandidateBoundaryReadPortService,
  type SandboxPolicyDecisionStoreService,
  type SandboxProviderUnavailableStoreService,
  sha256Hex,
  type TransactionPortService,
  type WorkspaceRepositoryService,
  type WorkspaceSandboxAuthorizationStoreService,
  type WorkspaceSandboxPolicyBindingOutcome,
  type WorkspaceSandboxPolicyBindingPortService,
} from "@arbor/ports";
import { Effect, Option } from "effect";

export interface WorkspaceSandboxPolicyBindingDependencies {
  readonly transaction: TransactionPortService;
  readonly workspaces: Pick<WorkspaceRepositoryService, "findById">;
  readonly executions: Pick<
    ExecutionRepositoryService,
    "findById" | "findEpisodeRevision"
  >;
  readonly authorizations: Pick<
    WorkspaceSandboxAuthorizationStoreService,
    "findCurrent"
  >;
  readonly decisions: Pick<
    SandboxPolicyDecisionStoreService,
    "findCurrentForExecution"
  >;
  readonly unavailable: Pick<
    SandboxProviderUnavailableStoreService,
    "findByExecutionAndRevision"
  >;
  readonly boundary: SandboxPolicyCandidateBoundaryReadPortService;
  readonly currentHost: CurrentSandboxAuthoritySnapshotPortService;
  readonly gateway: CommandGatewayService;
  readonly resolver: AuthorityResolverPortService;
  readonly clock: Pick<ClockService, "now">;
  readonly ids: IdGeneratorService;
}

/** One-hour renewable execution snapshots do not shorten standing permission.
 * The human/Parent authorization remains the sole capability ceiling. */
const POLICY_LIFETIME_MS = 60 * 60 * 1000;
const principal = parse(Principal)("runtime:workspace-policy");

/** Composes existing boundary production, authority resolution and Gateway.
 * It never writes a decision or permission directly, and never falls back to
 * legacy human grants when current Workspace authority is unavailable. */
export const makeWorkspaceSandboxPolicyBindingService = (
  dependencies: WorkspaceSandboxPolicyBindingDependencies,
): WorkspaceSandboxPolicyBindingPortService => ({
  ensureForExecution: (executionId) => {
    const attempt = () =>
      Effect.gen(function* () {
        const host = yield* dependencies.currentHost.loadCurrentVerifiedV2();
        const now = yield* dependencies.clock.now();
        if (!isIsoTimestamp(now)) return { _tag: "Unavailable" } as const;
        const captured = yield* dependencies.transaction.transact(
          Effect.gen(function* () {
            const execution =
              yield* dependencies.executions.findById(executionId);
            if (
              Option.isNone(execution) ||
              execution.value.state.status !== "Active" ||
              execution.value.stopRequestedAt !== null ||
              executionEpisode(execution.value) === undefined
            )
              return { _tag: "NotApplicable" } as const;
            const target = execution.value;
            const snapshot = yield* loadWorkspaceSandboxAuthorizationSnapshot(
              dependencies,
              target.projectId,
              target.workspaceId,
            );
            const current = resolveWorkspaceSandboxAuthorization({
              ...snapshot,
              projectId: target.projectId,
              workspaceId: target.workspaceId,
              now,
            });
            if (current._tag !== "Authorized")
              return { _tag: "AuthorizationRequired" } as const;
            const revision =
              yield* dependencies.executions.findEpisodeRevision(executionId);
            if (Option.isNone(revision))
              return { _tag: "NotApplicable" } as const;
            if (
              host._tag !== "Available" ||
              host.currentHost.osFamily !== "Linux"
            )
              return { _tag: "Unavailable" } as const;
            const authorization = current.authorization;
            const ruleSet = sandboxEnforcementRuleSetV2ForProvider(
              authorization.providerId,
            );
            if (ruleSet === undefined) return { _tag: "Unavailable" } as const;
            const ruleDigest = sha256Hex(
              encodeSandboxEnforcementRuleSetV2(ruleSet),
            );
            const entries =
              host.snapshot.bundle.providerRegistry.entries.filter(
                (entry) =>
                  entry.status === "Supported" &&
                  entry.providerId === authorization.providerId &&
                  entry.osFamily === "Linux" &&
                  entry.osBuild === host.currentHost.osBuild &&
                  entry.tuple.profile === authorization.profile &&
                  entry.tuple.networkMode ===
                    authorization.networkPolicy.mode &&
                  entry.tuple.networkPolicyCodecVersion === 1 &&
                  entry.tuple.enforcementRuleSetDigest === ruleDigest &&
                  entry.qualificationEvidenceRef !== null,
              );
            if (entries.length !== 1 || entries[0] === undefined)
              return { _tag: "Unavailable" } as const;
            const entry = entries[0];
            const boundaryRead = yield* Effect.result(
              dependencies.boundary.readCurrentForWorkspace({
                projectId: target.projectId,
                workspaceId: target.workspaceId,
              }),
            );
            if (boundaryRead._tag === "Failure")
              return { _tag: "Unavailable" } as const;
            const boundary = boundaryRead.success;
            const produced = produceSandboxBoundaryV1(
              {
                workspaceId: target.workspaceId,
                resourceBoundaryRevision:
                  boundary.workspace.resourceBoundaryRevision,
                responsibilityRevision:
                  boundary.workspace.responsibilityRevision,
                boundary: boundary.workspace.resourceBoundary,
                resolvedRegions: boundary.resolvedRegions,
                primaryResourceRegion: boundary.primaryResourceRegion,
                ownershipClaims: boundary.ownershipClaims,
                policyKind: "OsEnforced",
                profile: authorization.profile,
              },
              sha256Hex,
            );
            if (produced === undefined) return { _tag: "Unavailable" } as const;
            const committed =
              yield* dependencies.decisions.findCurrentForExecution(
                target.projectId,
                target.workspaceId,
                executionId,
              );
            if (
              Option.isSome(committed) &&
              (yield* dependencies.unavailable.findByExecutionAndRevision(
                executionId,
                committed.value.decision.policyRevision,
              )) === undefined &&
              (yield* workspaceSandboxPolicyBindingIsAuthorized(dependencies, {
                ...committed.value,
                now,
              }))
            ) {
              const { decision, result } = committed.value;
              const policy = result.effectivePolicySnapshot;
              const episode = executionEpisode(target);
              const bundle = host.snapshot.bundle;
              if (
                policy.version === 2 &&
                episode !== undefined &&
                encodeExecutionEpisodeBinding(decision.episodeBinding) ===
                  encodeExecutionEpisodeBinding(episode) &&
                decision.expectedExecutionRevision === revision.value &&
                policy.workspaceRevision === boundary.workspace.revision &&
                policy.resourceBoundaryRevision ===
                  boundary.workspace.resourceBoundaryRevision &&
                policy.resourceBoundaryDigest ===
                  produced.resourceBoundaryDigest &&
                policy.sandboxHandleBindingDigest ===
                  produced.sandboxHandleBindingDigest &&
                policy.authorityBundleRevision === bundle.bundleRevision &&
                policy.authorityBundleDigest === host.snapshot.bundleDigest &&
                policy.operatorConfigRevision ===
                  bundle.operatorConfigRevision &&
                policy.operatorConfigDigest === bundle.operatorConfigDigest &&
                policy.providerRegistryRevision ===
                  bundle.providerRegistryRevision &&
                policy.providerRegistryDigest ===
                  bundle.providerRegistryDigest &&
                policy.providerVersion === entry.providerVersion &&
                policy.capabilityRevision === entry.capabilityRevision &&
                policy.osBuild === entry.osBuild &&
                policy.qualificationEvidenceRef ===
                  entry.qualificationEvidenceRef
              )
                return {
                  _tag: "Ready",
                  policyRevision: policy.policyRevision,
                } as const;
            }
            return {
              _tag: "Prepare" as const,
              target,
              authorization,
              snapshot,
              entry,
              boundary,
              produced,
              episodeRevision: revision.value,
              policyRevision: Option.isSome(committed)
                ? committed.value.decision.policyRevision
                : 0,
            };
          }),
        );
        if (captured._tag !== "Prepare") return captured;
        if (host._tag !== "Available") return { _tag: "Unavailable" } as const;
        const { target, authorization, entry, boundary, produced } = captured;
        const episode = executionEpisode(target);
        if (episode === undefined) return { _tag: "NotApplicable" } as const;
        const bundle = host.snapshot.bundle;
        const expiry = Math.min(
          Date.parse(now) + POLICY_LIFETIME_MS,
          authorization.expiresAt === null
            ? Infinity
            : Date.parse(authorization.expiresAt),
        );
        const payload: BindWorkspaceSandboxPolicyPayload = {
          projectId: target.projectId,
          workspaceId: target.workspaceId,
          executionId,
          episodeBinding: episode,
          expectedAuthorizationRevision: authorization.authorizationRevision,
          expectedEpisodeRevision: captured.episodeRevision,
          expectedPolicyRevision: captured.policyRevision,
          expectedWorkspaceRevision: boundary.workspace.revision,
          expectedResourceBoundaryRevision:
            boundary.workspace.resourceBoundaryRevision,
          expectedSandboxHandleBindingDigest:
            produced.sandboxHandleBindingDigest,
          expectedAuthorityBundleRevision: bundle.bundleRevision,
          expectedAuthorityBundleDigest: host.snapshot.bundleDigest,
          expectedOperatorConfigRevision: bundle.operatorConfigRevision,
          expectedOperatorConfigDigest: bundle.operatorConfigDigest,
          expectedProviderRegistryRevision: bundle.providerRegistryRevision,
          expectedProviderRegistryDigest: bundle.providerRegistryDigest,
          profile: authorization.profile,
          providerId: authorization.providerId,
          providerVersion: entry.providerVersion,
          capabilityRevision: entry.capabilityRevision,
          networkPolicy: {
            kind: "OsEnforced",
            policy: authorization.networkPolicy,
          },
          decisionExpiresAt: new Date(expiry).toISOString(),
        };
        const commandSeed =
          yield* dependencies.ids.generate<string>("CommandId");
        const commandId = parse(CommandId)(
          `cmd_${newUuid7("workspace-sandbox-policy-binding", commandSeed)}`,
        );
        const causationRef = `workspace-policy:${executionId}`;
        const context = { _tag: "System" as const, principal, causationRef };
        const envelope = {
          commandType: "BindWorkspaceSandboxPolicy",
          commandId,
          projectId: target.projectId,
          actor: parse(Actor)(principal),
          issuedAt: now,
          causationRef,
          payload,
        };
        const resolved = yield* Effect.result(
          dependencies.resolver.resolve({
            principal,
            submissionContext: context,
            envelope,
            semanticRequestFingerprint: semanticRequestFingerprint({
              ...envelope,
              schemaVersion: "1",
            }),
            canonicalFacts: {
              projectId: target.projectId,
              workspace: boundary.workspace,
              execution: {
                executionId,
                projectId: target.projectId,
                workspaceId: target.workspaceId,
                status: "Active",
                episodeBinding: episode,
                episodeRevision: captured.episodeRevision,
              },
            },
            grants: [],
            governance: { authenticatedHumans: [], directParentOf: [] },
            policy: makeProjectPolicy(),
            workspaceSandboxAuthorizationSnapshot: captured.snapshot,
            workspaceSandboxAuthorizationNow: now,
            workspaceSandboxPolicyHostSnapshot: {
              authorityBundleRevision: bundle.bundleRevision,
              authorityBundleDigest: host.snapshot.bundleDigest,
              operatorConfigRevision: bundle.operatorConfigRevision,
              operatorConfigDigest: bundle.operatorConfigDigest,
              providerRegistryRevision: bundle.providerRegistryRevision,
              providerRegistryDigest: bundle.providerRegistryDigest,
            },
          }),
        );
        if (resolved._tag === "Failure")
          return { _tag: "AuthorizationRequired" } as const;
        const receipt = yield* dependencies.gateway.execute<
          BindWorkspaceSandboxPolicyPayload,
          import("@arbor/domain").SandboxPolicyDecisionCommittedInternalV3
        >(envelope, context, resolved.success);
        if (receipt.resolution._tag === "Committed")
          return {
            _tag: "Ready",
            policyRevision: receipt.resolution.result.policyRevision,
          } as const;
        return {
          _tag:
            receipt.resolution.error._tag === "StaleSandboxPolicyInputs"
              ? "Stale"
              : receipt.resolution.error._tag === "AuthorityDenied"
                ? "AuthorizationRequired"
                : "Unavailable",
        } as WorkspaceSandboxPolicyBindingOutcome;
      });
    return attempt().pipe(
      Effect.flatMap((outcome) =>
        outcome._tag === "Stale" ? attempt() : Effect.succeed(outcome),
      ),
      Effect.mapError((cause) => ({
        _tag: "TransactionOperationalFailure" as const,
        cause,
      })),
    );
  },
});
