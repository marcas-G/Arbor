import { describe, expect, it } from "vitest";
import { classifySettledDecisionPendingActionAudit } from "../packages/execution-runtime/src/recovery.js";

const base = () => {
  const identity = {
    executionId: "exe_legacy" as never,
    logicalStepNo: 3,
    repairAttempt: 0,
  };
  const step = {
    identity,
    providerTurnId: "ptn_legacy" as never,
    manifestId: "manifest_step",
    state: "ActionsInProgress" as const,
    nextActionIndex: 0,
    revision: 4,
    updatedAt: "t0",
  };
  const action = {
    identity,
    actionIndex: 0,
    logicalActionId: "lac_legacy_selection",
    callRef: "call_selection",
    routeKind: "Control" as const,
    actionKind: "select_current_work",
    inputHash: "input-hash",
    state: "Pending" as const,
    revision: 0,
    updatedAt: "t0",
  };
  return {
    executionId: "exe_legacy",
    executionWorkspaceId: "ws_owner",
    decisionRequestRevision: 0,
    step,
    action,
    request: {
      decisionId: "dec_legacy" as never,
      workspaceId: "ws_owner" as never,
      candidateWorkIds: ["wrk_selected" as never],
      workspaceRevision: 9,
      state: {
        _tag: "Submitted" as const,
        selectedWorkId: "wrk_selected" as never,
      },
      revision: 1,
      createdAt: "t0",
      updatedAt: "t1",
    },
    settledProviderManifestId: "manifest_step",
  };
};

describe("P41 legacy settled DecisionEpisode orphan audit", () => {
  it("preserves a still-provable submitted Workspace mismatch", () => {
    expect(
      classifySettledDecisionPendingActionAudit({
        ...base(),
        request: { ...base().request, workspaceId: "ws_foreign" as never },
      }),
    ).toBe("DecisionRequestWorkspaceMismatch");
  });

  it("preserves a still-provable settled Provider Manifest mismatch", () => {
    expect(
      classifySettledDecisionPendingActionAudit({
        ...base(),
        settledProviderManifestId: "manifest_provider",
      }),
    ).toBe("StepManifestMismatch");
  });

  it("uses audit-only fallback after the mismatch evidence was repaired", () => {
    expect(classifySettledDecisionPendingActionAudit(base())).toBe(
      "SettledExecutionWithPendingDecisionAction",
    );
  });

  it("ignores rows outside the exact ActionsInProgress cursor-Pending trigger", () => {
    const input = base();
    expect(
      classifySettledDecisionPendingActionAudit({
        ...input,
        action: { ...input.action, state: "Applied" },
      }),
    ).toBeUndefined();
  });
});
