import type { ProviderTurnId } from "@arbor/domain";
import { ExecutionId, parse, SessionId } from "@arbor/domain";
import type { AgentLoopStepRecord } from "@arbor/ports";
import { describe, expect, it } from "vitest";
import {
  isAgentLoopStepManifestBound,
  selectInitialAgentLoopStepCursor,
} from "../src/agent-loop-driver.js";

const executionId = parse(ExecutionId)(
  "exe_00000000-0000-7000-8000-000000000001",
);

const step = (
  logicalStepNo: number,
  repairAttempt = 0,
  input: Partial<AgentLoopStepRecord> = {},
): AgentLoopStepRecord => ({
  identity: { executionId, logicalStepNo, repairAttempt },
  providerTurnId:
    `ptn_${executionId}_${logicalStepNo}_r${repairAttempt}` as ProviderTurnId,
  state: "Prepared",
  nextActionIndex: 0,
  revision: 0,
  updatedAt: "2026-10-17T00:00:00.000Z",
  ...input,
});

const successor = (
  parent: AgentLoopStepRecord,
  child: AgentLoopStepRecord,
) => ({
  ...parent,
  state: "NextStepReady" as const,
  successor: { ...child.identity, providerTurnId: child.providerTurnId },
});

const predecessor = (
  child: AgentLoopStepRecord,
  parent: AgentLoopStepRecord,
): AgentLoopStepRecord => ({ ...child, predecessor: parent.identity });

describe("P9 AgentLoopStep resume cursor", () => {
  it("starts a fresh Execution at step zero", () => {
    expect(selectInitialAgentLoopStepCursor([])).toEqual({
      logicalStepNo: 0,
      repairAttempt: 0,
    });
  });

  it("resumes the latest in-progress ActionsInProgress step and repair attempt", () => {
    const root = step(0);
    const firstAttempt = step(1, 0);
    const secondAttempt = step(1, 1);
    const current = step(1, 2, {
      state: "ActionsInProgress",
      nextActionIndex: 0,
    });
    const records = [
      successor(root, firstAttempt),
      predecessor(
        {
          ...successor(firstAttempt, secondAttempt),
          state: "OutputRejected" as const,
        },
        root,
      ),
      predecessor(
        {
          ...successor(secondAttempt, current),
          state: "OutputRejected" as const,
        },
        firstAttempt,
      ),
      predecessor(current, secondAttempt),
    ];
    expect(selectInitialAgentLoopStepCursor(records)).toEqual({
      logicalStepNo: 1,
      repairAttempt: 2,
    });
  });

  it("advances from a completed StepEffectsCommitted/NextStepReady predecessor to its exact successor", () => {
    const completedPredecessor = step(0);
    const next = step(1, 0, { state: "Prepared" });
    expect(
      selectInitialAgentLoopStepCursor([
        successor(completedPredecessor, next),
        predecessor(next, completedPredecessor),
      ]),
    ).toEqual({ logicalStepNo: 1, repairAttempt: 0 });
  });

  it.each([
    ["no active successor", [step(0, 0, { state: "NextStepReady" })]],
    [
      "multiple active steps",
      [step(0), step(1, 0, { state: "ActionsInProgress" })],
    ],
    [
      "missing predecessor binding",
      [step(1, 0, { state: "ActionsInProgress" })],
    ],
    [
      "mismatched successor provider turn",
      [
        step(0, 0, {
          state: "NextStepReady",
          successor: {
            executionId,
            logicalStepNo: 1,
            repairAttempt: 0,
            providerTurnId: `ptn_${executionId}_1_r9` as ProviderTurnId,
          },
        }),
        step(1, 0, {
          predecessor: { executionId, logicalStepNo: 0, repairAttempt: 0 },
          state: "ActionsInProgress",
        }),
      ],
    ],
    [
      "root with nonzero repair attempt",
      [step(0, 1, { state: "ActionsInProgress" })],
    ],
    [
      "OutputRejected skips the next repair attempt",
      [
        successor(step(0), step(1, 0)),
        predecessor(
          {
            ...successor(step(1, 0), step(2, 0)),
            state: "OutputRejected" as const,
          },
          step(0),
        ),
        predecessor(step(2, 0, { state: "ActionsInProgress" }), step(1, 0)),
      ],
    ],
    [
      "broken early chain despite an otherwise valid latest row",
      [
        step(0, 0, {
          state: "NextStepReady",
          successor: {
            executionId,
            logicalStepNo: 1,
            repairAttempt: 0,
            providerTurnId: `ptn_${executionId}_1_r0` as ProviderTurnId,
          },
        }),
        step(1, 0, {
          predecessor: { executionId, logicalStepNo: 0, repairAttempt: 0 },
          state: "NextStepReady",
          successor: {
            executionId,
            logicalStepNo: 3,
            repairAttempt: 0,
            providerTurnId: `ptn_${executionId}_3_r0` as ProviderTurnId,
          },
        }),
        step(2, 0, {
          predecessor: { executionId, logicalStepNo: 0, repairAttempt: 0 },
          state: "ActionsInProgress",
        }),
      ],
    ],
    [
      "forked successor chain",
      [
        successor(step(0), step(1, 0)),
        predecessor(step(1, 0), step(0)),
        predecessor(step(1, 1), step(0)),
      ],
    ],
    [
      "orphan row outside the valid chain",
      [
        successor(step(0), step(1, 0)),
        predecessor(step(1, 0), step(0)),
        step(3, 0, { state: "ActionsInProgress" }),
      ],
    ],
  ])("fails closed on %s", (_reason, records) => {
    expect(selectInitialAgentLoopStepCursor(records)).toBeUndefined();
  });

  it("validates a Prepared row against its persisted ProviderTurn manifest", () => {
    const prepared = step(0, 0, {
      state: "Prepared",
      manifestId: "manifest_prepared",
    });
    const sessionId = parse(SessionId)(
      "ses_00000000-0000-7000-8000-000000000001",
    );
    const manifestValue = {
      providerTurnId: prepared.providerTurnId,
      executionId,
      sessionId,
      logicalStepNo: 0,
      repairAttempt: 0,
    };
    const manifest = {
      manifestId: "manifest_prepared",
      manifestJson: JSON.stringify(manifestValue),
    };
    expect(
      isAgentLoopStepManifestBound(prepared, executionId, sessionId, manifest),
    ).toBe(true);
    for (const [field, value] of [
      ["providerTurnId", "ptn_wrong"],
      [
        "executionId",
        parse(ExecutionId)("exe_00000000-0000-7000-8000-000000000009"),
      ],
      [
        "sessionId",
        parse(SessionId)("ses_00000000-0000-7000-8000-000000000009"),
      ],
      ["logicalStepNo", 1],
      ["repairAttempt", 1],
    ] as const) {
      expect(
        isAgentLoopStepManifestBound(prepared, executionId, sessionId, {
          ...manifest,
          manifestJson: JSON.stringify({ ...manifestValue, [field]: value }),
        }),
      ).toBe(false);
    }
    expect(
      isAgentLoopStepManifestBound(prepared, executionId, sessionId, {
        ...manifest,
        manifestId: "manifest_other",
      }),
    ).toBe(false);
  });
});
