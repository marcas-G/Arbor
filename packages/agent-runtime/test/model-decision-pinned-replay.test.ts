import { describe, expect, it } from "vitest";
import {
  classifySubmittedDecisionBindingFailure,
  isPinnedSubmittedDecisionReplay,
  isValidOverflowCompactionLinkPair,
} from "../src/model-decision.js";
import { planSubmittedDecisionStopClose } from "../src/submitted-decision-stop-close-plan.js";
import {
  fixtureExecutionProviderTurnId,
  fixtureSummaryCompactionProviderTurnId,
} from "./fixtures/provider-turn.js";

const replayProviderTurnId = "ptn_00000000-0000-7000-8000-000000000001";
const bindingExecutionId = "exe_00000000-0000-7000-8000-000000000003";
const recoveryExecutionId = "exe_00000000-0000-7000-8000-000000000004";
const recoveryInferenceId = fixtureExecutionProviderTurnId(recoveryExecutionId);
const recoveryCompactionId = fixtureSummaryCompactionProviderTurnId(
  recoveryExecutionId,
  0,
  0,
);
const otherRecoveryInferenceId = fixtureExecutionProviderTurnId(
  recoveryExecutionId,
  1,
);

const input = () => ({
  executionWorkspaceId: "ws_owner",
  episode: { decisionId: "dec_selection", requestRevision: 0 },
  request: {
    workspaceId: "ws_owner",
    candidateWorkIds: ["wrk_b", "wrk_c"],
    workspaceRevision: 10,
    revision: 1,
    state: { _tag: "Submitted" as const, selectedWorkId: "wrk_b" },
  },
  workspace: { currentWorkId: "wrk_b", revision: 11 },
  step: {
    providerTurnId: replayProviderTurnId,
    state: "ActionsInProgress" as const,
    nextActionIndex: 0,
    manifestId: "manifest_pinned",
    decodedOutputHash: "decoded-output-hash",
    modelOutputSessionSequence: 7,
  },
  pendingAction: {
    actionIndex: 0,
    routeKind: "Control" as const,
    actionKind: "select_current_work",
    state: "Pending" as const,
  },
  providerTurnId: replayProviderTurnId,
  providerResult: {
    _tag: "SettledSuccess" as const,
    manifestId: "manifest_pinned",
  },
});

describe("pinned Submitted DecisionRequest replay guard", () => {
  it("allows the exact submitted selection with its pinned settled Provider result", () => {
    expect(isPinnedSubmittedDecisionReplay(input())).toBe(true);
  });

  it("fails closed when the submitted DecisionRequest belongs to another Workspace", () => {
    const corrupted = {
      ...input(),
      request: { ...input().request, workspaceId: "ws_other" },
    };
    expect(isPinnedSubmittedDecisionReplay(corrupted)).toBe(false);
    expect(classifySubmittedDecisionBindingFailure(corrupted)).toBe(
      "DecisionRequestWorkspaceMismatch",
    );
  });

  it("fails closed when the settled Provider result Manifest differs from the pinned Step", () => {
    const corrupted = {
      ...input(),
      providerResult: {
        _tag: "SettledSuccess" as const,
        manifestId: "manifest_other",
      },
    };
    expect(isPinnedSubmittedDecisionReplay(corrupted)).toBe(false);
    expect(classifySubmittedDecisionBindingFailure(corrupted)).toBe(
      "StepManifestMismatch",
    );
  });

  it("does not classify an unrelated invalid replay as a binding mismatch", () => {
    expect(
      classifySubmittedDecisionBindingFailure({
        ...input(),
        pendingAction: {
          ...input().pendingAction,
          actionKind: "assign_work",
        },
        request: { ...input().request, workspaceId: "ws_other" },
      }),
    ).toBeUndefined();
  });
});

describe("Submitted DecisionEpisode Stop-only close plan", () => {
  it("terminalizes only the exact pending selection action and skips the remaining pinned actions", () => {
    const identity = {
      executionId: bindingExecutionId as never,
      logicalStepNo: 0,
      repairAttempt: 0,
    };
    const step = {
      identity,
      providerTurnId: fixtureExecutionProviderTurnId(bindingExecutionId),
      state: "ActionsInProgress" as const,
      nextActionIndex: 0,
      revision: 3,
      updatedAt: "t0",
    };
    const current = {
      identity,
      actionIndex: 0,
      logicalActionId: "lac_selection",
      callRef: "call_selection",
      routeKind: "Control" as const,
      actionKind: "select_current_work",
      inputHash: "selection-input",
      state: "Pending" as const,
      revision: 0,
      updatedAt: "t0",
    };
    const plan = planSubmittedDecisionStopClose({
      step,
      firstDetectedActionId: current.logicalActionId,
      updatedAt: "t1",
      actions: [
        { ...current, existing: current },
        {
          identity,
          actionIndex: 1,
          logicalActionId: "lac_later",
          callRef: "call_later",
          routeKind: "Control",
          actionKind: "wait",
          inputHash: "later-input",
        },
      ],
    });

    expect(plan._tag).toBe("Ready");
    if (plan._tag !== "Ready") return;
    expect(plan.step).toMatchObject({
      state: "SettlementProposed",
      nextActionIndex: 2,
      settlement: { _tag: "Interrupted", result: { _tag: "StopRequested" } },
    });
    expect(plan.actions.map((action) => action.state)).toEqual([
      "TerminalRejected",
      "SkippedEarlySettlement",
    ]);
    expect(plan.actions.map((action) => action.observationSourceRef)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("rejects a plan when the decoder-selected current action is not the exact pending selection", () => {
    const identity = {
      executionId: bindingExecutionId as never,
      logicalStepNo: 0,
      repairAttempt: 0,
    };
    const pending = {
      identity,
      actionIndex: 0,
      logicalActionId: "lac_other",
      callRef: "call_other",
      routeKind: "Control" as const,
      actionKind: "select_current_work",
      inputHash: "other-input",
      state: "Pending" as const,
      revision: 0,
      updatedAt: "t0",
    };
    expect(
      planSubmittedDecisionStopClose({
        step: {
          identity,
          providerTurnId: fixtureExecutionProviderTurnId(bindingExecutionId),
          state: "ActionsInProgress",
          nextActionIndex: 0,
          revision: 3,
          updatedAt: "t0",
        },
        firstDetectedActionId: "lac_selection",
        updatedAt: "t1",
        actions: [{ ...pending, existing: pending }],
      }),
    ).toEqual({ _tag: "InsufficientEvidence" });
  });
});

describe("overflow compaction recovery link guard", () => {
  it("accepts a compaction link that names the failed inference as predecessor", () => {
    const identity = {
      executionId: recoveryExecutionId as never,
      logicalStepNo: 0,
      repairAttempt: 0,
    };
    const links = [
      {
        identity,
        overflowOrdinal: 0 as const,
        role: "Inference" as const,
        providerTurnId: recoveryInferenceId,
        contextEpoch: 0 as never,
        state: "SettledFailure" as const,
        createdAt: "t0",
      },
      {
        identity,
        overflowOrdinal: 0 as const,
        role: "OverflowCompaction" as const,
        providerTurnId: recoveryCompactionId,
        predecessorProviderTurnId: recoveryInferenceId,
        contextEpoch: 0 as never,
        state: "Prepared" as const,
        createdAt: "t1",
      },
    ];
    expect(
      isValidOverflowCompactionLinkPair(
        links,
        recoveryInferenceId,
        recoveryCompactionId,
      ),
    ).toBe(true);
  });

  it("rejects an OverflowCompaction link whose predecessor is not the failed inference", () => {
    const identity = {
      executionId: recoveryExecutionId as never,
      logicalStepNo: 0,
      repairAttempt: 0,
    };
    const links = [
      {
        identity,
        overflowOrdinal: 0 as const,
        role: "Inference" as const,
        providerTurnId: recoveryInferenceId,
        contextEpoch: 0 as never,
        state: "SettledFailure" as const,
        createdAt: "t0",
      },
      {
        identity,
        overflowOrdinal: 0 as const,
        role: "OverflowCompaction" as const,
        providerTurnId: recoveryCompactionId,
        predecessorProviderTurnId: otherRecoveryInferenceId,
        contextEpoch: 0 as never,
        state: "Prepared" as const,
        createdAt: "t1",
      },
    ];
    expect(
      isValidOverflowCompactionLinkPair(
        links,
        recoveryInferenceId,
        recoveryCompactionId,
      ),
    ).toBe(false);
  });
});
