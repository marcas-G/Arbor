import type { ToolInvocation } from "@arbor/model-context";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decodeControlInvocation } from "../src/control-decoder.js";

const invocation = (argumentsJson: string): ToolInvocation => ({
  providerTurnId: "ptn_assign" as never,
  outputPosition: 0,
  callRef: "assign-call",
  toolName: "assign_work",
  argumentsJson,
});

const valid = {
  objective: "produce the release report",
  why: "the parent milestone needs an independently verifiable report",
  constraints: ["read-only evidence"],
  completionExpectation: "a report with exact evidence references",
  verificationMission: {
    goal: "verify the report",
    criteria: [
      {
        criterionId: "report-exists",
        requirement: "the report exists and cites evidence",
        required: true,
      },
    ],
    riskRequirements: ["do not accept uncited claims"],
  },
  reason: "delegate a bounded outcome from the current parent Work",
};

describe("assign_work control codec", () => {
  it("decodes only model-authored semantics", async () => {
    const decoded = await Effect.runPromise(
      decodeControlInvocation(invocation(JSON.stringify(valid))),
    );
    expect(decoded.action).toEqual({ _tag: "AssignWork", ...valid });
    expect(decoded.action).not.toHaveProperty("workId");
    expect(decoded.action).not.toHaveProperty("predecessorWorkId");
    expect(decoded.action).not.toHaveProperty("revision");
  });

  it("accepts an opaque placement ref and rejects simultaneous legacy raw id", async () => {
    const decoded = await Effect.runPromise(
      decodeControlInvocation(
        invocation(
          JSON.stringify({ ...valid, targetWorkspaceRef: "wref_abc" }),
        ),
      ),
    );
    expect(decoded.action).toMatchObject({
      _tag: "AssignWork",
      targetWorkspaceRef: "wref_abc",
    });
    const failure = await Effect.runPromise(
      Effect.flip(
        decodeControlInvocation(
          invocation(
            JSON.stringify({
              ...valid,
              targetWorkspaceRef: "wref_abc",
              targetWorkspaceId: "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
            }),
          ),
        ),
      ),
    );
    expect(failure).toMatchObject({ _tag: "InvalidControlArguments" });
  });

  it("rejects a mission without a required criterion", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        decodeControlInvocation(
          invocation(
            JSON.stringify({
              ...valid,
              verificationMission: {
                ...valid.verificationMission,
                criteria: [
                  {
                    criterionId: "optional",
                    requirement: "optional only",
                    required: false,
                  },
                ],
              },
            }),
          ),
        ),
      ),
    );
    expect(failure._tag).toBe("InvalidControlArguments");
  });
});
