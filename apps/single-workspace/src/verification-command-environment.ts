import { lstat, realpath } from "node:fs/promises";
import { loadWorkspaceSandboxAuthorizationSnapshot } from "@arbor/application";
import {
  type CanonicalResourceRegion,
  canonicalRegionString,
  type ExecutionId,
  encodeNetworkPolicyV1,
  encodeSandboxEnforcementRuleSetV2,
  encodeWorkspaceSandboxAuthorization,
  isIsoTimestamp,
  type NetworkPolicyV1,
  produceSandboxBoundaryV1,
  resolveWorkspaceSandboxAuthorization,
  type SandboxLinuxQualificationProfileV2,
  type SandboxPolicyLimitsV1,
  type SandboxProviderQualificationEntryV1,
  sandboxEnforcementRuleSetV2ForProvider,
  sandboxTargetRefOfRegionV1,
  type VerificationSandboxBindingV1,
} from "@arbor/domain";
import {
  type BlobStorePortService,
  type ClockService,
  type CurrentSandboxAuthoritySnapshotPortService,
  type ExecutionRepositoryService,
  type SandboxMountBinding,
  type SandboxPolicyCandidateBoundaryReadPortService,
  sha256Hex,
  type TransactionPortService,
  type VerificationRepositoryService,
  type WorkRepositoryService,
  type WorkspaceRepositoryService,
  type WorkspaceSandboxAuthorizationStoreService,
} from "@arbor/ports";
import {
  createVerificationInputCopy,
  type VerificationInputBinding,
  type VerificationInputCopy,
} from "@arbor/sandbox-local";
import { Effect, Option } from "effect";

export interface VerificationCommandEnvironmentDependencies {
  readonly transaction: TransactionPortService;
  readonly clock: Pick<ClockService, "now">;
  readonly executions: Pick<ExecutionRepositoryService, "findById">;
  readonly works: Pick<WorkRepositoryService, "findById">;
  readonly verifications: Pick<
    VerificationRepositoryService,
    "findByExecutionId"
  >;
  readonly workspaces: Pick<WorkspaceRepositoryService, "findById">;
  readonly authorizations: Pick<
    WorkspaceSandboxAuthorizationStoreService,
    "findCurrent"
  >;
  readonly boundary: SandboxPolicyCandidateBoundaryReadPortService;
  readonly currentHost: CurrentSandboxAuthoritySnapshotPortService;
  /** Durable content-addressed store used for the exact captured input. */
  readonly blobs?: BlobStorePortService;
  /** Protected runtime-owned directory; never supplied by the model. */
  readonly runtimeDirectory: string;
}

export interface PreparedVerificationCommandEnvironment {
  /** The input-copy binding consumed by the local copy adapter. */
  readonly binding: VerificationInputBinding;
  /** Present only when production supplied a durable BlobStore. */
  readonly verificationBinding?: VerificationSandboxBindingV1;
  readonly sources: ReadonlyArray<SandboxMountBinding>;
  readonly mounts: ReadonlyArray<SandboxMountBinding>;
  readonly inputManifestJson: string;
  readonly inputDigest: string;
  readonly inputManifestRef?: `blob:sha256:${string}`;
  readonly verificationMountQualificationEvidenceRef?: `blob:sha256:${string}`;
  readonly basisDigest: string;
  readonly authorizationRevision: number;
  readonly networkPolicy: NetworkPolicyV1;
  readonly providerCandidate: SandboxProviderQualificationEntryV1;
  readonly limits?: SandboxPolicyLimitsV1;
  readonly environmentAllowlist?: ReadonlyArray<string>;
  readonly runtimeDirectory: string;
  readonly revalidate: () => Effect.Effect<boolean>;
  readonly dispose: () => Effect.Effect<void>;
}

export type VerificationCommandEnvironmentFailure =
  | "ExecutionUnavailable"
  | "VerificationUnavailable"
  | "WorkVersionUnavailable"
  | "AuthorizationUnavailable"
  | "SourceBoundaryUnavailable"
  | "HostUnavailable"
  | "SourceChanged"
  | "PreparationFailed";

export class VerificationCommandEnvironmentError extends Error {
  constructor(readonly code: VerificationCommandEnvironmentFailure) {
    super(`Verification command environment: ${code}`);
    this.name = "VerificationCommandEnvironmentError";
  }
}

const rejected = (code: VerificationCommandEnvironmentFailure) =>
  Effect.fail(new VerificationCommandEnvironmentError(code));

const verificationPolicyTtlMs = 15 * 60 * 1000;

const uuidV7Shape = (digest: string): string =>
  [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `7${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");

const fileTreeRegion = (
  region: CanonicalResourceRegion | undefined,
):
  | { readonly kind: "FileTree" | "GitWorktree"; readonly path: string }
  | undefined => {
  if (region === undefined || region.resourceSpaceId !== "filesystem")
    return undefined;
  try {
    const value = JSON.parse(canonicalRegionString(region)) as Record<
      string,
      unknown
    >;
    return (value.kind === "FileTree" || value.kind === "GitWorktree") &&
      typeof value.path === "string"
      ? { kind: value.kind, path: value.path }
      : undefined;
  } catch {
    return undefined;
  }
};

/** Prepares input only. No policy decision, approval, Supported qualification
 * or process invocation is created by this component. A P4 consumer still has
 * to bind and qualify these exact temporary mounts before execution. */
export const makeVerificationCommandEnvironmentPreparation = (
  dependencies: VerificationCommandEnvironmentDependencies,
) => {
  const readCurrent = (executionId: ExecutionId) =>
    Effect.gen(function* () {
      const now = yield* dependencies.clock.now();
      if (!isIsoTimestamp(now)) return yield* rejected("PreparationFailed");
      const host = yield* dependencies.currentHost.loadCurrentVerifiedV2();
      if (host._tag !== "Available" || host.currentHost.osFamily !== "Linux") {
        return yield* rejected("HostUnavailable");
      }
      return yield* dependencies.transaction.transact(
        Effect.gen(function* () {
          const execution =
            yield* dependencies.executions.findById(executionId);
          if (
            Option.isNone(execution) ||
            execution.value.executionId !== executionId ||
            execution.value.state.status !== "Active" ||
            execution.value.stopRequestedAt !== null ||
            execution.value.binding._tag !== "ExecutionBoundAgentBinding" ||
            execution.value.binding.parentExecutionId !== null
          )
            return yield* rejected("ExecutionUnavailable");
          const target = execution.value;
          const verification =
            yield* dependencies.verifications.findByExecutionId(executionId);
          if (
            Option.isNone(verification) ||
            verification.value.state.status !== "Open" ||
            verification.value.ownerWorkspaceId !== target.workspaceId ||
            !verification.value.verificationExecutionIds.includes(executionId)
          )
            return yield* rejected("VerificationUnavailable");
          const work = yield* dependencies.works.findById(
            verification.value.workId,
          );
          if (
            Option.isNone(work) ||
            work.value.workId !== verification.value.workId ||
            work.value.projectId !== target.projectId ||
            work.value.workspaceId !== target.workspaceId ||
            work.value.lifecycle !== "Open" ||
            work.value.revision !== verification.value.targetWorkRevision
          )
            return yield* rejected("WorkVersionUnavailable");
          const snapshot = yield* loadWorkspaceSandboxAuthorizationSnapshot(
            dependencies,
            target.projectId,
            target.workspaceId,
          );
          const authorization = resolveWorkspaceSandboxAuthorization({
            ...snapshot,
            projectId: target.projectId,
            workspaceId: target.workspaceId,
            now,
          });
          if (authorization._tag !== "Authorized") {
            return yield* rejected("AuthorizationUnavailable");
          }
          const boundary = yield* dependencies.boundary.readCurrentForWorkspace(
            {
              projectId: target.projectId,
              workspaceId: target.workspaceId,
            },
          );
          const workspace = boundary.workspace;
          if (
            workspace.projectId !== target.projectId ||
            workspace.workspaceId !== target.workspaceId ||
            workspace.lifecycle !== "Active" ||
            workspace.resourceBoundaryRevision !==
              authorization.authorization.resourceBoundaryRevision ||
            workspace.workspacePolicyRevision !==
              authorization.authorization.workspacePolicyRevision ||
            // Until a segmented capture exists, a broad tree containing a
            // delegated exclusion cannot be copied as a fully admitted root.
            boundary.ownershipClaims.some(
              (claim) =>
                claim.releasedAt === null &&
                (claim.exclusions?.length ?? 0) > 0,
            )
          )
            return yield* rejected("SourceBoundaryUnavailable");
          const sourceBoundary = produceSandboxBoundaryV1(
            {
              workspaceId: target.workspaceId,
              resourceBoundaryRevision: workspace.resourceBoundaryRevision,
              responsibilityRevision: workspace.responsibilityRevision,
              boundary: workspace.resourceBoundary,
              resolvedRegions: boundary.resolvedRegions,
              primaryResourceRegion: boundary.primaryResourceRegion,
              ownershipClaims: boundary.ownershipClaims,
              policyKind: "OsEnforced",
              profile: "ReadOnly",
            },
            sha256Hex,
          );
          if (
            sourceBoundary === undefined ||
            sourceBoundary.mounts.length === 0
          ) {
            return yield* rejected("SourceBoundaryUnavailable");
          }
          const primaryTargetRef = sandboxTargetRefOfRegionV1(
            boundary.primaryResourceRegion,
            sha256Hex,
          );
          if (primaryTargetRef === undefined) {
            return yield* rejected("SourceBoundaryUnavailable");
          }
          const sources: SandboxMountBinding[] = [];
          for (const mount of sourceBoundary.mounts) {
            const region = boundary.resolvedRegions.find(
              (region) =>
                sha256Hex(canonicalRegionString(region)) ===
                mount.targetRef.regionIdentityDigest,
            );
            const normalized = fileTreeRegion(region);
            if (
              region === undefined ||
              normalized === undefined ||
              (normalized.kind !== "FileTree" &&
                normalized.kind !== "GitWorktree")
            )
              return yield* rejected("SourceBoundaryUnavailable");
            const addresses = workspace.resourceBoundary.addresses.filter(
              (address) =>
                (address._tag === "FileTree" ||
                  address._tag === "GitWorktree") &&
                address._tag === normalized.kind &&
                address.path === normalized.path,
            );
            const address = addresses[0];
            if (
              addresses.length !== 1 ||
              address === undefined ||
              (address._tag !== "FileTree" && address._tag !== "GitWorktree")
            )
              return yield* rejected("SourceBoundaryUnavailable");
            // The process tool contract reserves `workspace` for the
            // primary admitted project directory.  Boundary production uses
            // an opaque `resource-*` mount id for an ordinary FileTree (only
            // a managed GitWorktree naturally gets `workspace`).  A
            // Verifier always runs against a captured copy, so normalize the
            // captured primary mount to the same stable ref that shell cwd
            // and the native process adapter require.  Secondary admitted
            // regions retain their opaque refs.
            sources.push({
              ref:
                mount.targetRef.regionIdentityDigest ===
                primaryTargetRef.regionIdentityDigest
                  ? "workspace"
                  : mount.mountId,
              address,
              region,
              access: "ReadOnly",
            });
          }
          const grant = authorization.authorization;
          const rule = sandboxEnforcementRuleSetV2ForProvider(grant.providerId);
          if (rule === undefined || grant.providerId !== "linux-bwrap") {
            return yield* rejected("HostUnavailable");
          }
          const rulesDigest = sha256Hex(
            encodeSandboxEnforcementRuleSetV2(rule),
          );
          // Temporary command output requires a writable copy even when the
          // source is read-only. This is a candidate tuple, not proof that the
          // new verification mount/binding combination has been qualified.
          const entries = host.snapshot.bundle.providerRegistry.entries.filter(
            (entry) =>
              entry.status === "Supported" &&
              entry.providerId === grant.providerId &&
              entry.osFamily === "Linux" &&
              entry.osBuild === host.currentHost.osBuild &&
              entry.tuple.profile === "WorkspaceWrite" &&
              entry.tuple.networkMode === grant.networkPolicy.mode &&
              entry.tuple.networkPolicyCodecVersion === 1 &&
              entry.tuple.enforcementRuleSetDigest === rulesDigest &&
              entry.qualificationEvidenceRef !== null,
          );
          if (entries.length !== 1 || entries[0] === undefined) {
            return yield* rejected("HostUnavailable");
          }
          const binding: VerificationInputBinding = {
            verificationId: verification.value.verificationId,
            executionId,
            projectId: target.projectId,
            workspaceId: target.workspaceId,
            workId: work.value.workId,
            targetWorkRevision: verification.value.targetWorkRevision,
          };
          const basisJson = JSON.stringify({
            version: 1,
            kind: "IndependentVerificationPreparation",
            binding,
            mission: verification.value.missionSnapshot,
            workspaceRevision: workspace.revision,
            resourceBoundaryRevision: workspace.resourceBoundaryRevision,
            workspacePolicyRevision: workspace.workspacePolicyRevision,
            sourceBoundary,
            // Include complete current provenance, not just the Child head.
            lineage: snapshot.workspaces.map((workspace) => ({
              workspaceId: workspace.workspaceId,
              parentWorkspaceId: workspace.parentWorkspaceId,
              lifecycle: workspace.lifecycle,
              resourceBoundaryRevision: workspace.resourceBoundaryRevision,
              workspacePolicyRevision: workspace.workspacePolicyRevision,
            })),
            grants: snapshot.heads.map(encodeWorkspaceSandboxAuthorization),
            ownership: boundary.ownershipClaims,
            sources,
            host: {
              osBuild: host.currentHost.osBuild,
              authorityRevision: host.snapshot.bundle.bundleRevision,
              authorityDigest: host.snapshot.bundleDigest,
              operatorRevision: host.snapshot.bundle.operatorConfigRevision,
              operatorDigest: host.snapshot.bundle.operatorConfigDigest,
              registryRevision: host.snapshot.bundle.providerRegistryRevision,
              registryDigest: host.snapshot.bundle.providerRegistryDigest,
            },
            providerCandidate: entries[0],
          });
          const limits =
            host.snapshot.bundle.operatorConfig?.limitsByProfile.find(
              (entry) => entry.profile === "WorkspaceWrite",
            )?.limits;
          return {
            binding,
            sources,
            basisDigest: sha256Hex(basisJson),
            authorizationRevision: grant.authorizationRevision,
            networkPolicy: grant.networkPolicy,
            providerCandidate: entries[0],
            issuedAt: now,
            hostBuild: host.currentHost.osBuild,
            workspacePolicyRevision: workspace.workspacePolicyRevision,
            runtimeDirectory: dependencies.runtimeDirectory,
            ...(host.snapshot.bundle.operatorConfig?.environmentAllowlist ===
            undefined
              ? {}
              : {
                  environmentAllowlist:
                    host.snapshot.bundle.operatorConfig.environmentAllowlist,
                }),
            ...(limits === undefined ? {} : { limits }),
          };
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof VerificationCommandEnvironmentError
          ? cause
          : new VerificationCommandEnvironmentError("PreparationFailed"),
      ),
    );

  const prepare = (executionId: ExecutionId, signal?: AbortSignal) =>
    Effect.suspend(() => {
      const copies: VerificationInputCopy[] = [];
      return Effect.gen(function* () {
        const before = yield* readCurrent(executionId);
        const sourceIdentities: string[] = [];
        const roots = new Set<string>();
        for (const source of before.sources) {
          const root = yield* Effect.tryPromise(() =>
            realpath(source.address.path),
          );
          if (root !== source.address.path || roots.has(root)) {
            return yield* rejected("SourceBoundaryUnavailable");
          }
          roots.add(root);
          const stat = yield* Effect.tryPromise(() =>
            lstat(root, { bigint: true }),
          );
          sourceIdentities.push(`${stat.dev}:${stat.ino}`);
          // Cancellation must join the actual capture's cleanup, not leave
          // a promise copying files after the Effect fiber has stopped.
          yield* Effect.uninterruptibleMask((restore) =>
            Effect.suspend(() => {
              const controller = new AbortController();
              const pending = createVerificationInputCopy({
                sourceDirectory: root,
                runtimeDirectory: dependencies.runtimeDirectory,
                binding: before.binding,
                signal:
                  signal === undefined
                    ? controller.signal
                    : AbortSignal.any([signal, controller.signal]),
              });
              return restore(Effect.tryPromise(() => pending)).pipe(
                Effect.tap((copy) =>
                  Effect.sync(() => {
                    copies.push(copy);
                  }),
                ),
                Effect.onInterrupt(() =>
                  Effect.promise(async () => {
                    controller.abort();
                    await pending.then(
                      (copy) => copy.dispose(),
                      () => undefined,
                    );
                  }),
                ),
              );
            }),
          );
        }
        for (const copy of copies) {
          if (!(yield* Effect.tryPromise(() => copy.sourceIsCurrent()))) {
            return yield* rejected("SourceChanged");
          }
        }
        const after = yield* readCurrent(executionId);
        if (before.basisDigest !== after.basisDigest) {
          return yield* rejected("SourceChanged");
        }
        const mounts: SandboxMountBinding[] = before.sources.map(
          (source, index) => ({
            ref: source.ref,
            address: {
              _tag: "FileTree",
              path: (copies[index] as VerificationInputCopy).rootPath,
            },
            region: source.region,
            access: "ReadWrite",
          }),
        );
        const inputManifestJson = JSON.stringify({
          version: 1,
          kind: "IndependentVerificationMountInputs",
          binding: before.binding,
          basisDigest: before.basisDigest,
          mounts: copies.map((copy, index) => ({
            ref: before.sources[index]?.ref,
            inputDigest: copy.inputDigest,
            manifest: JSON.parse(copy.manifestJson) as unknown,
          })),
        });
        const inputDigest = sha256Hex(inputManifestJson);
        const copySetId = `vcp_${uuidV7Shape(
          sha256Hex(`${before.binding.executionId}:${inputDigest}`),
        )}`;
        const issuedAt = before.issuedAt;
        const expiresAt = new Date(
          Date.parse(issuedAt) + verificationPolicyTtlMs,
        ).toISOString();
        let inputManifestRef: `blob:sha256:${string}` | undefined;
        let verificationMountQualificationEvidenceRef:
          | `blob:sha256:${string}`
          | undefined;
        let verificationBinding: VerificationSandboxBindingV1 | undefined;
        if (dependencies.blobs !== undefined) {
          const inputBlob = yield* dependencies.blobs.put(
            new TextEncoder().encode(inputManifestJson),
          );
          inputManifestRef = `blob:sha256:${inputBlob}`;
          verificationBinding = {
            version: 1,
            kind: "IndependentVerification",
            projectId: before.binding.projectId,
            workspaceId: before.binding.workspaceId,
            executionId: before.binding.executionId,
            verificationId: before.binding.verificationId,
            workId: before.binding.workId,
            targetWorkRevision: before.binding.targetWorkRevision,
            copySetId,
            authorizationRevision: before.authorizationRevision,
            sourceBasisDigest: before.basisDigest,
            inputDigest,
            inputManifestRef,
            policyRevision: Math.max(1, before.workspacePolicyRevision + 1),
            issuedAt,
            expiresAt,
          };
          const qualificationJson = JSON.stringify({
            version: 1,
            kind: "IndependentVerificationMountQualification",
            binding: verificationBinding,
            provider: {
              providerId: before.providerCandidate.providerId,
              providerVersion: before.providerCandidate.providerVersion,
              capabilityRevision: before.providerCandidate.capabilityRevision,
              osBuild: before.hostBuild,
              profile:
                "WorkspaceWrite" satisfies SandboxLinuxQualificationProfileV2,
              networkMode: before.networkPolicy.mode,
              qualificationEvidenceRef:
                before.providerCandidate.qualificationEvidenceRef,
            },
            mounts: mounts.map(({ ref, access }) => ({ ref, access })),
          });
          const qualificationBlob = yield* dependencies.blobs.put(
            new TextEncoder().encode(qualificationJson),
          );
          verificationMountQualificationEvidenceRef = `blob:sha256:${qualificationBlob}`;
        }
        const ownedCopies = [...copies];
        copies.length = 0;
        let disposed = false;
        const prepared: PreparedVerificationCommandEnvironment = {
          ...before,
          mounts,
          inputManifestJson,
          inputDigest,
          ...(verificationBinding === undefined ? {} : { verificationBinding }),
          ...(inputManifestRef === undefined ? {} : { inputManifestRef }),
          ...(verificationMountQualificationEvidenceRef === undefined
            ? {}
            : { verificationMountQualificationEvidenceRef }),
          /** Invoke again at P4 admission. No cached grant revives a policy. */
          revalidate: () =>
            Effect.gen(function* () {
              if (disposed) return false;
              const current = yield* readCurrent(executionId);
              if (current.basisDigest !== before.basisDigest) return false;
              for (let index = 0; index < before.sources.length; index++) {
                const path = before.sources[index]?.address.path;
                if (path === undefined) return false;
                const stat = yield* Effect.tryPromise(() =>
                  lstat(path, { bigint: true }),
                );
                if (
                  !stat.isDirectory() ||
                  `${stat.dev}:${stat.ino}` !== sourceIdentities[index]
                )
                  return false;
              }
              for (const copy of ownedCopies) {
                if (!(yield* Effect.tryPromise(() => copy.sourceIsCurrent())))
                  return false;
              }
              const after = yield* readCurrent(executionId);
              return (
                !disposed &&
                after.basisDigest === before.basisDigest &&
                encodeNetworkPolicyV1(after.networkPolicy) ===
                  encodeNetworkPolicyV1(before.networkPolicy)
              );
            }).pipe(Effect.catch(() => Effect.succeed(false))),
          dispose: () =>
            Effect.promise(async () => {
              disposed = true;
              const settled = await Promise.allSettled(
                ownedCopies.map((copy) => copy.dispose()),
              );
              if (settled.some((result) => result.status === "rejected")) {
                throw new VerificationCommandEnvironmentError(
                  "PreparationFailed",
                );
              }
            }),
        };
        return prepared;
      }).pipe(
        // Effect finalization, unlike generator finally, also handles typed
        // failures and interruption between two captured mounts.
        Effect.ensuring(
          Effect.promise(async () => {
            const settled = await Promise.allSettled(
              copies.map((copy) => copy.dispose()),
            );
            if (settled.some((result) => result.status === "rejected")) {
              throw new VerificationCommandEnvironmentError(
                "PreparationFailed",
              );
            }
          }),
        ),
        Effect.mapError((cause) =>
          cause instanceof VerificationCommandEnvironmentError
            ? cause
            : new VerificationCommandEnvironmentError("PreparationFailed"),
        ),
      );
    });
  return {
    prepare: (executionId: ExecutionId, signal?: AbortSignal) =>
      Effect.acquireRelease(
        prepare(executionId, signal),
        (environment) => environment.dispose(),
        { interruptible: true },
      ),
    /** Process-local caller-managed lifetime for P4's lazy resolver. */
    prepareUnmanaged: prepare,
  };
};
