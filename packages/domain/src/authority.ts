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

export type PermissionSubject =
  | { readonly _tag: "HumanPrincipal"; readonly principal: Principal }
  | { readonly _tag: "WorkspaceAgent"; readonly workspaceId: WorkspaceId }
  | { readonly _tag: "Execution"; readonly executionId: ExecutionId };

export interface PermissionGrant {
  readonly permissionGrantId: PermissionGrantId;
  readonly scope: string;
  readonly issuer: Principal;
  readonly lifetime: string;
  /** CAPA v2. Missing means a migrated legacy grant and never authorizes. */
  readonly subject?: PermissionSubject;
  readonly capability?: string;
  readonly target?: string | null;
  readonly validFrom?: string;
  readonly expiresAt?: string | null;
  readonly revision?: number;
  readonly state: PermissionGrantLifecycle;
}

export interface GrantPermissionInput {
  readonly permissionGrantId: PermissionGrantId;
  readonly scope: string;
  readonly issuer: Principal;
  readonly lifetime: string;
  readonly subject: PermissionSubject;
  readonly capability: string;
  readonly target: string;
  readonly validFrom: string;
  readonly expiresAt: string;
  readonly revision: number;
}

/** RFC 3339 timestamp with an explicit timezone and valid calendar fields. */
export const isIsoTimestamp = (value: string): boolean => {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(
      value,
    );
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  return (
    year > 0 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (daysInMonth[month - 1] ?? 0) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
};

export const grantPermission = (
  input: GrantPermissionInput,
): DomainResult<PermissionGrant> => {
  if (
    input.capability.trim().length === 0 ||
    input.capability !== input.capability.trim() ||
    input.target.trim().length === 0 ||
    input.target !== input.target.trim() ||
    !isIsoTimestamp(input.validFrom) ||
    !isIsoTimestamp(input.expiresAt) ||
    Date.parse(input.expiresAt) <= Date.parse(input.validFrom)
  ) {
    return err({
      _tag: "AuthorityDenied",
      reason:
        "PermissionGrant v2 requires a non-empty capability, exact target, and future validity window",
    });
  }

  return ok({
    permissionGrantId: input.permissionGrantId,
    scope: input.scope,
    issuer: input.issuer,
    lifetime: input.lifetime,
    subject: input.subject,
    capability: input.capability,
    target: input.target,
    validFrom: input.validFrom,
    expiresAt: input.expiresAt,
    revision: input.revision,
    state: "Active",
  });
};

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
