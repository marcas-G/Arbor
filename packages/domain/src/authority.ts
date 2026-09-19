import type { Principal } from "./actor.js";
import type {
  DecisionId,
  ExecutionId,
  PermissionGrantId,
  WorkspaceId,
} from "./ids.js";
import type { DomainResult } from "./result.js";
import { err, ok } from "./result.js";

export interface ResponsibilityBoundAgentBinding {
  readonly _tag: "ResponsibilityBoundAgentBinding";
  readonly workspaceId: WorkspaceId;
}

export interface ExecutionBoundAgentBinding {
  readonly _tag: "ExecutionBoundAgentBinding";
  readonly parentExecutionId: ExecutionId | null;
  readonly mission: string;
}

export type AgentBinding =
  | ResponsibilityBoundAgentBinding
  | ExecutionBoundAgentBinding;

export const responsibilityBound = (
  workspaceId: WorkspaceId,
): ResponsibilityBoundAgentBinding => ({
  _tag: "ResponsibilityBoundAgentBinding",
  workspaceId,
});

export const executionBound = (
  mission: string,
  parentExecutionId: ExecutionId | null = null,
): ExecutionBoundAgentBinding => ({
  _tag: "ExecutionBoundAgentBinding",
  parentExecutionId,
  mission,
});

export interface AgentProfile {
  readonly name: string;
  readonly configuration: Readonly<Record<string, unknown>>;
}

export type PermissionGrantLifecycle = "Active" | "Revoked";

export interface PermissionGrant {
  readonly permissionGrantId: PermissionGrantId;
  readonly scope: string;
  readonly issuer: Principal;
  readonly lifetime: string;
  readonly state: PermissionGrantLifecycle;
}

export interface GrantPermissionInput {
  readonly permissionGrantId: PermissionGrantId;
  readonly scope: string;
  readonly issuer: Principal;
  readonly lifetime: string;
}

export const grantPermission = (
  input: GrantPermissionInput,
): PermissionGrant => ({
  permissionGrantId: input.permissionGrantId,
  scope: input.scope,
  issuer: input.issuer,
  lifetime: input.lifetime,
  state: "Active",
});

export interface RevokePermissionInput {
  readonly authorized: boolean;
}

export const revokePermission = (
  grant: PermissionGrant,
  input: RevokePermissionInput,
): DomainResult<PermissionGrant> => {
  if (grant.state === "Revoked") {
    return err({
      _tag: "TerminalLifecycleMutation",
      entity: "PermissionGrant",
      lifecycle: "Revoked",
    });
  }
  if (!input.authorized) {
    return err({
      _tag: "AuthorityDenied",
      reason: "RevokePermission requires issuer/governance authority",
    });
  }
  return ok({ ...grant, state: "Revoked" });
};

export const isPermissionActive = (grant: PermissionGrant): boolean =>
  grant.state === "Active";

export interface Decision {
  readonly decisionId: DecisionId;
  readonly supersedes: DecisionId | null;
  readonly recordedAt: string;
}

export interface RecordDecisionInput {
  readonly decisionId: DecisionId;
  readonly supersedes: DecisionId | null;
  readonly recordedAt: string;
}

export const recordDecision = (input: RecordDecisionInput): Decision => ({
  ...input,
});
