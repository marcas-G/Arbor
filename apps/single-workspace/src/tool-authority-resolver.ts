import type { ParentUserGovernanceFacts } from "@arbor/application";
import { AuthorityResolverPort } from "@arbor/application";
import {
  PermissionGrantRepository,
  ProjectRepository,
  sha256Hex,
  ToolAuthorityResolver,
  TransactionPort,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";

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
> =>
  Layer.effect(
    ToolAuthorityResolver,
    Effect.gen(function* () {
      const resolver = yield* AuthorityResolverPort;
      const tx = yield* TransactionPort;
      const projects = yield* ProjectRepository;
      const workspaces = yield* WorkspaceRepository;
      const grants = yield* PermissionGrantRepository;
      return ToolAuthorityResolver.of({
        resolve: (input) =>
          Effect.gen(function* () {
            const snapshot = yield* tx.transact(
              Effect.gen(function* () {
                const project = yield* projects.findById(
                  input.context.projectId,
                );
                const workspace = yield* workspaces.findById(
                  input.context.workspaceId,
                );
                const activeGrants = yield* grants.activeGrants(
                  input.context.projectId,
                );
                return { project, workspace, activeGrants };
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
            return yield* resolver
              .resolveInvocation({
                principal: input.context.authenticatedPrincipal,
                workspaceId: input.context.workspaceId,
                executionId: input.context.executionId,
                intent: {
                  toolName: input.intent.toolName,
                  toolVersion: input.intent.toolVersion,
                  argumentsJson: input.intent.argumentsJson,
                  actionDigest,
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
                now: input.now,
              })
              .pipe(
                Effect.mapError((cause) => ({
                  _tag: "ToolAuthorityResolutionError" as const,
                  cause,
                })),
              );
          }).pipe(
            Effect.mapError((cause) =>
              cause._tag === "ToolAuthorityResolutionError"
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
