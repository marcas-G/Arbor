import { describe, expect, it } from "vitest";
import {
  persistenceCorruption,
  repositoryFailure,
} from "../src/repository-error.js";

describe("SQLite repository error translation", () => {
  it("translates unique violations into safe semantic constraint facts", () => {
    const translated = repositoryFailure(
      "VerificationRepository",
      "insert",
    )({
      _tag: "SqlError",
      reason: {
        _tag: "UniqueViolation",
        constraint: "verifications.work_id,target_work_revision",
      },
      isRetryable: false,
    });
    expect(translated).toEqual({
      _tag: "PersistenceConstraintViolation",
      repository: "VerificationRepository",
      operation: "insert",
      constraintKind: "Unique",
      constraint: "verifications.work_id,target_work_revision",
    });
    expect(translated).not.toHaveProperty("cause");
  });

  it("retains native cause only inside typed persistence unavailability", () => {
    const native = {
      _tag: "SqlError",
      reason: { _tag: "LockTimeoutError" },
      isRetryable: true,
    };
    expect(repositoryFailure("WorkRepository", "update")(native)).toEqual({
      _tag: "PersistenceUnavailable",
      repository: "WorkRepository",
      operation: "update",
      retryDisposition: "retryable",
      sourceTag: "LockTimeoutError",
      cause: native,
    });
  });

  it("represents decoded-row corruption without pretending it is availability", () => {
    expect(
      persistenceCorruption(
        "SessionRepository",
        "decode-entry",
        "invalid persisted item discriminator",
      ),
    ).toEqual({
      _tag: "PersistenceCorruption",
      repository: "SessionRepository",
      operation: "decode-entry",
      reason: "invalid persisted item discriminator",
    });
  });
});
