import type { Problem } from "@arbor/api-contracts";
import type { ProjectionQueryError } from "@arbor/ports";
import type { TransportResponse } from "./contracts.js";

/**
 * P12 `10` §2/§8: error presentation uses the frozen `Problem` DTO (DID
 * §10.5). Consumers rely on the stable `code`, never parse `message`; the
 * transport therefore sets `message = code` (a stable, non-semantic string).
 */

export const makeProblem = (
  code: string,
  category: string,
  retryDisposition: string,
  safeDetails: Readonly<Record<string, unknown>> = {},
): Problem => ({
  code,
  category,
  message: code,
  correlationId: null,
  retryDisposition,
  safeDetails,
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

export const unknownViewProblem = (view: string): Problem =>
  makeProblem("transport/unknown-view", "not-found", "non-retryable", {
    view,
  });

export const authorityDeniedProblem = (reason: string): Problem =>
  makeProblem("authority/denied", "forbidden", "non-retryable", { reason });
