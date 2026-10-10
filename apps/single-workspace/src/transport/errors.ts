import type { Problem } from "@arbor/api-contracts";
import type { ProjectionQueryError } from "@arbor/ports";
import type { TransportResponse } from "./contracts.js";

/**
 * P12 `10` §2/§8: error presentation uses the frozen `Problem` DTO (DID
 * §10.5). Consumers rely on the stable `code`, never parse `message`; the
 * transport therefore sets `message = code` (a stable, non-semantic string).
 */

const SENSITIVE_DETAIL_KEY =
  /authorization|api[-_]?key|secret|credential|password|token|cookie|cause|stack/iu;

const sanitizeDetailValue = (value: unknown, depth: number): unknown => {
  if (depth > 4) return "[TRUNCATED]";
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((entry) => sanitizeDetailValue(entry, depth + 1));
  }
  if (typeof value !== "object" || value === null) return String(value);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 30)) {
    result[key] = SENSITIVE_DETAIL_KEY.test(key)
      ? "[REDACTED]"
      : sanitizeDetailValue(entry, depth + 1);
  }
  return result;
};

export const sanitizeSafeDetails = (
  details: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> =>
  sanitizeDetailValue(details, 0) as Readonly<Record<string, unknown>>;

const tagOf = (value: unknown): string =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  typeof value._tag === "string"
    ? value._tag
    : "UnknownFailure";

const recordOf = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

export const makeProblem = (
  code: string,
  category: string,
  retryDisposition: Problem["retryDisposition"],
  safeDetails: Readonly<Record<string, unknown>> = {},
): Problem => ({
  code,
  category,
  message: code,
  correlationId: null,
  retryDisposition,
  safeDetails: sanitizeSafeDetails(safeDetails),
});

/** The projection error already carries the frozen Problem vocabulary (P10
 * `05` §1); the transport only drops the internal `_tag`. */
export const problemFromProjectionError = (
  error: ProjectionQueryError,
): Problem => ({
  code: error.code,
  category: error.category,
  message: error.code,
  correlationId: error.correlationId,
  retryDisposition: error.retryDisposition,
  safeDetails: error.safeDetails,
});

export const statusForCategory = (category: string): number => {
  switch (category) {
    case "invalid-request":
    case "validation":
      return 400;
    case "unauthenticated":
      return 401;
    case "forbidden":
      return 403;
    case "not-found":
      return 404;
    case "stale":
      return 409;
    default:
      return 503;
  }
};

export const failureResponse = (
  problem: Problem,
): TransportResponse<never> => ({
  ok: false,
  status: statusForCategory(problem.category),
  problem,
});

export const unauthenticatedProblem = (): Problem =>
  makeProblem("auth/unauthenticated", "unauthenticated", "non-retryable");

export const invalidCommandProblem = (detail: string): Problem =>
  makeProblem("transport/invalid-request", "invalid-request", "non-retryable", {
    detail,
  });

export interface InvalidCommandPayloadIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly rule:
    | "required"
    | "type"
    | "format"
    | "range"
    | "enum"
    | "unknown-field"
    | "unsupported-command";
}

export const invalidCommandPayloadProblem = (input: {
  readonly commandType?: string;
  readonly issues: ReadonlyArray<InvalidCommandPayloadIssue>;
}): Problem => ({
  code: "InvalidCommandPayload",
  category: "validation",
  message: "Command payload is invalid",
  correlationId: null,
  retryDisposition: "non-retryable",
  safeDetails: {
    ...(input.commandType !== undefined
      ? { commandType: input.commandType }
      : {}),
    issues: input.issues.map((issue) => ({
      path: [...issue.path],
      rule: issue.rule,
    })),
  },
});

export const unknownViewProblem = (view: string): Problem =>
  makeProblem("transport/unknown-view", "not-found", "non-retryable", {
    view,
  });

export const authorityDeniedProblem = (reason: string): Problem =>
  makeProblem("authority/denied", "forbidden", "non-retryable", { reason });

export const problemFromCommandFailure = (error: unknown): Problem => {
  const record = recordOf(error);
  switch (tagOf(error)) {
    case "PersistenceUnavailable": {
      const retryDisposition =
        record?.retryDisposition === "non-retryable"
          ? "non-retryable"
          : "retryable";
      return makeProblem(
        "persistence/unavailable",
        "unavailable",
        retryDisposition,
        {
          repository: String(record?.repository ?? "unknown"),
          operation: String(record?.operation ?? "unknown"),
          sourceTag: String(record?.sourceTag ?? "UnknownPersistenceFailure"),
        },
      );
    }
    case "PersistenceConstraintViolation":
      return makeProblem("persistence/constraint", "stale", "non-retryable", {
        repository: String(record?.repository ?? "unknown"),
        operation: String(record?.operation ?? "unknown"),
        constraintKind: String(record?.constraintKind ?? "Constraint"),
        constraint: String(record?.constraint ?? "unknown"),
      });
    case "PersistenceCorruption":
      return makeProblem(
        "persistence/corruption",
        "unavailable",
        "non-retryable",
        {
          repository: String(record?.repository ?? "unknown"),
          operation: String(record?.operation ?? "unknown"),
          reason: String(record?.reason ?? "invalid persisted state"),
        },
      );
    case "TransactionOperationalFailure":
      return makeProblem(
        "persistence/transaction-unavailable",
        "unavailable",
        "retryable",
      );
    default:
      return makeProblem(
        "command/gateway-failure",
        "unavailable",
        "retryable",
        { sourceTag: tagOf(error) },
      );
  }
};

export const problemFromUnknownFailure = (
  code: string,
  failure: unknown,
): Problem =>
  makeProblem(code, "unavailable", "retryable", {
    sourceTag: tagOf(failure),
  });
