import type { ParentUserGovernanceFacts } from "@arbor/application";
import {
  AuthorityResolverPort,
  loadWorkspaceSandboxAuthorizationSnapshot,
  workspaceSandboxAuthorizationCapabilities,
} from "@arbor/application";
import { resolveWorkspaceSandboxAuthorization } from "@arbor/domain";
import {
  invocationAuthoritySourceRevisionOf,
  PermissionGrantRepository,
  ProjectRepository,
  sha256Hex,
  ToolAuthorityResolver,
  TransactionPort,
  TransactionScope,
  VerificationRepository,
  WorkspaceRepository,
  WorkspaceSandboxAuthorizationStore,
} from "@arbor/ports";
import { Context, Effect, Layer, Option } from "effect";

export const ToolAuthorityResolverLive = (
  governance: ParentUserGovernanceFacts,
): Layer.Layer<
  ToolAuthorityResolver,
  never,
  | AuthorityResolverPort
  | TransactionPort
  | ProjectRepository
  | WorkspaceRepository
  | PermissionGrantRepository
  | VerificationRepository
> =>
  Layer.effect(
    ToolAuthorityResolver,
    Effect.gen(function* () {
      const resolver = yield* AuthorityResolverPort;
      const tx = yield* TransactionPort;
      const projects = yield* ProjectRepository;
      const workspaces = yield* WorkspaceRepository;
      const grants = yield* PermissionGrantRepository;
      const verifications = yield* VerificationRepository;
      const authorizations = yield* Effect.serviceOption(
        WorkspaceSandboxAuthorizationStore,
      );
      const isPolicyDenial = (cause: unknown): boolean =>
        typeof cause === "object" &&
        cause !== null &&
        "_tag" in cause &&
        typeof cause._tag === "string" &&
        [
          "NoApplicableGrant",
          "GrantScopeInsufficient",
          "CapabilityCeilingExceeded",
          "DelegationCeilingExceeded",
          "GovernanceOverrideDenied",
          "ApprovalIntentMismatch",
        ].includes(cause._tag);
      const readSnapshot = (input: {
        readonly projectId: import("@arbor/domain").ProjectId;
        readonly workspaceId: import("@arbor/domain").WorkspaceId;
        readonly executionId: import("@arbor/domain").ExecutionId;
      }) =>
        Effect.gen(function* () {
          const project = yield* projects.findById(input.projectId);
          const workspace = yield* workspaces.findById(input.workspaceId);
          const activeGrants = yield* grants.activeGrants(input.projectId);
          const verification = yield* verifications.findByExecutionId(
            input.executionId,
          );
          const workspaceSandbox = Option.isSome(authorizations)
            ? yield* loadWorkspaceSandboxAuthorizationSnapshot(
                { workspaces, authorizations: authorizations.value },
                input.projectId,
                input.workspaceId,
              )
            : undefined;
          return {
            project,
            workspace,
            activeGrants,
            verification,
            workspaceSandbox,
          };
        });
      return ToolAuthorityResolver.of({
        resolve: (input) =>
          Effect.gen(function* () {
            const existingTransaction = Context.getOption(
              yield* Effect.context<never>(),
              TransactionScope,
            );
            const snapshot = Option.isSome(existingTransaction)
              ? yield* readSnapshot({
                  projectId: input.context.projectId,
                  workspaceId: input.context.workspaceId,
                  executionId: input.context.executionId,
                }).pipe(
                  Effect.provideService(TransactionScope)(
                    existingTransaction.value,
                  ),
                )
              : yield* tx.transact(
                  readSnapshot({
                    projectId: input.context.projectId,
                    workspaceId: input.context.workspaceId,
                    executionId: input.context.executionId,
                  }),
                );
            if (
              Option.isNone(snapshot.workspace) ||
              snapshot.workspace.value.projectId !== input.context.projectId ||
              snapshot.workspace.value.lifecycle !== "Active"
            ) {
              return yield* Effect.fail({
                _tag: "ToolAuthorityResolutionError" as const,
                cause: "workspace missing, retired or outside current project",
              });
            }
            const actionDigest = sha256Hex(
              JSON.stringify({
                toolName: input.intent.toolName,
                toolVersion: input.intent.toolVersion,
                argumentsJson: input.intent.argumentsJson,
              }),
            );
            const workspaceSandbox = snapshot.workspaceSandbox;
            const ceiling =
              workspaceSandbox === undefined
                ? undefined
                : resolveWorkspaceSandboxAuthorization({
                    ...workspaceSandbox,
                    projectId: input.context.projectId,
                    workspaceId: input.context.workspaceId,
                    now: input.now,
                  });
            const workspaceAuthorizationCapabilities =
              ceiling === undefined
                ? undefined
                : workspaceSandboxAuthorizationCapabilities(ceiling);
            const sensitive = input.definition.capabilityMetadata.some(
              (capability) => capability !== "fs:read",
            );
            // Legacy file grants remain usable before any sandbox choice. Once
            // a standing choice exists it is also a ceiling on tool authority.
            if (
              sensitive &&
              workspaceSandbox !== undefined &&
              workspaceSandbox.heads.length > 0 &&
              (ceiling?._tag !== "Authorized" ||
                (ceiling.authorization.profile === "ReadOnly" &&
                  input.definition.capabilityMetadata.includes("fs:write")))
            ) {
              return yield* Effect.fail({
                _tag: "ToolAuthorityDenied" as const,
              });
            }
            const authority = yield* resolver
              .resolveInvocation({
                principal: input.context.authenticatedPrincipal,
                projectId: input.context.projectId,
                workspaceId: input.context.workspaceId,
                executionId: input.context.executionId,
                intent: {
                  toolName: input.intent.toolName,
                  toolVersion: input.intent.toolVersion,
                  argumentsJson: input.intent.argumentsJson,
                  actionDigest,
                  sideEffectSemantics: input.definition.sideEffectSemantics,
                  requestedCapabilities: input.definition.capabilityMetadata,
                  resolvedRegions: input.regions.map(
                    (region) => region.resourceSpaceId,
                  ),
                },
                controlBasisDigest: input.context.controlBasisDigest,
                grants: snapshot.activeGrants,
                ...(workspaceAuthorizationCapabilities === undefined
                  ? {}
                  : { workspaceAuthorizationCapabilities }),
                governance,
                policy: snapshot.workspace.value.workspacePolicy,
                delegationDepth: input.context.delegationDepth ?? 0,
                ...(Option.isSome(snapshot.verification)
                  ? { executionRole: "Verifier" as const }
                  : {}),
                now: input.now,
              })
              .pipe(
                Effect.mapError((cause) =>
                  isPolicyDenial(cause)
                    ? { _tag: "ToolAuthorityDenied" as const }
                    : {
                        _tag: "ToolAuthorityResolutionError" as const,
                        cause,
                      },
                ),
              );
            return {
              ...authority,
              ...(ceiling?._tag === "Authorized"
                ? {
                    expiresAt: ceiling.lineage.reduce(
                      (expiry, source) =>
                        source.expiresAt !== null && source.expiresAt < expiry
                          ? source.expiresAt
                          : expiry,
                      authority.expiresAt,
                    ),
                  }
                : {}),
              ...(workspaceSandbox === undefined
                ? {}
                : {
                    workspaceSandboxSources: workspaceSandbox.workspaces.map(
                      (workspace) => ({
                        workspaceId: workspace.workspaceId,
                        parentWorkspaceId: workspace.parentWorkspaceId,
                        lifecycle: workspace.lifecycle,
                        resourceBoundaryRevision: Number(
                          workspace.resourceBoundaryRevision,
                        ),
                        workspacePolicyRevision: Number(
                          workspace.workspacePolicyRevision,
                        ),
                        authorizationRevision:
                          workspaceSandbox.heads.find(
                            (head) =>
                              head.workspaceId === workspace.workspaceId,
                          )?.authorizationRevision ?? null,
                      }),
                    ),
                  }),
              sourceRevision: invocationAuthoritySourceRevisionOf({
                workspacePolicyRevision: Number(
                  snapshot.workspace.value.workspacePolicyRevision,
                ),
                activeGrants: snapshot.activeGrants.map((grant) => ({
                  permissionGrantId: String(grant.permissionGrantId),
                  revision: grant.revision ?? null,
                })),
                verifierId: Option.isSome(snapshot.verification)
                  ? String(snapshot.verification.value.verificationId)
                  : null,
              }),
            };
          }).pipe(
            Effect.mapError((cause) =>
              cause._tag === "ToolAuthorityResolutionError" ||
              cause._tag === "ToolAuthorityDenied"
                ? cause
                : {
                    _tag: "ToolAuthorityResolutionError" as const,
                    cause,
                  },
            ),
          ),
      });
    }),
  );
