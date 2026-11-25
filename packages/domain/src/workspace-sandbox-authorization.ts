import { Principal, type Principal as PrincipalType } from "./actor.js";
import { isIsoTimestamp } from "./authority.js";
import {
  CommandId,
  ExecutionId,
  ProjectId,
  parse,
  WorkspaceId,
} from "./ids.js";
import {
  decodeNetworkPolicyV1,
  decodeSandboxProviderId,
  type NetworkPolicyV1,
  type SandboxProviderId,
} from "./sandbox-policy.js";
import type { Workspace } from "./workspace.js";

export type WorkspaceSandboxAuthorizationOrigin =
  | { readonly kind: "Human"; readonly principal: PrincipalType }
  | { readonly kind: "SystemInitialization" }
  | {
      readonly kind: "Parent";
      readonly parentWorkspaceId: WorkspaceId;
      readonly parentAuthorizationRevision: number;
      readonly parentExecutionId: ExecutionId;
    };

interface WorkspaceSandboxAuthorizationBase {
  readonly version: 1;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly authorizationRevision: number;
  readonly commandId: CommandId;
  readonly actorPrincipal: PrincipalType;
  readonly recordedAt: string;
}

export interface GrantedWorkspaceSandboxAuthorization
  extends WorkspaceSandboxAuthorizationBase {
  readonly state: "Granted";
  readonly origin: WorkspaceSandboxAuthorizationOrigin;
  readonly resourceBoundaryRevision: number;
  readonly workspacePolicyRevision: number;
  readonly profile: "ReadOnly" | "WorkspaceWrite";
  readonly providerId: SandboxProviderId;
  readonly networkPolicy: NetworkPolicyV1;
  readonly expiresAt: string | null;
}

export interface RevokedWorkspaceSandboxAuthorization
  extends WorkspaceSandboxAuthorizationBase {
  readonly state: "Revoked";
}

export type WorkspaceSandboxAuthorization =
  | GrantedWorkspaceSandboxAuthorization
  | RevokedWorkspaceSandboxAuthorization;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const exact = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const ordinal = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;

/** Closed codec; a malformed durable fact must never become a missing grant. */
export const decodeWorkspaceSandboxAuthorization = (
  input: unknown,
): WorkspaceSandboxAuthorization | undefined => {
  const value = record(input);
  if (
    value === undefined ||
    value.version !== 1 ||
    !ordinal(value.authorizationRevision, 1) ||
    typeof value.recordedAt !== "string" ||
    !isIsoTimestamp(value.recordedAt) ||
    typeof value.actorPrincipal !== "string"
  )
    return undefined;
  const commonKeys = [
    "version",
    "projectId",
    "workspaceId",
    "authorizationRevision",
    "commandId",
    "actorPrincipal",
    "recordedAt",
  ];
  try {
    const common: WorkspaceSandboxAuthorizationBase = {
      version: 1,
      projectId: parse(ProjectId)(value.projectId),
      workspaceId: parse(WorkspaceId)(value.workspaceId),
      authorizationRevision: value.authorizationRevision,
      commandId: parse(CommandId)(value.commandId),
      actorPrincipal: parse(Principal)(value.actorPrincipal),
      recordedAt: value.recordedAt,
    };
    if (value.state === "Revoked") {
      return common.authorizationRevision >= 2 &&
        exact(value, [...commonKeys, "state"])
        ? { ...common, state: "Revoked" }
        : undefined;
    }
    if (
      value.state !== "Granted" ||
      !exact(value, [
        ...commonKeys,
        "state",
        "origin",
        "resourceBoundaryRevision",
        "workspacePolicyRevision",
        "profile",
        "providerId",
        "networkPolicy",
        "expiresAt",
      ]) ||
      !ordinal(value.resourceBoundaryRevision) ||
      !ordinal(value.workspacePolicyRevision) ||
      (value.profile !== "ReadOnly" && value.profile !== "WorkspaceWrite") ||
      (value.expiresAt !== null &&
        (typeof value.expiresAt !== "string" ||
          !isIsoTimestamp(value.expiresAt) ||
          Date.parse(value.expiresAt) <= Date.parse(common.recordedAt)))
    )
      return undefined;
    const networkPolicy = decodeNetworkPolicyV1(value.networkPolicy);
    const providerId = decodeSandboxProviderId(value.providerId);
    const source = record(value.origin);
    if (
      networkPolicy === undefined ||
      providerId === undefined ||
      providerId === "TrustedLocal" ||
      providerId === "TrustedLocalUnconfinedV1" ||
      source === undefined
    )
      return undefined;
    let origin: WorkspaceSandboxAuthorizationOrigin;
    if (source.kind === "Human" && exact(source, ["kind", "principal"])) {
      const principal = parse(Principal)(source.principal);
      if (
        !principal.startsWith("user:") ||
        principal.length <= 5 ||
        principal !== common.actorPrincipal
      )
        return undefined;
      origin = { kind: "Human", principal };
    } else if (
      source.kind === "SystemInitialization" &&
      exact(source, ["kind"])
    ) {
      origin = { kind: "SystemInitialization" };
    } else if (
      source.kind === "Parent" &&
      exact(source, [
        "kind",
        "parentWorkspaceId",
        "parentAuthorizationRevision",
        "parentExecutionId",
      ]) &&
      ordinal(source.parentAuthorizationRevision, 1)
    ) {
      const parentWorkspaceId = parse(WorkspaceId)(source.parentWorkspaceId);
      if (parentWorkspaceId === common.workspaceId) return undefined;
      origin = {
        kind: "Parent",
        parentWorkspaceId,
        parentAuthorizationRevision: source.parentAuthorizationRevision,
        parentExecutionId: parse(ExecutionId)(source.parentExecutionId),
      };
    } else return undefined;
    return {
      ...common,
      state: "Granted",
      origin,
      resourceBoundaryRevision: value.resourceBoundaryRevision,
      workspacePolicyRevision: value.workspacePolicyRevision,
      profile: value.profile,
      providerId,
      networkPolicy,
      expiresAt: value.expiresAt,
    };
  } catch {
    return undefined;
  }
};

export const encodeWorkspaceSandboxAuthorization = (
  value: WorkspaceSandboxAuthorization,
): string => {
  const decoded = decodeWorkspaceSandboxAuthorization(value);
  if (decoded === undefined)
    throw new Error("InvalidWorkspaceSandboxAuthorization");
  return JSON.stringify(decoded);
};

export const decodeCanonicalWorkspaceSandboxAuthorization = (
  json: string,
): WorkspaceSandboxAuthorization | undefined => {
  try {
    const value = decodeWorkspaceSandboxAuthorization(JSON.parse(json));
    return value !== undefined &&
      encodeWorkspaceSandboxAuthorization(value) === json
      ? value
      : undefined;
  } catch {
    return undefined;
  }
};

/** Capability allocation never allocates or shares a resource address. */
export const workspaceSandboxAuthorizationWithinCeiling = (
  child: GrantedWorkspaceSandboxAuthorization,
  parent: GrantedWorkspaceSandboxAuthorization,
): boolean =>
  Date.parse(child.recordedAt) >= Date.parse(parent.recordedAt) &&
  child.providerId === parent.providerId &&
  (parent.profile === "WorkspaceWrite" || child.profile === "ReadOnly") &&
  (parent.expiresAt === null ||
    (child.expiresAt !== null &&
      Date.parse(child.expiresAt) <= Date.parse(parent.expiresAt))) &&
  (parent.networkPolicy.mode === "Enabled" ||
    child.networkPolicy.mode === "Disabled" ||
    (parent.networkPolicy.mode === "Restricted" &&
      child.networkPolicy.mode === "Restricted" &&
      child.networkPolicy.destinations.every((destination) =>
        parent.networkPolicy.destinations.includes(destination),
      )));

export type WorkspaceSandboxAuthorizationDenial =
  | "InvalidTime"
  | "MissingOrAmbiguousWorkspace"
  | "MissingOrAmbiguousHead"
  | "WorkspaceInactive"
  | "ResourceScopeChanged"
  | "PolicyChanged"
  | "Revoked"
  | "OutsideValidity"
  | "ParentChanged"
  | "ParentSourceChanged"
  | "CeilingExceeded"
  | "Cycle"
  | "InvalidFact";

export type WorkspaceSandboxAuthorizationResolution =
  | {
      readonly _tag: "Authorized";
      readonly authorization: GrantedWorkspaceSandboxAuthorization;
      readonly lineage: readonly GrantedWorkspaceSandboxAuthorization[];
    }
  | {
      readonly _tag: "Denied";
      readonly reason: WorkspaceSandboxAuthorizationDenial;
    };

export interface WorkspaceSandboxAuthorizationSnapshot {
  readonly heads: readonly WorkspaceSandboxAuthorization[];
  readonly workspaces: readonly Pick<
    Workspace,
    | "projectId"
    | "workspaceId"
    | "parentWorkspaceId"
    | "lifecycle"
    | "resourceBoundaryRevision"
    | "workspacePolicyRevision"
  >[];
}

/** Pure evaluation over one current-head snapshot. No originating Execution
 * lifetime, model text, user-prefix override, or historical-head fallback. */
export const resolveWorkspaceSandboxAuthorization = (
  input: WorkspaceSandboxAuthorizationSnapshot & {
    readonly projectId: ProjectId;
    readonly workspaceId: WorkspaceId;
    readonly now: string;
  },
): WorkspaceSandboxAuthorizationResolution => {
  const deny = (
    reason: WorkspaceSandboxAuthorizationDenial,
  ): WorkspaceSandboxAuthorizationResolution => ({ _tag: "Denied", reason });
  if (!isIsoTimestamp(input.now)) return deny("InvalidTime");
  const visited = new Set<WorkspaceId>();
  const lineage: GrantedWorkspaceSandboxAuthorization[] = [];
  let target = input.workspaceId;
  let expectedRevision: number | undefined;
  let child: GrantedWorkspaceSandboxAuthorization | undefined;
  while (true) {
    if (visited.has(target)) return deny("Cycle");
    visited.add(target);
    const workspaces = input.workspaces.filter(
      (item) =>
        item.projectId === input.projectId && item.workspaceId === target,
    );
    if (workspaces.length !== 1) return deny("MissingOrAmbiguousWorkspace");
    const workspace = workspaces[0];
    if (workspace === undefined || workspace.lifecycle !== "Active")
      return deny("WorkspaceInactive");
    const heads = input.heads.filter(
      (item) =>
        item.projectId === input.projectId && item.workspaceId === target,
    );
    if (heads.length !== 1) return deny("MissingOrAmbiguousHead");
    const head = decodeWorkspaceSandboxAuthorization(heads[0]);
    if (head === undefined) return deny("InvalidFact");
    if (
      expectedRevision !== undefined &&
      head.authorizationRevision !== expectedRevision
    )
      return deny("ParentSourceChanged");
    if (head.state === "Revoked") return deny("Revoked");
    if (
      Date.parse(input.now) < Date.parse(head.recordedAt) ||
      (head.expiresAt !== null &&
        Date.parse(input.now) >= Date.parse(head.expiresAt))
    )
      return deny("OutsideValidity");
    if (head.resourceBoundaryRevision !== workspace.resourceBoundaryRevision)
      return deny("ResourceScopeChanged");
    if (head.workspacePolicyRevision !== workspace.workspacePolicyRevision)
      return deny("PolicyChanged");
    if (
      child !== undefined &&
      !workspaceSandboxAuthorizationWithinCeiling(child, head)
    )
      return deny("CeilingExceeded");
    lineage.push(head);
    if (
      head.origin.kind === "Human" ||
      head.origin.kind === "SystemInitialization"
    ) {
      const authorization = lineage[0];
      return authorization === undefined
        ? deny("InvalidFact")
        : { _tag: "Authorized", authorization, lineage };
    }
    if (workspace.parentWorkspaceId !== head.origin.parentWorkspaceId)
      return deny("ParentChanged");
    child = head;
    target = head.origin.parentWorkspaceId;
    expectedRevision = head.origin.parentAuthorizationRevision;
  }
};
