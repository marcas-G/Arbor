import { describe, expect, it } from "vitest";
import type {
  Execution,
  ExecutionBinding,
  ExecutionSettlement,
  WorkspaceExecution,
} from "../src/index.js";
import {
  admitExecution,
  ExecutionId,
  executionBound,
  isExecutionActive,
  isExecutionSettled,
  ProjectId,
  parse,
  SessionId,
  settleExecution,
  stopExecution,
  WorkId,
  WorkRevision,
  WorkspaceId,
  workspaceExecution,
} from "../src/index.js";

const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789ab");
const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789ab");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);

const workBinding: WorkspaceExecution = workspaceExecution(workspaceId, {
  _tag: "Work",
  workId,
});

const admit = (
  binding: ExecutionBinding = workBinding,
  noOtherActiveMain = true,
): Execution => {
  const result = admitExecution({
    executionId,
    projectId,
    binding,
    sessionId,
    admittedAt: "2026-09-20T00:00:00.000Z",
    noOtherActiveMain,
  });
  if (!result.ok) {
    throw new Error("expected admit to succeed");
  }
  return result.value;
};

const describeSettlement = (settlement: ExecutionSettlement): string => {
  switch (settlement._tag) {
    case "Completed":
      return `completed:${settlement.result._tag}`;
    case "Interrupted":
      return `interrupted:${settlement.result._tag}`;
    case "Failed":
      return `failed:${settlement.failure.reason}`;
    case "OutcomeUnknown":
      return `unknown:${settlement.reconciliation.invocationRefs.length}`;
    default: {
      const unreachable: never = settlement;
      return unreachable;
    }
  }
};

describe("execution binding & settlement", () => {
  it("admits a Workspace main execution when no other active main exists", () => {
    const execution = admit();
    expect(isExecutionActive(execution)).toBe(true);
    expect(execution.sessionId).toBe(sessionId);
    expect(execution.binding._tag).toBe("WorkspaceExecution");
  });

  it("rejects a Workspace main execution when another active main exists", () => {
    const result = admitExecution({
      executionId,
      projectId,
      binding: workBinding,
      sessionId,
      admittedAt: "2026-09-20T00:00:00.000Z",
      noOtherActiveMain: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe("ActiveExecutionConflict");
    }
  });

  it("admits a coordination focus and an execution-bound agent", () => {
    const coordination = admit(
      workspaceExecution(workspaceId, { _tag: "Coordination" }),
    );
    expect(coordination.binding._tag).toBe("WorkspaceExecution");
    const bound = admit(executionBound("verify"), false);
    expect(bound.binding._tag).toBe("ExecutionBoundAgentBinding");
  });

  it("records a stop request without settling", () => {
    const stopped = stopExecution(admit());
    expect(stopped.ok).toBe(true);
    if (stopped.ok) {
      expect(stopped.value.stopRequested).toBe(true);
      expect(isExecutionActive(stopped.value)).toBe(true);
    }
  });

  it("settles once and rejects settling again", () => {
    const execution = admit();
    const settlement: ExecutionSettlement = {
      _tag: "Completed",
      result: {
        _tag: "CompletionClaimed",
        workRevision: parse(WorkRevision)(7),
        claimRef: "claim-1",
      },
    };
    const settled = settleExecution(execution, settlement);
    expect(settled.ok).toBe(true);
    if (settled.ok) {
      expect(isExecutionSettled(settled.value)).toBe(true);
      expect(describeSettlement(settlement)).toBe(
        "completed:CompletionClaimed",
      );
      if (settled.value.state.status === "Settled") {
        expect(settled.value.state.settlement).toEqual(settlement);
      }
    }
    const resettle = settleExecution(settled.ok ? settled.value : execution, {
      _tag: "Failed",
      failure: { _tag: "ExecutionFailure", reason: "x" },
    });
    expect(resettle.ok).toBe(false);
    if (!resettle.ok) {
      expect(resettle.error._tag).toBe("TerminalLifecycleMutation");
    }
  });

  it("rejects stopping a settled execution", () => {
    const settled = settleExecution(admit(), {
      _tag: "OutcomeUnknown",
      reconciliation: {
        _tag: "ReconciliationRequired",
        invocationRefs: ["tool-1"],
      },
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) {
      throw new Error("expected settle");
    }
    const stopped = stopExecution(settled.value);
    expect(stopped.ok).toBe(false);
  });

  it("settlement is exhaustive and mutually exclusive", () => {
    expect(
      describeSettlement({
        _tag: "Interrupted",
        result: { _tag: "StopRequested" },
      }),
    ).toBe("interrupted:StopRequested");
    expect(
      describeSettlement({
        _tag: "OutcomeUnknown",
        reconciliation: { _tag: "ReconciliationRequired", invocationRefs: [] },
      }),
    ).toBe("unknown:0");
  });

  it("type-level: an arbitrary outcome x result pair cannot be built", () => {
    // @ts-expect-error Completed requires a CompletedResult
    const bad: ExecutionSettlement = { _tag: "Completed" };
    void bad;
  });
});
