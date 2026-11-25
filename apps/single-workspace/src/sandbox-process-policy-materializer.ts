import { realpathSync } from "node:fs";
import { relative, sep } from "node:path";
import { workspaceSandboxPolicyBindingIsAuthorized } from "@arbor/application";
import type { ResourceAddress } from "@arbor/domain";
import {
  canonicalRegionString,
  compareUtf8BytesV1,
  decodeCanonicalVerificationSandboxBindingV1,
  encodeExecutionEpisodeBinding,
  encodeNetworkPolicyV1,
  encodeSandboxEnforcementRuleSetV1,
  encodeSandboxEnforcementRuleSetV2,
  encodeVerificationSandboxBindingV1,
  executionEpisode,
  networkBrokerControlsV2ForMode,
  type OsEnforcedPolicySummaryV1,
  type OsEnforcedPolicySummaryV2,
  produceSandboxBoundaryV1,
  type SandboxProviderQualificationEntryV1,
  sandboxEnforcementRuleSetV1ForProvider,
  sandboxEnforcementRuleSetV2ForProvider,
  sandboxEnvironmentBasisDigestOfV1,
  sandboxTargetRefOfRegionV1,
} from "@arbor/domain";
import type { TrustedHostConfigurationSourceService } from "@arbor/ports";
import {
  type BlobStorePortService,
  EnvironmentResolverPort,
  ExecutionRepository,
  ResourceOwnershipRepository,
  SANDBOX_ENV_ALLOWLIST,
  type SandboxMountBinding,
  SandboxPolicyDecisionStore,
  type SandboxProcessPolicy,
  sha256Hex,
  TransactionPort,
  WorkspaceRepository,
  WorkspaceSandboxAuthorizationStore,
  WorktreeStore,
} from "@arbor/ports";
import {
  fixedWindowsNativeProductionArtifactPaths,
  inspectWindowsNativeQualificationForRegistryEntryV3,
  WINDOWS_SANDBOX_PROVIDER_IDS,
  type WindowsNativeQualificationIo,
} from "@arbor/sandbox-windows";
import { Context, Effect, Option } from "effect";
import { sandboxPolicyCurrentHostV1 } from "./current-sandbox-authority-snapshot-port.js";
import { loadSandboxAuthorityBundleSnapshotCurrent } from "./sandbox-authority-bundle.js";
import type { PreparedVerificationCommandEnvironment } from "./verification-command-environment.js";

type PrimaryResourceAddress = Extract<
  ResourceAddress,
  { readonly _tag: "FileTree" | "GitWorktree" }
>;

/** P4 pre-effect identity gate. It reopens current P5 source/high-water and
 * every fixed installed artifact; a previous capability probe is not enough.
 * The current Windows provider still has no Supported/run path. */
export const inspectWindowsQualificationAtP4Admission = (input: {
  readonly source: TrustedHostConfigurationSourceService | undefined;
  readonly now: string;
  readonly summary: Pick<
    OsEnforcedPolicySummaryV1,
    | "providerId"
    | "providerVersion"
    | "capabilityRevision"
    | "osFamily"
    | "osBuild"
    | "qualificationEvidenceRef"
    | "profile"
    | "networkPolicy"
  >;
  readonly io?: WindowsNativeQualificationIo;
}) =>
  Effect.gen(function* () {
    const currentHost = sandboxPolicyCurrentHostV1();
    if (currentHost === undefined || currentHost.osFamily !== "Windows")
      return { _tag: "Unavailable" as const, reason: "WindowsHostRequired" };
    const current = yield* loadSandboxAuthorityBundleSnapshotCurrent(
      input.source,
      input.now,
      SANDBOX_ENV_ALLOWLIST,
    );
    if (current._tag !== "Available" || current.snapshot.bundle.version !== 3)
      return {
        _tag: "Unavailable" as const,
        reason: "TrustCurrentnessMismatch",
      };
    const row = current.snapshot.bundle.providerRegistry.entries.find(
      (entry) =>
        entry.providerId === input.summary.providerId &&
        entry.providerVersion === input.summary.providerVersion &&
        entry.capabilityRevision === input.summary.capabilityRevision &&
        entry.osFamily === input.summary.osFamily &&
        entry.osBuild === input.summary.osBuild &&
        entry.tuple.profile === input.summary.profile &&
        entry.tuple.networkMode === input.summary.networkPolicy.mode &&
        entry.qualificationEvidenceRef ===
          input.summary.qualificationEvidenceRef,
    );
    if (row === undefined)
      return {
        _tag: "Unavailable" as const,
        reason: "RegistryQualificationBindingMismatch",
      };
    return inspectWindowsNativeQualificationForRegistryEntryV3(
      fixedWindowsNativeProductionArtifactPaths(),
      row,
      current.snapshot,
      currentHost,
      input.now,
      input.io,
    );
  });

export const exactSupportedOsProviderEntry = (
  entries: ReadonlyArray<SandboxProviderQualificationEntryV1>,
  summary: Pick<
    OsEnforcedPolicySummaryV1,
    | "providerId"
    | "providerVersion"
    | "capabilityRevision"
    | "osFamily"
    | "osBuild"
    | "qualificationEvidenceRef"
    | "profile"
    | "networkPolicy"
    | "networkBrokerControls"
  >,
): SandboxProviderQualificationEntryV1 | undefined => {
  const ruleSet = sandboxEnforcementRuleSetV1ForProvider(summary.providerId);
  if (ruleSet === undefined) return undefined;
  const expectedRuleSetDigest = sha256Hex(
    encodeSandboxEnforcementRuleSetV1(ruleSet),
  );
  const exact = entries.filter(
    (entry) =>
      entry.status === "Supported" &&
      entry.providerId === summary.providerId &&
      entry.providerVersion === summary.providerVersion &&
      entry.capabilityRevision === summary.capabilityRevision &&
      entry.osFamily === summary.osFamily &&
      entry.osBuild === summary.osBuild &&
      entry.qualificationEvidenceRef === summary.qualificationEvidenceRef &&
      entry.tuple.profile === summary.profile &&
      entry.tuple.networkMode === summary.networkPolicy.mode &&
      entry.tuple.enforcementRuleSetDigest === expectedRuleSetDigest &&
      entry.tuple.networkPolicyCodecVersion === 1,
  );
  return exact.length === 1 ? exact[0] : undefined;
};

export const exactSupportedOsProviderEntryV2 = (
  entries: ReadonlyArray<SandboxProviderQualificationEntryV1>,
  summary: Pick<
    OsEnforcedPolicySummaryV2,
    | "providerId"
    | "providerVersion"
    | "capabilityRevision"
    | "osFamily"
    | "osBuild"
    | "qualificationEvidenceRef"
    | "profile"
    | "networkPolicy"
    | "networkBrokerControls"
  >,
): SandboxProviderQualificationEntryV1 | undefined => {
  const ruleSet = sandboxEnforcementRuleSetV2ForProvider(summary.providerId);
  if (ruleSet === undefined || summary.osFamily !== "Linux") return undefined;
  const expectedRuleSetDigest = sha256Hex(
    encodeSandboxEnforcementRuleSetV2(ruleSet),
  );
  const exact = entries.filter(
    (entry) =>
      entry.status === "Supported" &&
      entry.providerId === summary.providerId &&
      entry.providerVersion === summary.providerVersion &&
      entry.capabilityRevision === summary.capabilityRevision &&
      entry.osFamily === summary.osFamily &&
      entry.osBuild === summary.osBuild &&
      entry.qualificationEvidenceRef === summary.qualificationEvidenceRef &&
      entry.tuple.profile === summary.profile &&
      entry.tuple.networkMode === summary.networkPolicy.mode &&
      entry.tuple.enforcementRuleSetDigest === expectedRuleSetDigest &&
      entry.tuple.networkPolicyCodecVersion === 1,
  );
  return exact.length === 1 ? exact[0] : undefined;
};

export interface MaterializedSandboxProcessPolicy {
  readonly policy: SandboxProcessPolicy;
  readonly mounts: ReadonlyArray<SandboxMountBinding>;
}

const contained = (root: string, candidate: string): boolean => {
  const part = relative(root, candidate);
  return (
    part === "" ||
    (!part.startsWith(`..${sep}`) && part !== ".." && !part.includes("\0"))
  );
};

const blobRefDigest = (ref: string): string | undefined =>
  /^blob:sha256:[0-9a-f]{64}$/u.test(ref)
    ? ref.slice("blob:sha256:".length)
    : undefined;

/**
 * Materialize the process-only policy for a Verifier's captured copy.
 *
 * This path is intentionally separate from the Workspace episode policy. It
 * validates the captured binding and BlobStore records, rechecks the source
 * authorization, and proves that every writable mount is an owned private
 * copy below the runtime directory. The ordinary Workspace policy materializer
 * must never be used as a fallback here.
 */
export const materializeIndependentVerificationProcessPolicy = (input: {
  readonly prepared: PreparedVerificationCommandEnvironment;
  readonly now: string;
  readonly blobs: BlobStorePortService;
}): Effect.Effect<MaterializedSandboxProcessPolicy | undefined> =>
  Effect.gen(function* () {
    const prepared = input.prepared;
    const binding = prepared.verificationBinding;
    const inputManifestRef = prepared.inputManifestRef;
    const qualificationRef = prepared.verificationMountQualificationEvidenceRef;
    const limits = prepared.limits;
    const environmentAllowlist = prepared.environmentAllowlist;
    const providerQualificationRef =
      prepared.providerCandidate.qualificationEvidenceRef;
    if (
      binding === undefined ||
      inputManifestRef === undefined ||
      qualificationRef === undefined ||
      limits === undefined ||
      environmentAllowlist === undefined ||
      providerQualificationRef === null ||
      prepared.providerCandidate.providerId !== "linux-bwrap" ||
      prepared.providerCandidate.osFamily !== "Linux" ||
      providerQualificationRef === null ||
      Date.parse(binding.expiresAt) <= Date.parse(input.now) ||
      binding.inputDigest !== prepared.inputDigest ||
      binding.sourceBasisDigest !== prepared.basisDigest ||
      binding.authorizationRevision !== prepared.authorizationRevision ||
      binding.projectId !== prepared.binding.projectId ||
      binding.workspaceId !== prepared.binding.workspaceId ||
      binding.executionId !== prepared.binding.executionId ||
      binding.verificationId !== prepared.binding.verificationId ||
      binding.workId !== prepared.binding.workId ||
      blobRefDigest(inputManifestRef) === undefined ||
      blobRefDigest(qualificationRef) === undefined
    )
      return undefined;
    if (
      decodeCanonicalVerificationSandboxBindingV1(
        encodeVerificationSandboxBindingV1(binding),
      ) === undefined
    )
      return undefined;
    if (!(yield* prepared.revalidate())) return undefined;

    const blobMatches = (ref: `blob:sha256:${string}`) => {
      const digest = blobRefDigest(ref);
      if (digest === undefined) return Effect.succeed(false);
      return input.blobs.get(digest).pipe(
        Effect.match({
          onFailure: () => false,
          onSuccess: (bytes) =>
            sha256Hex(new TextDecoder().decode(bytes)) === digest,
        }),
      );
    };
    if (
      !(yield* blobMatches(inputManifestRef)) ||
      !(yield* blobMatches(qualificationRef))
    )
      return undefined;

    if (
      prepared.mounts.length === 0 ||
      prepared.mounts.length !== prepared.sources.length ||
      prepared.mounts.some((mount) => mount.access !== "ReadWrite") ||
      new Set(prepared.mounts.map((mount) => mount.ref)).size !==
        prepared.mounts.length
    )
      return undefined;
    let runtimeRoot: string;
    try {
      runtimeRoot = realpathSync.native(prepared.runtimeDirectory);
    } catch {
      return undefined;
    }
    const admittedMounts: Array<{
      readonly ref: string;
      readonly rootPath: string;
      readonly access: "ReadWrite";
    }> = [];
    const mountRoots = new Set<string>();
    for (const mount of prepared.mounts) {
      let rootPath: string;
      try {
        rootPath = realpathSync.native(mount.address.path);
      } catch {
        return undefined;
      }
      if (
        !contained(runtimeRoot, rootPath) ||
        rootPath === runtimeRoot ||
        mountRoots.has(rootPath)
      )
        return undefined;
      mountRoots.add(rootPath);
      admittedMounts.push({ ref: mount.ref, rootPath, access: "ReadWrite" });
    }
    const rule = sandboxEnforcementRuleSetV2ForProvider(
      prepared.providerCandidate.providerId,
    );
    if (rule === undefined) return undefined;
    const enforcementRuleSetDigest = sha256Hex(
      encodeSandboxEnforcementRuleSetV2(rule),
    );
    if (
      prepared.providerCandidate.tuple.enforcementRuleSetDigest !==
        enforcementRuleSetDigest ||
      prepared.providerCandidate.tuple.profile !== "WorkspaceWrite" ||
      prepared.providerCandidate.tuple.networkMode !==
        prepared.networkPolicy.mode ||
      prepared.providerCandidate.tuple.networkPolicyCodecVersion !== 1
    )
      return undefined;
    if (
      !environmentAllowlist.every((name) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name),
      ) ||
      new Set(environmentAllowlist).size !== environmentAllowlist.length ||
      !Object.values(limits).every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    )
      return undefined;
    const networkBrokerControls = networkBrokerControlsV2ForMode(
      prepared.networkPolicy.mode,
    );
    const policyDigest = sha256Hex(
      JSON.stringify({
        version: 1,
        kind: "IndependentVerificationProcessPolicyV1",
        binding,
        admittedMounts,
        environmentAllowlist,
        limits,
        provider: {
          providerId: prepared.providerCandidate.providerId,
          providerVersion: prepared.providerCandidate.providerVersion,
          capabilityRevision: String(
            prepared.providerCandidate.capabilityRevision,
          ),
          enforcementRuleSetDigest,
          qualificationEvidenceRef: providerQualificationRef,
        },
        networkPolicy: encodeNetworkPolicyV1(prepared.networkPolicy),
        networkBrokerControls,
        verificationMountQualificationEvidenceRef: qualificationRef,
      }),
    );
    const policy = {
      kind: "IndependentVerificationProcessPolicyV1" as const,
      executionId: binding.executionId,
      sandboxHandleId: `sbx_${binding.executionId}`,
      policyRevision: binding.policyRevision,
      expiresAt: binding.expiresAt,
      policyDigest,
      workspaceAuthorizationRevision: binding.authorizationRevision,
      admittedMounts,
      environmentAllowlist,
      limits,
      auditRefs: [
        inputManifestRef,
        qualificationRef,
        providerQualificationRef,
      ].sort(compareUtf8BytesV1),
      profile: "WorkspaceWrite" as const,
      providerId: "linux-bwrap" as const,
      providerVersion: prepared.providerCandidate.providerVersion,
      capabilityRevision: String(prepared.providerCandidate.capabilityRevision),
      enforcementRuleSetDigest,
      qualificationEvidenceRef: providerQualificationRef,
      boundary: "OsEnforced" as const,
      networkPolicy: prepared.networkPolicy,
      networkBrokerControls,
      verificationBinding: binding,
      verificationMountQualificationEvidenceRef: qualificationRef,
    };
    return { policy, mounts: prepared.mounts };
  });

/** Rebuilds process-local paths from the current P11 source rows. Nothing from
 * this value is persisted or exposed through a public view. */
export const materializeCurrentSandboxProcessPolicy = (input: {
  readonly projectId: import("@arbor/domain").ProjectId;
  readonly workspaceId: import("@arbor/domain").WorkspaceId;
  readonly executionId: import("@arbor/domain").ExecutionId;
  readonly now: string;
  readonly source: TrustedHostConfigurationSourceService | undefined;
}) =>
  Effect.gen(function* () {
    const transaction = yield* TransactionPort;
    const workspaces = yield* WorkspaceRepository;
    const executions = yield* ExecutionRepository;
    const decisions = yield* SandboxPolicyDecisionStore;
    const authorizations = yield* Effect.serviceOption(
      WorkspaceSandboxAuthorizationStore,
    );
    const ownership = yield* ResourceOwnershipRepository;
    const worktrees = yield* WorktreeStore;
    const resolver = yield* EnvironmentResolverPort;
    const authority =
      input.source === undefined
        ? { _tag: "Unavailable" as const, failure: "SourceMissing" as const }
        : yield* loadSandboxAuthorityBundleSnapshotCurrent(
            input.source,
            input.now,
            SANDBOX_ENV_ALLOWLIST,
          );
    if (authority._tag !== "Available") return undefined;

    const rows = yield* transaction
      .transact(
        Effect.gen(function* () {
          const workspace = yield* workspaces.findById(input.workspaceId);
          const execution = yield* executions.findById(input.executionId);
          const episodeRevision = yield* executions.findEpisodeRevision(
            input.executionId,
          );
          const current = yield* decisions.findCurrentForExecution(
            input.projectId,
            input.workspaceId,
            input.executionId,
          );
          const workspaceAuthorityCurrent =
            Option.isNone(current) ||
            current.value.decision.authorityKind !== "WorkspaceAuthorization"
              ? true
              : Option.isNone(authorizations)
                ? false
                : yield* workspaceSandboxPolicyBindingIsAuthorized(
                    { workspaces, authorizations: authorizations.value },
                    {
                      ...current.value,
                      now: input.now,
                    },
                  );
          const claims = yield* ownership.listActiveByWorkspace(
            input.workspaceId,
          );
          const worktreeRows = yield* worktrees.findByWorkspace(
            input.workspaceId,
          );
          return {
            workspace,
            execution,
            episodeRevision,
            current,
            workspaceAuthorityCurrent,
            claims,
            worktreeRows,
          };
        }),
      )
      .pipe(Effect.option);
    if (Option.isNone(rows)) return undefined;
    const {
      workspace: workspaceOption,
      execution: executionOption,
      episodeRevision,
      current,
      claims,
      worktreeRows,
    } = rows.value;
    if (
      !rows.value.workspaceAuthorityCurrent ||
      Option.isNone(workspaceOption) ||
      Option.isNone(executionOption) ||
      Option.isNone(episodeRevision) ||
      Option.isNone(current)
    )
      return undefined;
    const workspace = workspaceOption.value;
    const execution = executionOption.value;
    const committed = current.value;
    const result = committed.result;
    const summary = result.effectivePolicySnapshot;
    const currentEpisode = executionEpisode(execution);
    const bundle = authority.snapshot.bundle;
    if (
      workspace.lifecycle !== "Active" ||
      execution.state.status !== "Active" ||
      execution.stopRequestedAt !== null ||
      execution.projectId !== input.projectId ||
      execution.workspaceId !== input.workspaceId ||
      execution.executionId !== input.executionId ||
      currentEpisode === undefined ||
      encodeExecutionEpisodeBinding(committed.decision.episodeBinding) !==
        encodeExecutionEpisodeBinding(currentEpisode) ||
      committed.decision.expectedExecutionRevision !== episodeRevision.value ||
      result.executionId !== input.executionId ||
      result.workspaceId !== input.workspaceId ||
      result.projectId !== input.projectId ||
      result.policyRevision !== committed.decision.policyRevision ||
      result.policyDigest !== committed.decision.policyDigest ||
      result.policyRevision !== committed.decision.expectedPolicyRevision + 1 ||
      result.effectivePolicySnapshot.workspaceRevision !== workspace.revision ||
      result.effectivePolicySnapshot.resourceBoundaryRevision !==
        workspace.resourceBoundaryRevision ||
      result.effectivePolicySnapshot.authorityBundleRevision !==
        bundle.bundleRevision ||
      result.effectivePolicySnapshot.authorityBundleDigest !==
        authority.snapshot.bundleDigest ||
      result.effectivePolicySnapshot.operatorConfigRevision !==
        bundle.operatorConfigRevision ||
      result.effectivePolicySnapshot.operatorConfigDigest !==
        bundle.operatorConfigDigest ||
      Date.parse(result.effectivePolicySnapshot.expiresAt) <=
        Date.parse(input.now)
    )
      return undefined;

    if (
      summary.kind === "OsEnforced" &&
      summary.providerId ===
        WINDOWS_SANDBOX_PROVIDER_IDS.restrictedAppContainerJob
    ) {
      const inspection = yield* inspectWindowsQualificationAtP4Admission({
        source: input.source,
        now: input.now,
        summary,
      });
      if (inspection._tag !== "ManifestVerified") return undefined;
    }

    let supportedOsProviderEntry:
      | SandboxProviderQualificationEntryV1
      | undefined;
    if (summary.kind === "OsEnforced") {
      const supportedEntry =
        summary.version === 2
          ? exactSupportedOsProviderEntryV2(
              bundle.providerRegistry.entries,
              summary,
            )
          : exactSupportedOsProviderEntry(
              bundle.providerRegistry.entries,
              summary,
            );
      if (
        supportedEntry === undefined ||
        summary.providerRegistryRevision !== bundle.providerRegistryRevision ||
        summary.providerRegistryDigest !== bundle.providerRegistryDigest ||
        committed.decision.providerId !== summary.providerId ||
        committed.decision.profile !== summary.profile ||
        committed.decision.networkPolicy.kind !== "OsEnforced" ||
        JSON.stringify(committed.decision.networkPolicy.policy) !==
          JSON.stringify(summary.networkPolicy) ||
        summary.networkPolicyDigest !==
          sha256Hex(encodeNetworkPolicyV1(summary.networkPolicy)) ||
        supportedEntry.qualificationEvidenceRef === null
      )
        return undefined;
      supportedOsProviderEntry = supportedEntry;
    } else if (
      summary.trustedRuntimeIdentity !== "TrustedLocal" ||
      summary.trustedRuntimeVersion !== "builtin-v1" ||
      summary.profile !== "FullAccess" ||
      summary.networkBoundary !== "Unconfined" ||
      committed.decision.providerId !== "TrustedLocal" ||
      committed.decision.profile !== "FullAccess" ||
      committed.decision.networkPolicy.kind !== "TrustedLocalUnconfinedV1" ||
      committed.decision.networkPolicy.version !== 1
    ) {
      return undefined;
    }

    const activeWorktrees = worktreeRows.filter(
      (record) => record.state === "Active",
    );
    if (activeWorktrees.length > 1) return undefined;
    const worktree = activeWorktrees[0];
    let primaryAddress: PrimaryResourceAddress | undefined = worktree?.address;
    if (
      worktree !== undefined &&
      (worktree.projectId !== input.projectId ||
        worktree.workspaceId !== input.workspaceId)
    )
      return undefined;
    if (primaryAddress === undefined) {
      const fileTrees = workspace.resourceBoundary.addresses.filter(
        (address): address is Extract<ResourceAddress, { _tag: "FileTree" }> =>
          address._tag === "FileTree" && address.path.length > 0,
      );
      if (fileTrees.length !== 1) return undefined;
      primaryAddress = fileTrees[0];
    }
    if (primaryAddress === undefined) return undefined;
    const observation = yield* resolver
      .observe(workspace.projectId, workspace.resourceBoundary.addresses)
      .pipe(Effect.option);
    const primaryObservation = yield* resolver
      .observe(workspace.projectId, [primaryAddress])
      .pipe(Effect.option);
    if (Option.isNone(observation) || Option.isNone(primaryObservation))
      return undefined;
    const observed = observation.value;
    const primary = primaryObservation.value;
    const canonicalSet = (
      regions: ReadonlyArray<import("@arbor/domain").CanonicalResourceRegion>,
    ) =>
      [...new Set(regions.map(canonicalRegionString))].sort(compareUtf8BytesV1);
    if (
      canonicalSet(observed.entries.map((entry) => entry.resolved)).join(
        "\n",
      ) !== canonicalSet(observed.changedRegions).join("\n") ||
      canonicalSet(primary.entries.map((entry) => entry.resolved)).join(
        "\n",
      ) !== canonicalSet(primary.changedRegions).join("\n") ||
      primary.entries.length !== 1
    )
      return undefined;
    const primaryRegion = primary.entries[0]?.resolved;
    if (primaryRegion === undefined) return undefined;
    const boundary = produceSandboxBoundaryV1(
      {
        workspaceId: input.workspaceId,
        resourceBoundaryRevision: workspace.resourceBoundaryRevision,
        responsibilityRevision: workspace.responsibilityRevision,
        boundary: workspace.resourceBoundary,
        resolvedRegions: observed.entries.map((entry) => entry.resolved),
        primaryResourceRegion: primaryRegion,
        ownershipClaims: claims,
        policyKind: summary.kind,
        profile: summary.profile,
      },
      sha256Hex,
    );
    if (
      boundary === undefined ||
      boundary.resourceBoundaryDigest !== summary.resourceBoundaryDigest ||
      boundary.sandboxHandleBindingDigest !==
        summary.sandboxHandleBindingDigest ||
      JSON.stringify(boundary.mounts) !== JSON.stringify(summary.mounts)
    )
      return undefined;
    const targetToEntry = new Map<string, (typeof observed.entries)[number]>();
    for (const entry of observed.entries) {
      const target = sandboxTargetRefOfRegionV1(entry.resolved, sha256Hex);
      if (target === undefined) return undefined;
      const key = `${target.resourceSpace}:${target.regionIdentityDigest}`;
      const prior = targetToEntry.get(key);
      if (
        prior !== undefined &&
        canonicalRegionString(prior.resolved) !==
          canonicalRegionString(entry.resolved)
      )
        return undefined;
      targetToEntry.set(key, entry);
    }
    const mounts: SandboxMountBinding[] = [];
    const admittedMounts = [] as Array<{
      ref: string;
      rootPath: string;
      access: "ReadOnly" | "ReadWrite";
    }>;
    for (const mount of summary.mounts) {
      const key = `${mount.targetRef.resourceSpace}:${mount.targetRef.regionIdentityDigest}`;
      const entry = targetToEntry.get(key);
      if (
        entry === undefined ||
        mount.targetRef.resourceSpace !== "filesystem" ||
        (entry.address._tag !== "FileTree" &&
          entry.address._tag !== "GitWorktree")
      )
        return undefined;
      let rootPath: string;
      try {
        rootPath = realpathSync(entry.address.path);
      } catch {
        return undefined;
      }
      mounts.push({
        ref: mount.mountId,
        address: entry.address,
        region: entry.resolved,
        access: mount.access,
      });
      admittedMounts.push({
        ref: mount.mountId,
        rootPath,
        access: mount.access,
      });
    }
    if (
      mounts.length !== summary.mounts.length ||
      !mounts.some((mount) => mount.ref === "workspace")
    )
      return undefined;
    const limits = bundle.operatorConfig.limitsByProfile.find(
      (entry) => entry.profile === summary.profile,
    )?.limits;
    if (limits === undefined) return undefined;
    const expectedBasis =
      summary.kind === "OsEnforced"
        ? sandboxEnvironmentBasisDigestOfV1(
            {
              version: 1,
              kind: "OsEnforced",
              workspaceId: input.workspaceId,
              resourceBoundaryRevision: boundary.resourceBoundaryRevision,
              mounts: boundary.mounts,
              environmentAllowlist: bundle.operatorConfig.environmentAllowlist,
              limits,
              authorityBundleRevision: bundle.bundleRevision,
              authorityBundleDigest: authority.snapshot.bundleDigest,
              providerRegistryRevision: bundle.providerRegistryRevision,
              providerRegistryDigest: bundle.providerRegistryDigest,
              qualificationEvidenceRef: summary.qualificationEvidenceRef,
            },
            sha256Hex,
          )
        : sandboxEnvironmentBasisDigestOfV1(
            {
              version: 1,
              kind: "TrustedLocalUnconfinedV1",
              workspaceId: input.workspaceId,
              resourceBoundaryRevision: boundary.resourceBoundaryRevision,
              mounts: boundary.mounts,
              environmentAllowlist: bundle.operatorConfig.environmentAllowlist,
              limits,
              authorityBundleRevision: bundle.bundleRevision,
              authorityBundleDigest: authority.snapshot.bundleDigest,
              operatorConfigRevision: bundle.operatorConfigRevision,
              operatorConfigDigest: bundle.operatorConfigDigest,
              trustedRuntimeVersion: "builtin-v1",
            },
            sha256Hex,
          );
    if (expectedBasis !== summary.sandboxEnvironmentBasisDigest)
      return undefined;
    const osProviderBinding =
      summary.kind === "OsEnforced" &&
      supportedOsProviderEntry !== undefined &&
      supportedOsProviderEntry.qualificationEvidenceRef !== null
        ? {
            enforcementRuleSetDigest:
              supportedOsProviderEntry.tuple.enforcementRuleSetDigest,
            qualificationEvidenceRef:
              supportedOsProviderEntry.qualificationEvidenceRef,
          }
        : undefined;
    if (summary.kind === "OsEnforced" && osProviderBinding === undefined)
      return undefined;
    const commonPolicy = {
      executionId: input.executionId,
      episodeBinding: currentEpisode,
      sandboxHandleId: `sbx_${input.executionId}`,
      policyRevision: result.policyRevision,
      expiresAt: summary.expiresAt,
      policyDigest: result.policyDigest,
      ...(result.version === 3
        ? {
            workspaceAuthorizationRevision:
              result.workspaceAuthorizationRevision,
          }
        : {}),
      admittedMounts,
      environmentAllowlist: summary.environmentAllowlist,
      limits: summary.limits,
      auditRefs: summary.auditRefs,
    };
    const policy: SandboxProcessPolicy | undefined =
      summary.kind === "OsEnforced"
        ? osProviderBinding === undefined
          ? undefined
          : summary.version === 2
            ? {
                ...commonPolicy,
                ...osProviderBinding,
                kind: "OsEnforcedProcessPolicyV2" as const,
                profile: summary.profile,
                providerId: summary.providerId,
                providerVersion: summary.providerVersion,
                capabilityRevision: String(summary.capabilityRevision),
                boundary: "OsEnforced" as const,
                networkPolicy: summary.networkPolicy,
                networkBrokerControls: summary.networkBrokerControls,
              }
            : {
                ...commonPolicy,
                ...osProviderBinding,
                kind: "OsEnforcedProcessPolicy",
                profile: summary.profile,
                providerId: summary.providerId,
                providerVersion: summary.providerVersion,
                capabilityRevision: String(summary.capabilityRevision),
                boundary: "OsEnforced",
                networkPolicy: summary.networkPolicy,
              }
        : {
            ...commonPolicy,
            kind: "TrustedLocalUnconfinedRuntimePolicy",
            profile: "FullAccess",
            providerId: "TrustedLocal",
            providerVersion: "builtin-v1",
            capabilityRevision: "builtin-v1",
            boundary: "TrustedLocal",
            trustedRuntimeIdentity: "TrustedLocal",
            trustedRuntimeVersion: "builtin-v1",
            networkBoundary: "Unconfined",
          };
    if (policy === undefined) return undefined;
    return {
      policy,
      mounts,
    };
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));

export class SandboxProcessPolicyMaterializer extends Context.Service<
  SandboxProcessPolicyMaterializer,
  typeof materializeCurrentSandboxProcessPolicy
>()("arbor/SandboxProcessPolicyMaterializer") {}
