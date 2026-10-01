import { describe, expect, it } from "vitest";
import {
  decideContextOverflowRecovery,
  nativeCheckpointCompatible,
  resolveBudgetEvidence,
} from "../src/budget-evidence.js";

describe("SCRC budget/native evidence", () => {
  it("uses the highest-grade available token evidence", () => {
    expect(
      resolveBudgetEvidence({
        providerObserved: 90,
        modelEstimate: 80,
        adapterEstimate: 70,
        fallbackText: "x".repeat(400),
      }),
    ).toEqual({ kind: "ProviderObserved", tokens: 90 });
    expect(
      resolveBudgetEvidence({
        modelEstimate: 80,
        adapterEstimate: 70,
        fallbackText: "x".repeat(400),
      }),
    ).toEqual({ kind: "ModelEstimator", tokens: 80 });
  });

  it("allows exactly one overflow recovery before durable output/effect", () => {
    expect(
      decideContextOverflowRecovery({
        recoveryAttempt: 0,
        durableAssistantOutput: false,
        durableEffect: false,
      }),
    ).toBe("CompactAndRetry");
    expect(
      decideContextOverflowRecovery({
        recoveryAttempt: 1,
        durableAssistantOutput: false,
        durableEffect: false,
      }),
    ).toBe("Stop");
    expect(
      decideContextOverflowRecovery({
        recoveryAttempt: 0,
        durableAssistantOutput: true,
        durableEffect: false,
      }),
    ).toBe("Stop");
  });

  it("falls back conservatively and scopes opaque checkpoints to one binding", () => {
    expect(resolveBudgetEvidence({ fallbackText: "x".repeat(400) })).toEqual({
      kind: "CharsPerFourFallback",
      tokens: 100,
    });
    expect(nativeCheckpointCompatible("binding-a", "binding-a")).toBe(true);
    expect(nativeCheckpointCompatible("binding-a", "binding-b")).toBe(false);
    expect(nativeCheckpointCompatible(undefined, "binding-a")).toBe(false);
  });
});
