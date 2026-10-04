import type { ToolInvocation } from "@arbor/model-context";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decodeControlInvocation } from "../src/control-decoder.js";

const invocation = (condition: unknown): ToolInvocation => ({
  providerTurnId: "ptn_wait" as never,
  outputPosition: 0,
  callRef: "wait-call",
  toolName: "wait",
  argumentsJson: JSON.stringify({
    reason: "await exact state change",
    waitSpec: { mode: "Any", conditions: [condition] },
  }),
});

describe("wait control revision decoding", () => {
  it.each([
    {
      _tag: "DependencyChanged",
      dependencyId: "dep_11111111-1111-7111-8111-111111111111",
      observedRevision: 0,
    },
    {
      _tag: "DecisionChanged",
      decisionId: "dec_11111111-1111-7111-8111-111111111111",
      observedRevision: 2,
    },
    {
      _tag: "VerificationChanged",
      workId: "wrk_11111111-1111-7111-8111-111111111111",
      targetWorkRevision: 0,
    },
  ])("accepts numeric revisions in $._tag", async (condition) => {
    const decoded = await Effect.runPromise(
      decodeControlInvocation(invocation(condition)),
    );
    expect(decoded.action).toMatchObject({
      _tag: "Wait",
      waitSpec: { conditions: [condition] },
    });
  });

  it("rejects a string where the contract requires a numeric revision", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        decodeControlInvocation(
          invocation({
            _tag: "DependencyChanged",
            dependencyId: "dep_11111111-1111-7111-8111-111111111111",
            observedRevision: "0",
          }),
        ),
      ),
    );
    expect(failure).toMatchObject({ _tag: "InvalidControlArguments" });
  });
});
