import { describe, expect, it } from "vitest";
import {
  makeProblem,
  problemFromCommandFailure,
  problemFromUnknownFailure,
} from "../src/transport/errors.js";

describe("typed Problem presentation", () => {
  it("redacts native/sensitive details and bounds strings recursively", () => {
    const problem = makeProblem("test/failure", "unavailable", "retryable", {
      operation: "test",
      apiKey: "secret-value",
      nested: {
        cause: { message: "native database error" },
        stack: "native stack",
        safe: "x".repeat(700),
      },
    });
    expect(problem.safeDetails).toMatchObject({
      operation: "test",
      apiKey: "[REDACTED]",
      nested: {
        cause: "[REDACTED]",
        stack: "[REDACTED]",
      },
    });
    expect(
      (problem.safeDetails.nested as { readonly safe: string }).safe.length,
    ).toBeLessThanOrEqual(501);
    expect(JSON.stringify(problem)).not.toContain("secret-value");
    expect(JSON.stringify(problem)).not.toContain("native database error");
  });

  it("maps persistence unavailability without exposing its native cause", () => {
    const problem = problemFromCommandFailure({
      _tag: "PersistenceUnavailable",
      repository: "WorkRepository",
      operation: "update",
      retryDisposition: "retryable",
      sourceTag: "LockTimeoutError",
      cause: { password: "hidden", stack: "native" },
    });
    expect(problem).toEqual({
      code: "persistence/unavailable",
      category: "unavailable",
      message: "persistence/unavailable",
      correlationId: null,
      retryDisposition: "retryable",
      safeDetails: {
        repository: "WorkRepository",
        operation: "update",
        sourceTag: "LockTimeoutError",
      },
    });
  });

  it("maps semantic constraints separately from terminal command rejection", () => {
    const problem = problemFromCommandFailure({
      _tag: "PersistenceConstraintViolation",
      repository: "VerificationRepository",
      operation: "insert",
      constraintKind: "Unique",
      constraint: "one-open-verification",
    });
    expect(problem).toMatchObject({
      code: "persistence/constraint",
      category: "stale",
      retryDisposition: "non-retryable",
    });
  });

  it("reduces unknown post-commit failure to its safe tag", () => {
    const problem = problemFromUnknownFailure(
      "command/post-commit-convergence-failure",
      {
        _tag: "WorkflowSignalUnavailable",
        cause: { authorization: "Bearer secret" },
      },
    );
    expect(problem.safeDetails).toEqual({
      sourceTag: "WorkflowSignalUnavailable",
    });
    expect(JSON.stringify(problem)).not.toContain("Bearer secret");
  });
});
