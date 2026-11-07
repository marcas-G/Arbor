import { ExecutionId, ProviderTurnId, parse } from "@arbor/domain";
import { describe, expect, it } from "vitest";
import { decideDurableRecovery } from "../src/recovery-decision.js";

const step = (
  state: "Prepared" | "OutputRejected" | "NextStepReady" | "SettlementProposed",
) => ({
  identity: {
    executionId: parse(ExecutionId)("exe_00000000-0000-7000-8000-0000000000a1"),
    logicalStepNo: 0,
    repairAttempt: 0,
  },
  providerTurnId: parse(ProviderTurnId)(
    "ptn_00000000-0000-7000-8000-0000000000a1",
  ),
  state,
  nextActionIndex: 0,
  revision: 0,
  updatedAt: "t",
});

describe("durable recovery decision", () => {
  it("publishes a settled success", () =>
    expect(
      decideDurableRecovery({
        step: step("Prepared"),
        providerResult: "SettledSuccess",
      }),
    ).toMatchObject({ _tag: "PublishProviderResult" }));
  it("requires a successor after output rejection", () =>
    expect(
      decideDurableRecovery({
        step: step("OutputRejected"),
        providerResult: "NotFound",
      }),
    ).toEqual({
      _tag: "RepairRequired",
      reason: "OutputRejectedWithoutSuccessor",
    }));
  it("settles only a persisted proposal", () =>
    expect(
      decideDurableRecovery({
        step: {
          ...step("SettlementProposed"),
          settlement: { _tag: "Interrupted", reason: "x" } as never,
        },
        providerResult: "SettledFailure",
      }),
    ).toEqual({ _tag: "Settle", reason: "PersistedProposal" }));
});
