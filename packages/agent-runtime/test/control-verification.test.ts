import type { ToolInvocation } from "@arbor/model-context";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeControlToolRegistry } from "../src/control.js";

const invocation = (
  toolName: string,
  argumentsJson: string,
): ToolInvocation => ({
  providerTurnId: "ptn_verify" as never,
  outputPosition: 0,
  callRef: "control_call",
  toolName,
  argumentsJson,
});

const handlers = [
  {
    action: "RecordVerificationEvidence" as const,
    handle: () =>
      Effect.succeed({
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: { text: "recorded", truncated: false },
      }),
  },
  {
    action: "ConcludeVerification" as const,
    handle: () =>
      Effect.succeed({
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: { text: "concluded", truncated: false },
      }),
  },
];

describe("verification control codecs", () => {
  it("decodes evidence selection without accepting canonical source fields", async () => {
    const registry = makeControlToolRegistry(handlers);
    const decoded = await Effect.runPromise(
      registry.decode(
        invocation(
          "arbor_record_verification_evidence",
          JSON.stringify({ criterionId: "focused-test", sourceCallRef: "c1" }),
        ),
      ),
    );
    expect(decoded.action).toEqual({
      _tag: "RecordVerificationEvidence",
      criterionId: "focused-test",
      sourceCallRef: "c1",
    });

    const forged = await Effect.runPromise(
      Effect.exit(
        registry.decode(
          invocation(
            "arbor_record_verification_evidence",
            JSON.stringify({
              criterionId: "focused-test",
              sourceCallRef: "c1",
              toolInvocationId: "tin_forged",
            }),
          ),
        ),
      ),
    );
    expect(forged._tag).toBe("Failure");
  });

  it("decodes a structured conclusion with summary content", async () => {
    const registry = makeControlToolRegistry(handlers);
    const decoded = await Effect.runPromise(
      registry.decode(
        invocation(
          "arbor_conclude_verification",
          JSON.stringify({
            verdict: "Pass",
            criteriaResults: [
              {
                criterionId: "focused-test",
                requirement: "focused test passes",
                required: true,
                verdict: "Pass",
                evidenceRefs: ["evd_00000000-0000-7000-8000-000000000001"],
              },
            ],
            summary: "All required checks passed.",
          }),
        ),
      ),
    );
    expect(decoded.action._tag).toBe("ConcludeVerification");
    if (decoded.action._tag === "ConcludeVerification") {
      expect(decoded.action.summary).toBe("All required checks passed.");
      expect(decoded.action.criteriaResults[0]?.verdict).toBe("Pass");
    }
  });
});
