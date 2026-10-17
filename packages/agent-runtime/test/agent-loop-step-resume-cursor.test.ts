import type { ProviderTurnId } from "@arbor/domain";
import { ExecutionId, parse } from "@arbor/domain";
import type { AgentLoopStepRecord } from "@arbor/ports";
import { describe, expect, it } from "vitest";
import { selectInitialAgentLoopStepCursor } from "../src/agent-loop-driver.js";

const executionId = parse(ExecutionId)(
  "exe_00000000-0000-7000-8000-000000000001",
);

const step = (
  logicalStepNo: number,
  input: Partial<AgentLoopStepRecord> = {},
): AgentLoopStepRecord => ({
  identity: { executionId, logicalStepNo, repairAttempt: 0 },
  providerTurnId: `ptn_${executionId}_${logicalStepNo}` as ProviderTurnId,
  state: "Prepared",
  nextActionIndex: 0,
  revision: 0,
  updatedAt: "2026-10-17T00:00:00.000Z",
  ...input,
});

describe("P9 AgentLoopStep resume cursor", () => {
  it("starts a fresh Execution at step zero", () => {
    expect(selectInitialAgentLoopStepCursor([])).toEqual({
      logicalStepNo: 0,
      repairAttempt: 0,
    });
  });

  it("resumes the latest in-progress ActionsInProgress step and repair attempt", () => {
    const current = step(1, {
      identity: { executionId, logicalStepNo: 1, repairAttempt: 2 },
      predecessor: { executionId, logicalStepNo: 0, repairAttempt: 0 },
      providerTurnId: `ptn_${executionId}_1_r2` as ProviderTurnId,
      state: "ActionsInProgress",
      nextActionIndex: 0,
    });
    const predecessor = step(0, {
      state: "NextStepReady",
      successor: {
        executionId,
        logicalStepNo: 1,
        repairAttempt: 2,
        providerTurnId: current.providerTurnId,
      },
    });
    expect(selectInitialAgentLoopStepCursor([predecessor, current])).toEqual({
      logicalStepNo: 1,
      repairAttempt: 2,
    });
  });

  it("advances from a completed StepEffectsCommitted/NextStepReady predecessor to its exact successor", () => {
    const successor = step(1, {
      predecessor: { executionId, logicalStepNo: 0, repairAttempt: 0 },
      providerTurnId: `ptn_${executionId}_1` as ProviderTurnId,
    });
    const completedPredecessor = step(0, {
      state: "NextStepReady",
      successor: {
        executionId,
        logicalStepNo: 1,
        repairAttempt: 0,
        providerTurnId: successor.providerTurnId,
      },
    });
    expect(
      selectInitialAgentLoopStepCursor([completedPredecessor, successor]),
    ).toEqual({ logicalStepNo: 1, repairAttempt: 0 });
  });

  it.each([
    ["no active successor", [step(0, { state: "NextStepReady" })]],
    [
      "multiple active steps",
      [step(0), step(1, { state: "ActionsInProgress" })],
    ],
    ["missing predecessor binding", [step(1, { state: "ActionsInProgress" })]],
    [
      "mismatched successor provider turn",
      [
        step(0, {
          state: "NextStepReady",
          successor: {
            executionId,
            logicalStepNo: 1,
            repairAttempt: 0,
            providerTurnId: `ptn_${executionId}_9` as ProviderTurnId,
          },
        }),
        step(1, {
          predecessor: { executionId, logicalStepNo: 0, repairAttempt: 0 },
          state: "ActionsInProgress",
        }),
      ],
    ],
  ])("fails closed on %s", (_reason, records) => {
    expect(selectInitialAgentLoopStepCursor(records)).toBeUndefined();
  });
});
