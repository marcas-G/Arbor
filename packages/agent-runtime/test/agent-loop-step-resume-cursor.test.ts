import type { ProviderTurnId } from "@arbor/domain";
import { ExecutionId, parse, SessionId } from "@arbor/domain";
import type { AgentLoopStepRecord } from "@arbor/ports";
import { describe, expect, it } from "vitest";
import {
  isAgentLoopStepManifestBound,
  isPreparedStepAwaitingInitialManifest,
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

const rejectedForRetry = (
  parent: AgentLoopStepRecord,
  child: AgentLoopStepRecord,
) => ({
  ...successor(parent, child),
  state: "OutputRejected" as const,
  repairDisposition: {
    _tag: "Retry",
    successor: { ...child.identity, providerTurnId: child.providerTurnId },
  },
});

const exhaustedRepairDisposition = {
  _tag: "Exhausted",
  settlement: {
    _tag: "Failed",
    failure: { _tag: "ExecutionFailure", reason: "ModelOutputInvalid" },
  },
} as const;

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
      predecessor(rejectedForRetry(firstAttempt, secondAttempt), root),
      predecessor(rejectedForRetry(secondAttempt, current), firstAttempt),
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
      "OutputRejected terminal row without exhausted disposition",
      [step(0, 0, { state: "OutputRejected" })],
    ],
    [
      "OutputRejected terminal row with non-Exhausted disposition",
      [
        step(0, 0, {
          state: "OutputRejected",
          repairDisposition: { _tag: "Retry" },
        }),
      ],
    ],
    [
      "OutputRejected terminal row with malformed Exhausted settlement",
      [
        step(0, 0, {
          state: "OutputRejected",
          repairDisposition: {
            _tag: "Exhausted",
            settlement: { _tag: "Completed" },
          },
        }),
      ],
    ],
    [
      "OutputRejected exhausted terminal row with contradictory successor",
      [
        step(0, 0, {
          state: "OutputRejected",
          repairDisposition: exhaustedRepairDisposition,
          successor: {
            executionId,
            logicalStepNo: 1,
            repairAttempt: 0,
            providerTurnId: "ptn_contradictory" as ProviderTurnId,
          },
        }),
      ],
    ],
    [
      "OutputRejected skips the next repair attempt",
      [
        successor(step(0), step(1, 0)),
        predecessor(rejectedForRetry(step(1, 0), step(2, 0)), step(0)),
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

  it("resumes an exact repair-exhaustion frontier at the same step without a successor", () => {
    expect(
      selectInitialAgentLoopStepCursor([
        step(0, 0, {
          state: "OutputRejected",
          repairDisposition: exhaustedRepairDisposition,
        }),
      ]),
    ).toEqual({ logicalStepNo: 0, repairAttempt: 0 });
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
      ["providerTurnId", "ptn_exe_00000000-0000-7000-8000-000000000009_0"],
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

  it("defers manifest validation only for a fresh Prepared step before its first ProviderTurn", () => {
    const freshPrepared = step(0);
    expect(isPreparedStepAwaitingInitialManifest(freshPrepared, null)).toBe(
      true,
    );
    expect(
      isPreparedStepAwaitingInitialManifest(
        { ...freshPrepared, manifestId: "manifest-stale" },
        null,
      ),
    ).toBe(false);
    expect(
      isPreparedStepAwaitingInitialManifest(
        { ...freshPrepared, state: "ProviderResultAvailable" },
        null,
      ),
    ).toBe(false);
    expect(
      isPreparedStepAwaitingInitialManifest(freshPrepared, {
        manifestId: "manifest-other",
        manifestJson: "{}",
      }),
    ).toBe(false);
    const mismatchedManifest = {
      manifestId: "manifest-other",
      manifestJson: JSON.stringify({
        providerTurnId: "ptn_exe_00000000-0000-7000-8000-000000000009_0",
        executionId,
        sessionId: parse(SessionId)("ses_00000000-0000-7000-8000-000000000001"),
        logicalStepNo: 0,
        repairAttempt: 0,
      }),
    };
    const mayResume =
      isPreparedStepAwaitingInitialManifest(
        { ...freshPrepared, manifestId: "manifest-other" },
        null,
      ) ||
      isAgentLoopStepManifestBound(
        { ...freshPrepared, manifestId: "manifest-other" },
        executionId,
        parse(SessionId)("ses_00000000-0000-7000-8000-000000000001"),
        mismatchedManifest,
      );
    expect(mayResume).toBe(false);
  });
});
