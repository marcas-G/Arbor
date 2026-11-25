import {
  encodeNetworkPolicyV1,
  isIsoTimestamp,
  type ProjectId,
  resolveWorkspaceSandboxAuthorization,
  type SandboxPolicyDecision,
  type SandboxPolicyDecisionCommittedInternal,
  type WorkspaceId,
  type WorkspaceSandboxAuthorization,
  type WorkspaceSandboxAuthorizationResolution,
  type WorkspaceSandboxAuthorizationSnapshot,
} from "@arbor/domain";
import type {
  WorkspaceRepositoryService,
  WorkspaceSandboxAuthorizationStoreService,
} from "@arbor/ports";
import { Effect, Option } from "effect";

export interface WorkspaceSandboxAuthorizationReadDependencies {
  readonly workspaces: Pick<WorkspaceRepositoryService, "findById">;
  readonly authorizations: Pick<
    WorkspaceSandboxAuthorizationStoreService,
    "findCurrent"
  >;
}

/** Must run under one TransactionScope. Every ancestor is read at use time;
 * neither cached authorization nor a historical source can grant authority. */
export const loadWorkspaceSandboxAuthorizationSnapshot = (
  dependencies: WorkspaceSandboxAuthorizationReadDependencies,
  projectId: ProjectId,
  workspaceId: WorkspaceId,
) =>
  Effect.gen(function* () {
    const heads: WorkspaceSandboxAuthorization[] = [];
    const workspaces: WorkspaceSandboxAuthorizationSnapshot["workspaces"][number][] =
      [];
    const visited = new Set<WorkspaceId>();
    let target = workspaceId;
    while (!visited.has(target)) {
      visited.add(target);
      const workspace = yield* dependencies.workspaces.findById(target);
      if (Option.isNone(workspace) || workspace.value.projectId !== projectId)
        break;
      workspaces.push(workspace.value);
      const head = yield* dependencies.authorizations.findCurrent(
        projectId,
        target,
      );
      if (Option.isNone(head)) break;
      heads.push(head.value);
      if (head.value.state !== "Granted" || head.value.origin.kind !== "Parent")
        break;
      target = head.value.origin.parentWorkspaceId;
    }
    return {
      heads,
      workspaces,
    } satisfies WorkspaceSandboxAuthorizationSnapshot;
  });

export const resolveCurrentWorkspaceSandboxAuthorization = (
  dependencies: WorkspaceSandboxAuthorizationReadDependencies,
  input: {
    readonly projectId: ProjectId;
    readonly workspaceId: WorkspaceId;
    readonly now: string;
  },
) =>
  loadWorkspaceSandboxAuthorizationSnapshot(
    dependencies,
    input.projectId,
    input.workspaceId,
  ).pipe(
    Effect.map((snapshot) =>
      resolveWorkspaceSandboxAuthorization({ ...snapshot, ...input }),
    ),
  );

/** Projects the standing Workspace authorization into invocation capabilities.
 * This is shared by ordinary tool authority and exact-action approval issuance
 * so the approval path cannot re-deny a capability already granted by the
 * current Workspace baseline. */
export const workspaceSandboxAuthorizationCapabilities = (
  resolution: WorkspaceSandboxAuthorizationResolution,
): ReadonlyArray<string> | undefined =>
  resolution._tag !== "Authorized"
    ? undefined
    : resolution.authorization.profile === "WorkspaceWrite"
      ? ["fs:read", "fs:write", "shell:exec"]
      : ["fs:read"];

/** A committed policy is historical evidence, never standing authority by
 * itself. Call inside the same transaction as the policy/current resource read.
 * Legacy policy admission retains its separate historical authority path. */
export const workspaceSandboxPolicyBindingIsAuthorized = (
  dependencies: WorkspaceSandboxAuthorizationReadDependencies,
  input: {
    readonly decision: SandboxPolicyDecision;
    readonly result: SandboxPolicyDecisionCommittedInternal;
    readonly now: string;
  },
) =>
  Effect.gen(function* () {
    const { decision, result, now } = input;
    if (
      decision.authorityKind !== "WorkspaceAuthorization" ||
      result.version !== 3 ||
      result.workspaceAuthorizationRevision !==
        decision.workspaceAuthorizationRevision ||
      !isIsoTimestamp(now) ||
      !isIsoTimestamp(decision.issuedAt) ||
      !isIsoTimestamp(decision.expiresAt) ||
      Date.parse(now) < Date.parse(decision.issuedAt) ||
      Date.parse(now) >= Date.parse(decision.expiresAt) ||
      result.commandId !== decision.decisionCommandId ||
      result.projectId !== decision.projectId ||
      result.workspaceId !== decision.workspaceId ||
      result.executionId !== decision.executionId ||
      decision.networkPolicy.kind !== "OsEnforced"
    )
      return false;
    const current = yield* resolveCurrentWorkspaceSandboxAuthorization(
      dependencies,
      {
        projectId: decision.projectId,
        workspaceId: decision.workspaceId,
        now,
      },
    );
    if (current._tag !== "Authorized") return false;
    const authorization = current.authorization;
    return (
      authorization.authorizationRevision ===
        decision.workspaceAuthorizationRevision &&
      authorization.profile === decision.profile &&
      authorization.providerId === decision.providerId &&
      encodeNetworkPolicyV1(authorization.networkPolicy) ===
        encodeNetworkPolicyV1(decision.networkPolicy.policy) &&
      Date.parse(authorization.recordedAt) <= Date.parse(decision.issuedAt) &&
      (authorization.expiresAt === null ||
        Date.parse(decision.expiresAt) <= Date.parse(authorization.expiresAt))
    );
  });
