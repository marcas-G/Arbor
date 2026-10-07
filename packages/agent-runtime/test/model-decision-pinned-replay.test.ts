import { describe, expect, it } from "vitest";
import { isPinnedSubmittedDecisionReplay } from "../src/model-decision.js";

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
    providerTurnId: "ptn_pinned",
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
  providerTurnId: "ptn_pinned",
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
    expect(
      isPinnedSubmittedDecisionReplay({
        ...input(),
        request: { ...input().request, workspaceId: "ws_other" },
      }),
    ).toBe(false);
  });

  it("fails closed when the settled Provider result Manifest differs from the pinned Step", () => {
    expect(
      isPinnedSubmittedDecisionReplay({
        ...input(),
        providerResult: {
          _tag: "SettledSuccess",
          manifestId: "manifest_other",
        },
      }),
    ).toBe(false);
  });
});
