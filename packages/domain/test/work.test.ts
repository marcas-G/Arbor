import { describe, expect, it } from "vitest";
import type { Work, WorkLifecycle } from "../src/index.js";
import * as domain from "../src/index.js";
import {
  Actor,
  assignWork,
  cancelWork,
  completeWork,
  concludeVerification,
  createAcceptance,
  isWorkCurrent,
  isWorkOpen,
  isWorkTerminal,
  ProjectId,
  parse,
  refineWork,
  startVerification,
  VerificationId,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "../src/index.js";

const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789ab");
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const verificationId = parse(VerificationId)(
  "ver_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const actor = parse(Actor)("user:gaolei");

const mission = { goal: "g", criteria: [], riskRequirements: [] };

const assign = (revision = 0): Work => {
  const result = assignWork({
    workId,
    projectId,
    workspaceId,
    objective: "ship domain kernel",
    why: "P0",
    constraints: [],
    completionExpectation: "green check",
    verificationMission: mission,
    provenance: { predecessorWorkId: null, reason: "initial" },
    revision: parse(WorkRevision)(revision),
    authorized: true,
    workspaceAcceptsWork: true,
  });
  if (!result.ok) {
    throw new Error("expected assign");
  }
  return result.value;
};

const describeLifecycle = (lifecycle: WorkLifecycle): string => {
  switch (lifecycle) {
    case "Open":
      return "open";
    case "Completed":
      return "completed";
    case "Cancelled":
      return "cancelled";
    default: {
      const unreachable: never = lifecycle;
      return unreachable;
    }
  }
};

describe("work aggregate", () => {
  it("assigns Open and exposes the three-state lifecycle", () => {
    const work = assign();
    expect(work.lifecycle).toBe("Open");
    expect(isWorkOpen(work)).toBe(true);
    expect(isWorkTerminal(work)).toBe(false);
    expect(describeLifecycle("Completed")).toBe("completed");
    expect(describeLifecycle("Cancelled")).toBe("cancelled");
  });

  it("refines with a new revision and rejects weakening", () => {
    const refined = refineWork(assign(4), {
      authorized: true,
      weakensProtectedRequirements: false,
      objective: "ship domain kernel v2",
    });
    expect(refined.ok).toBe(true);
    if (refined.ok) {
      expect(refined.value.revision).toBe(5);
      expect(refined.value.objective).toBe("ship domain kernel v2");
    }
    const weakened = refineWork(assign(4), {
      authorized: true,
      weakensProtectedRequirements: true,
    });
    expect(weakened.ok).toBe(false);
    if (!weakened.ok) {
      expect(weakened.error._tag).toBe("AuthorityDenied");
    }
  });

  it("completes only with current-revision PASS verification and acceptance", () => {
    const work = assign(3);
    const started = startVerification({
      verificationId,
      workId,
      targetWorkRevision: parse(WorkRevision)(3),
      missionSnapshot: mission,
    });
    const concluded = concludeVerification(started, "Pass");
    if (!concluded.ok) {
      throw new Error("expected conclude");
    }
    const acceptance = createAcceptance({
      acceptanceId: "acc_00000000-0000-7000-8000-000000000001" as never,
      workId,
      targetWorkRevision: parse(WorkRevision)(3),
      verificationId,
      actor,
      acceptedAt: "2026-09-20T00:00:00.000Z",
    });
    const completed = completeWork(work, concluded.value, acceptance);
    expect(completed.ok).toBe(true);
    if (completed.ok) {
      expect(completed.value.lifecycle).toBe("Completed");
      expect(isWorkTerminal(completed.value)).toBe(true);
    }

    const stale = completeWork(
      work,
      concluded.value,
      createAcceptance({
        acceptanceId: "acc_00000000-0000-7000-8000-000000000002" as never,
        workId,
        targetWorkRevision: parse(WorkRevision)(2),
        verificationId,
        actor,
        acceptedAt: "2026-09-20T00:00:00.000Z",
      }),
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error._tag).toBe("VerificationAcceptanceMismatch");
    }
  });

  it("rejects completion when verification is not PASS", () => {
    const work = assign(1);
    const started = startVerification({
      verificationId,
      workId,
      targetWorkRevision: parse(WorkRevision)(1),
      missionSnapshot: mission,
    });
    const concluded = concludeVerification(started, "Fail");
    if (!concluded.ok) {
      throw new Error("expected conclude");
    }
    const result = completeWork(
      work,
      concluded.value,
      createAcceptance({
        acceptanceId: "acc_00000000-0000-7000-8000-000000000002" as never,
        workId,
        targetWorkRevision: parse(WorkRevision)(1),
        verificationId,
        actor,
        acceptedAt: "2026-09-20T00:00:00.000Z",
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("cancels with governance authority and rejects terminal reversal", () => {
    const cancelled = cancelWork(assign(), { authorized: true });
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) {
      throw new Error("expected cancel");
    }
    expect(cancelled.value.lifecycle).toBe("Cancelled");
    const reversal = cancelWork(cancelled.value, { authorized: true });
    expect(reversal.ok).toBe(false);
    if (!reversal.ok) {
      expect(reversal.error._tag).toBe("TerminalLifecycleMutation");
    }
    const refineTerminal = refineWork(cancelled.value, {
      authorized: true,
      weakensProtectedRequirements: false,
    });
    expect(refineTerminal.ok).toBe(false);
  });

  it("computes the current-work predicate purely", () => {
    const work = assign();
    expect(isWorkCurrent(work, workId)).toBe(true);
    expect(isWorkCurrent(work, null)).toBe(false);
  });

  it("does not expose Current / Pending lifecycle symbols", () => {
    expect("Current" in domain).toBe(false);
    expect("Pending" in domain).toBe(false);
  });
});
