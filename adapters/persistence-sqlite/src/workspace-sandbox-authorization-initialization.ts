import {
  decodeWorkspaceSandboxAuthorization,
  encodeNetworkPolicyV1,
  type WorkspaceSandboxAuthorization,
  workspaceSandboxAuthorizationWithinCeiling,
} from "@arbor/domain";
import {
  WorkspaceSandboxAuthorizationInitializationPort,
  type WorkspaceSandboxAuthorizationInitializationPortService,
  WorkspaceSandboxAuthorizationStore,
  type WorkspaceSandboxAuthorizationStoreService,
  type WorkspaceSandboxInitializationOutcome,
} from "@arbor/ports";
import { Effect, Layer } from "effect";

export const makeWorkspaceSandboxAuthorizationInitialization = (input: {
  readonly qualified: boolean;
  readonly store: Pick<
    WorkspaceSandboxAuthorizationStoreService,
    "findCurrent" | "appendCommitted"
  >;
}): WorkspaceSandboxAuthorizationInitializationPortService => ({
  initialize: (request) =>
    Effect.gen(function* () {
      if (!input.qualified)
        return {
          _tag: "Unavailable",
          reason:
            "qualified linux-bwrap WorkspaceWrite × Enabled tuple unavailable",
        } satisfies WorkspaceSandboxInitializationOutcome;
      const current = yield* input.store.findCurrent(
        request.projectId,
        request.workspaceId,
      );
      if (current._tag === "Some") {
        const value = current.value;
        if (value.state === "Revoked")
          return {
            _tag: "Revoked",
          } satisfies WorkspaceSandboxInitializationOutcome;
        if (
          value.resourceBoundaryRevision !== request.resourceBoundaryRevision ||
          value.workspacePolicyRevision !== request.workspacePolicyRevision ||
          value.profile !== "WorkspaceWrite" ||
          value.providerId !== request.providerId ||
          encodeNetworkPolicyV1(value.networkPolicy) !==
            encodeNetworkPolicyV1(request.networkPolicy)
        )
          return {
            _tag: "Stale",
          } satisfies WorkspaceSandboxInitializationOutcome;
        return {
          _tag: "AlreadyInitialized",
          authorization: value,
        } satisfies WorkspaceSandboxInitializationOutcome;
      }
      const authorization: WorkspaceSandboxAuthorization = {
        version: 1,
        projectId: request.projectId,
        workspaceId: request.workspaceId,
        authorizationRevision: 1,
        commandId: request.commandId,
        actorPrincipal: request.actorPrincipal,
        recordedAt: request.recordedAt,
        state: "Granted",
        origin: { kind: "SystemInitialization" },
        resourceBoundaryRevision: request.resourceBoundaryRevision,
        workspacePolicyRevision: request.workspacePolicyRevision,
        profile: "WorkspaceWrite",
        providerId: request.providerId,
        networkPolicy: request.networkPolicy,
        expiresAt: null,
      };
      const decoded = decodeWorkspaceSandboxAuthorization(authorization);
      if (decoded === undefined || decoded.state !== "Granted")
        return {
          _tag: "Unavailable",
          reason: "system initialization authorization is invalid",
        } satisfies WorkspaceSandboxInitializationOutcome;
      if (
        request.parentAuthorization !== undefined &&
        !workspaceSandboxAuthorizationWithinCeiling(
          decoded,
          request.parentAuthorization,
        )
      )
        return {
          _tag: "Unavailable",
          reason:
            "parent Workspace capability ceiling does not permit the baseline",
        } satisfies WorkspaceSandboxInitializationOutcome;
      yield* input.store.appendCommitted(decoded);
      return {
        _tag: "Initialized",
        authorization: decoded,
      } satisfies WorkspaceSandboxInitializationOutcome;
    }),
});

export const WorkspaceSandboxAuthorizationInitializationPortLive = (input: {
  readonly qualified: boolean;
}): Layer.Layer<
  WorkspaceSandboxAuthorizationInitializationPort,
  never,
  WorkspaceSandboxAuthorizationStore
> =>
  Layer.effect(
    WorkspaceSandboxAuthorizationInitializationPort,
    Effect.gen(function* () {
      const store = yield* WorkspaceSandboxAuthorizationStore;
      return WorkspaceSandboxAuthorizationInitializationPort.of(
        makeWorkspaceSandboxAuthorizationInitialization({
          qualified: input.qualified,
          store,
        }),
      );
    }),
  );
