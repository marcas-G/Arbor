export const DOMAIN_ERROR_TAGS = [
  "IdempotencyConflict",
  "AuthorityDenied",
  "RevisionConflict",
  "WorkNotOpen",
  "TerminalLifecycleMutation",
  "RetirePreconditionFailed",
  "ActiveExecutionConflict",
  "VerificationAcceptanceMismatch",
  "DependencyNotSatisfiable",
  "PermissionRevoked",
] as const;

export type DomainErrorTag = (typeof DOMAIN_ERROR_TAGS)[number];

export type DomainError =
  | { readonly _tag: "IdempotencyConflict"; readonly commandId: string }
  | { readonly _tag: "AuthorityDenied"; readonly reason: string }
  | {
      readonly _tag: "RevisionConflict";
      readonly expected: number;
      readonly actual: number;
    }
  | { readonly _tag: "WorkNotOpen"; readonly workId: string }
  | {
      readonly _tag: "TerminalLifecycleMutation";
      readonly entity: string;
      readonly lifecycle: string;
    }
  | {
      readonly _tag: "RetirePreconditionFailed";
      readonly workspaceId: string;
      readonly reason: string;
    }
  | { readonly _tag: "ActiveExecutionConflict"; readonly workspaceId: string }
  | {
      readonly _tag: "VerificationAcceptanceMismatch";
      readonly workId: string;
    }
  | {
      readonly _tag: "DependencyNotSatisfiable";
      readonly dependencyId: string;
    }
  | {
      readonly _tag: "PermissionRevoked";
      readonly permissionGrantId: string;
    };

export const isDomainErrorTag = (value: unknown): value is DomainErrorTag =>
  typeof value === "string" &&
  (DOMAIN_ERROR_TAGS as readonly string[]).includes(value);

export const FAILURE_DISPOSITIONS = [
  "ReturnToCaller",
  "RetrySameLogicalCommand",
  "RetryWithBackoff",
  "WaitForStateChange",
  "ReconcileBeforeRetry",
  "SettleExecutionFailed",
  "SettleExecutionOutcomeUnknown",
  "EscalateAttention",
] as const;

export type FailureDisposition = (typeof FAILURE_DISPOSITIONS)[number];

export const isFailureDisposition = (
  value: unknown,
): value is FailureDisposition =>
  typeof value === "string" &&
  (FAILURE_DISPOSITIONS as readonly string[]).includes(value);
