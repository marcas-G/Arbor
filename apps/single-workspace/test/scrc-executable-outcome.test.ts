import { describe, expect, it } from "vitest";
import { toExecutableOutcome } from "../src/executable-tool-handler.js";

describe("SCRC executable outcome taxonomy", () => {
  it.each([
    [
      {
        _tag: "Success" as const,
        observation: { text: "ok", truncated: false },
        resultRef: "artifact:full",
      },
      "Succeeded",
    ],
    [
      {
        _tag: "ExpectedFailure" as const,
        observation: { text: "bad input", truncated: false },
      },
      "Failed",
    ],
    [{ _tag: "Denied" as const, reason: "policy" }, "Denied"],
    [{ _tag: "Interrupted" as const }, "Interrupted"],
    [
      {
        _tag: "OutcomeUnknown" as const,
        reconciliationRefs: ["tin_unknown"],
      },
      "OutcomeUnknown",
    ],
    [{ _tag: "RuntimeFailure" as const, cause: "defect" }, "Failed"],
  ])("maps %s to typed status %s", (input, status) => {
    const outcome = toExecutableOutcome(input);
    expect(outcome).toMatchObject({ _tag: "Observation", status });
  });

  it("keeps the complete result reference when the model observation is bounded", () => {
    expect(
      toExecutableOutcome({
        _tag: "Success",
        observation: { text: "excerpt", truncated: true },
        resultRef: "artifact:full",
      }),
    ).toMatchObject({
      status: "Succeeded",
      resultRef: "artifact:full",
      artifactRefs: ["artifact:full"],
      observation: { text: "excerpt", truncated: true },
    });
  });
});
