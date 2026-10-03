import { describe, expect, it } from "vitest";
import { safeEvidenceError } from "./capture.js";

describe("real-provider evidence error serialization", () => {
  it("preserves typed Effect failures and redacts credential-shaped fields", () => {
    expect(
      safeEvidenceError({
        _tag: "ProviderFailure",
        kind: "RequestRejected",
        safeDiagnostic: "invalid_request_error",
        apiKey: "must-not-leak",
      }),
    ).toBe(
      '{"_tag":"ProviderFailure","kind":"RequestRejected","safeDiagnostic":"invalid_request_error","apiKey":"[REDACTED]"}',
    );
  });
});
