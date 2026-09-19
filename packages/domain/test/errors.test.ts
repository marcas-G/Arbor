import { describe, expect, it } from "vitest";
import type { DomainError, FailureDisposition } from "../src/index.js";
import * as domain from "../src/index.js";
import {
  DOMAIN_ERROR_TAGS,
  FAILURE_DISPOSITIONS,
  isDomainErrorTag,
  isFailureDisposition,
} from "../src/index.js";

const EXPECTED_ERROR_TAGS = [
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
].sort();

const EXPECTED_DISPOSITIONS = [
  "ReturnToCaller",
  "RetrySameLogicalCommand",
  "RetryWithBackoff",
  "WaitForStateChange",
  "ReconcileBeforeRetry",
  "SettleExecutionFailed",
  "SettleExecutionOutcomeUnknown",
  "EscalateAttention",
].sort();

const describeError = (error: DomainError): string => {
  switch (error._tag) {
    case "IdempotencyConflict":
      return `idempotency:${error.commandId}`;
    case "AuthorityDenied":
      return `authority:${error.reason}`;
    case "RevisionConflict":
      return `revision:${error.expected}/${error.actual}`;
    case "WorkNotOpen":
      return `work:${error.workId}`;
    case "TerminalLifecycleMutation":
      return `terminal:${error.entity}/${error.lifecycle}`;
    case "RetirePreconditionFailed":
      return `retire:${error.workspaceId}/${error.reason}`;
    case "ActiveExecutionConflict":
      return `active:${error.workspaceId}`;
    case "VerificationAcceptanceMismatch":
      return `verification:${error.workId}`;
    case "DependencyNotSatisfiable":
      return `dependency:${error.dependencyId}`;
    case "PermissionRevoked":
      return `permission:${error.permissionGrantId}`;
    default: {
      const unreachable: never = error;
      return unreachable;
    }
  }
};

const describeDisposition = (disposition: FailureDisposition): number => {
  switch (disposition) {
    case "ReturnToCaller":
      return 0;
    case "RetrySameLogicalCommand":
      return 1;
    case "RetryWithBackoff":
      return 2;
    case "WaitForStateChange":
      return 3;
    case "ReconcileBeforeRetry":
      return 4;
    case "SettleExecutionFailed":
      return 5;
    case "SettleExecutionOutcomeUnknown":
      return 6;
    case "EscalateAttention":
      return 7;
    default: {
      const unreachable: never = disposition;
      return unreachable;
    }
  }
};

describe("domain error algebra", () => {
  it("exposes the frozen rejection tag set (closed union)", () => {
    expect([...DOMAIN_ERROR_TAGS].sort()).toEqual(EXPECTED_ERROR_TAGS);
    expect(DOMAIN_ERROR_TAGS).toContain("IdempotencyConflict");
    expect(DOMAIN_ERROR_TAGS).toContain("AuthorityDenied");
    expect(DOMAIN_ERROR_TAGS).toContain("RevisionConflict");
  });

  it("exposes exactly the 8 frozen FailureDisposition variants", () => {
    expect([...FAILURE_DISPOSITIONS].sort()).toEqual(EXPECTED_DISPOSITIONS);
    expect(FAILURE_DISPOSITIONS).toHaveLength(8);
  });

  it("keeps normal alternatives and control results out of the error set", () => {
    for (const nonError of [
      "OutcomeUnknown",
      "Blocked",
      "Unknown",
      "GovernanceBlocked",
      "Interrupted",
    ]) {
      expect(isDomainErrorTag(nonError)).toBe(false);
    }
  });

  it("exhaustively handles every DomainError tag", () => {
    const error: DomainError = {
      _tag: "RevisionConflict",
      expected: 1,
      actual: 2,
    };
    expect(describeError(error)).toBe("revision:1/2");
  });

  it("exhaustively handles every FailureDisposition", () => {
    expect(describeDisposition("EscalateAttention")).toBe(7);
  });

  it("guards valid tags and rejects unknown values", () => {
    expect(isDomainErrorTag("WorkNotOpen")).toBe(true);
    expect(isDomainErrorTag("NotARealError")).toBe(false);
    expect(isFailureDisposition("ReturnToCaller")).toBe(true);
    expect(isFailureDisposition("MaybeRetry")).toBe(false);
  });

  it("does not export a universal ArborError or base error class", () => {
    expect("ArborError" in domain).toBe(false);
    expect("DomainError" in domain).toBe(false);
  });

  it("type-level: an unlisted failure cannot be constructed", () => {
    // @ts-expect-error "NotARealError" is not a DomainError tag
    const bogus: DomainError = { _tag: "NotARealError" };
    void bogus;
  });
});
