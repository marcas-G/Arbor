import {
  decodeWorkspaceSandboxAuthorization,
  type GrantedWorkspaceSandboxAuthorization,
  isIsoTimestamp,
  type NetworkPolicyV1,
  type WorkspaceId,
  type WorkspaceSandboxAuthorization,
  workspaceSandboxAuthorizationWithinCeiling,
} from "@arbor/domain";
import type {
  ClockService,
  ExecutionRepositoryService,
  WorkspaceRepositoryService,
  WorkspaceSandboxAuthorizationStoreService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { commandErr, commandOk } from "../command-result.js";
import {
  type CommandHandler,
  eraseCommandHandler,
} from "../gateway-contracts.js";
import { resolveCurrentWorkspaceSandboxAuthorization } from "../workspace-sandbox-authorization.js";

export interface AuthorizeWorkspaceSandboxPayload {
  readonly workspaceId: WorkspaceId;
  readonly expectedAuthorizationRevision: number;
  readonly expectedResourceBoundaryRevision: number;
  readonly expectedWorkspacePolicyRevision: number;
  readonly profile: "ReadOnly" | "WorkspaceWrite";
  readonly providerId: string;
  readonly networkPolicy: NetworkPolicyV1;
  readonly expiresAt: string | null;
  readonly source:
    | { readonly kind: "Human" }
    | {
        readonly kind: "Parent";
        readonly expectedParentAuthorizationRevision: number;
      };
}

export interface RevokeWorkspaceSandboxAuthorizationPayload {
  readonly workspaceId: WorkspaceId;
  readonly expectedAuthorizationRevision: number;
}

export interface WorkspaceSandboxAuthorizationResult {
  readonly authorization: WorkspaceSandboxAuthorization;
}

export interface WorkspaceSandboxAuthorizationCommandDependencies {
  readonly workspaces: Pick<WorkspaceRepositoryService, "findById">;
  readonly executions: Pick<ExecutionRepositoryService, "findById">;
  readonly authorizations: WorkspaceSandboxAuthorizationStoreService;
  readonly clock: Pick<ClockService, "now">;
}

const denied = (reason: string) =>
  commandErr({ _tag: "AuthorityDenied", reason });
const ordinal = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Staged Gateway handlers. Production registration waits for schema57 and
 * execution-policy binding; this module never writes legacy human Grants. */
export const makeAuthorizeWorkspaceSandboxHandler = (
  dependencies: WorkspaceSandboxAuthorizationCommandDependencies,
): CommandHandler<
  AuthorizeWorkspaceSandboxPayload,
  WorkspaceSandboxAuthorizationResult
> => ({
  commandType: "AuthorizeWorkspaceSandbox",
  schemaVersion: "1",
  authority: {
    tag: "WorkspaceSandboxAuthorizationAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "WorkspaceSandboxAuthorizationAuthority" &&
      authority.commandKind === "AuthorizeWorkspaceSandbox" &&
      authority.workspaceId === payload.workspaceId &&
      authority.source.kind === payload.source.kind &&
      (authority.source.kind !== "Parent" ||
        (payload.source.kind === "Parent" &&
          authority.source.parentAuthorizationRevision ===
            payload.source.expectedParentAuthorizationRevision)),
  },
  stopAdmission: { _tag: "NormalExecutionMutation" },
  execute: (envelope, context) =>
    Effect.gen(function* () {
      const { payload, resolvedAuthority: authority } = envelope;
      if (
        authority?._tag !== "WorkspaceSandboxAuthorizationAuthority" ||
        authority.commandKind !== "AuthorizeWorkspaceSandbox" ||
        authority.workspaceId !== payload.workspaceId ||
        authority.projectId !== envelope.projectId ||
        context.principal !== authority.principal ||
        authority.source.kind !== payload.source.kind ||
        !ordinal(payload.expectedAuthorizationRevision)
      )
        return denied("Workspace authorization authority mismatch");
      const now = yield* dependencies.clock.now();
      if (!isIsoTimestamp(now))
        return denied("Workspace authorization clock unavailable");
      const target = yield* dependencies.workspaces.findById(
        payload.workspaceId,
      );
      if (
        Option.isNone(target) ||
        target.value.projectId !== envelope.projectId ||
        target.value.lifecycle !== "Active"
      )
        return denied("Workspace authorization target is unavailable");
      if (
        target.value.resourceBoundaryRevision !==
          payload.expectedResourceBoundaryRevision ||
        target.value.workspacePolicyRevision !==
          payload.expectedWorkspacePolicyRevision
      )
        return denied(
          "Workspace authorization resource or policy revision changed",
        );
      const existing = yield* dependencies.authorizations.findCurrent(
        envelope.projectId,
        payload.workspaceId,
      );
      if (
        (Option.isSome(existing) ? existing.value.authorizationRevision : 0) !==
        payload.expectedAuthorizationRevision
      )
        return denied("Workspace authorization head changed");
      if (
        Option.isSome(existing) &&
        Date.parse(now) < Date.parse(existing.value.recordedAt)
      )
        return denied(
          "Workspace authorization clock precedes the current head",
        );
      // A human revocation is a durable stop at the target Workspace. A new
      // Parent allocation cannot erase it even while the Parent stays valid.
      if (
        authority.source.kind === "Parent" &&
        Option.isSome(existing) &&
        existing.value.state === "Revoked"
      )
        return denied(
          "Human Workspace revocation requires a new human authorization",
        );
      const origin: GrantedWorkspaceSandboxAuthorization["origin"] =
        authority.source.kind === "Human"
          ? { kind: "Human", principal: authority.principal }
          : authority.source;
      const authorization = decodeWorkspaceSandboxAuthorization({
        version: 1,
        projectId: envelope.projectId,
        workspaceId: payload.workspaceId,
        authorizationRevision: payload.expectedAuthorizationRevision + 1,
        commandId: envelope.commandId,
        actorPrincipal: authority.principal,
        recordedAt: now,
        state: "Granted",
        origin,
        resourceBoundaryRevision: payload.expectedResourceBoundaryRevision,
        workspacePolicyRevision: payload.expectedWorkspacePolicyRevision,
        profile: payload.profile,
        providerId: payload.providerId,
        networkPolicy: payload.networkPolicy,
        expiresAt: payload.expiresAt,
      });
      if (authorization?.state !== "Granted")
        return denied("Invalid Workspace authorization selection");
      if (authority.source.kind === "Human") {
        if (context._tag !== "External")
          return denied(
            "Human Workspace authorization requires authenticated external origin",
          );
      } else {
        if (
          context._tag !== "ExecutionOrigin" ||
          context.executionId !== authority.source.parentExecutionId ||
          payload.source.kind !== "Parent" ||
          payload.source.expectedParentAuthorizationRevision !==
            authority.source.parentAuthorizationRevision ||
          target.value.parentWorkspaceId !== authority.source.parentWorkspaceId
        )
          return denied("Parent allocation source changed");
        const execution = yield* dependencies.executions.findById(
          context.executionId,
        );
        if (
          Option.isNone(execution) ||
          execution.value.projectId !== envelope.projectId ||
          execution.value.workspaceId !== authority.source.parentWorkspaceId ||
          execution.value.binding._tag !== "WorkspaceExecution" ||
          execution.value.binding.episode === undefined ||
          execution.value.state.status !== "Active"
        )
          return denied("Parent allocation Execution is unavailable");
        const parent = yield* resolveCurrentWorkspaceSandboxAuthorization(
          dependencies,
          {
            projectId: envelope.projectId,
            workspaceId: authority.source.parentWorkspaceId,
            now,
          },
        );
        if (
          parent._tag !== "Authorized" ||
          parent.authorization.authorizationRevision !==
            authority.source.parentAuthorizationRevision ||
          !workspaceSandboxAuthorizationWithinCeiling(
            authorization,
            parent.authorization,
          )
        )
          return denied(
            "Parent allocation source is stale or exceeds its current ceiling",
          );
      }
      yield* dependencies.authorizations.appendCommitted(authorization);
      return commandOk({
        result: { authorization },
        events: [
          {
            projectId: envelope.projectId,
            eventType: "WorkspaceSandboxAuthorizationChanged",
            eventVersion: 1,
            occurredAt: now,
            aggregateRef: payload.workspaceId,
            actor: envelope.actor,
            causedByCommandId: envelope.commandId,
            payload: {
              workspaceId: payload.workspaceId,
              authorizationRevision: authorization.authorizationRevision,
              state: authorization.state,
            },
          },
        ],
      });
    }),
});

export const makeRevokeWorkspaceSandboxAuthorizationHandler = (
  dependencies: WorkspaceSandboxAuthorizationCommandDependencies,
): CommandHandler<
  RevokeWorkspaceSandboxAuthorizationPayload,
  WorkspaceSandboxAuthorizationResult
> => ({
  commandType: "RevokeWorkspaceSandboxAuthorization",
  schemaVersion: "1",
  authority: {
    tag: "WorkspaceSandboxAuthorizationAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "WorkspaceSandboxAuthorizationAuthority" &&
      authority.commandKind === "RevokeWorkspaceSandboxAuthorization" &&
      authority.source.kind === "Human" &&
      authority.workspaceId === payload.workspaceId,
  },
  stopAdmission: { _tag: "Unclassified" },
  execute: (envelope, context) =>
    Effect.gen(function* () {
      const { payload, resolvedAuthority: authority } = envelope;
      if (
        authority?._tag !== "WorkspaceSandboxAuthorizationAuthority" ||
        authority.commandKind !== "RevokeWorkspaceSandboxAuthorization" ||
        authority.source.kind !== "Human" ||
        authority.workspaceId !== payload.workspaceId ||
        authority.projectId !== envelope.projectId ||
        context._tag !== "External" ||
        context.principal !== authority.principal ||
        !ordinal(payload.expectedAuthorizationRevision)
      )
        return denied("Workspace revocation authority mismatch");
      const now = yield* dependencies.clock.now();
      const workspace = yield* dependencies.workspaces.findById(
        payload.workspaceId,
      );
      if (
        !isIsoTimestamp(now) ||
        Option.isNone(workspace) ||
        workspace.value.projectId !== envelope.projectId ||
        workspace.value.lifecycle !== "Active"
      )
        return denied("Workspace revocation target unavailable");
      const existing = yield* dependencies.authorizations.findCurrent(
        envelope.projectId,
        payload.workspaceId,
      );
      if (
        Option.isNone(existing) ||
        existing.value.authorizationRevision !==
          payload.expectedAuthorizationRevision ||
        existing.value.state !== "Granted"
      )
        return denied("Workspace authorization head changed");
      if (Date.parse(now) < Date.parse(existing.value.recordedAt))
        return denied("Workspace revocation clock precedes the current head");
      const authorization: WorkspaceSandboxAuthorization = {
        version: 1,
        state: "Revoked",
        projectId: envelope.projectId,
        workspaceId: payload.workspaceId,
        authorizationRevision: payload.expectedAuthorizationRevision + 1,
        commandId: envelope.commandId,
        actorPrincipal: authority.principal,
        recordedAt: now,
      };
      if (decodeWorkspaceSandboxAuthorization(authorization) === undefined)
        return denied("Invalid revocation revision");
      yield* dependencies.authorizations.appendCommitted(authorization);
      return commandOk({
        result: { authorization },
        events: [
          {
            projectId: envelope.projectId,
            eventType: "WorkspaceSandboxAuthorizationChanged",
            eventVersion: 1,
            occurredAt: now,
            aggregateRef: payload.workspaceId,
            actor: envelope.actor,
            causedByCommandId: envelope.commandId,
            payload: {
              workspaceId: payload.workspaceId,
              authorizationRevision: authorization.authorizationRevision,
              state: authorization.state,
            },
          },
        ],
      });
    }),
});

export const makeWorkspaceSandboxAuthorizationHandlers = (
  dependencies: WorkspaceSandboxAuthorizationCommandDependencies,
) => [
  eraseCommandHandler(makeAuthorizeWorkspaceSandboxHandler(dependencies)),
  eraseCommandHandler(
    makeRevokeWorkspaceSandboxAuthorizationHandler(dependencies),
  ),
];
