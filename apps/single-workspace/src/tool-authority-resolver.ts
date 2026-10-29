import type { ParentUserGovernanceFacts } from "@arbor/application";
import { AuthorityResolverPort } from "@arbor/application";
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
          return { project, workspace, activeGrants, verification };
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
            if (Option.isNone(snapshot.workspace)) {
              return yield* Effect.fail({
                _tag: "ToolAuthorityResolutionError" as const,
                cause: "workspace not found",
              });
            }
            const actionDigest = sha256Hex(
              JSON.stringify({
                toolName: input.intent.toolName,
                toolVersion: input.intent.toolVersion,
                argumentsJson: input.intent.argumentsJson,
              }),
            );
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
