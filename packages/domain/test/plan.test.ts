import { describe, expect, it } from "vitest";
import { parse, reviseWorkPlan, WorkId, WorkRevision } from "../src/index.js";

const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789ab");

describe("DID v1.28 Work-scoped Plan", () => {
  it("revises progress without changing Work lifecycle authority", () => {
    const result = reviseWorkPlan({
      current: null,
      workId,
      targetWorkRevision: parse(WorkRevision)(2),
      expectedPlanRevision: 0,
      items: [
        { itemId: "inspect", text: "检查现状", status: "Completed" },
        { itemId: "fix", text: "修复边界", status: "InProgress" },
      ],
      updatedAt: "2026-10-03T00:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.planRevision).toBe(1);
      expect(result.value).not.toHaveProperty("lifecycle");
      expect(result.value).not.toHaveProperty("completedAt");
    }
  });

  it("rejects stale revisions and duplicate item identities", () => {
    const current = {
      workId,
      targetWorkRevision: parse(WorkRevision)(2),
      planRevision: 3,
      items: [{ itemId: "a", text: "A", status: "Pending" as const }],
      updatedAt: "t",
    };
    expect(
      reviseWorkPlan({
        current,
        workId,
        targetWorkRevision: parse(WorkRevision)(2),
        expectedPlanRevision: 2,
        items: current.items,
        updatedAt: "t2",
      }),
    ).toMatchObject({ ok: false, error: { _tag: "RevisionConflict" } });
    expect(
      reviseWorkPlan({
        current,
        workId,
        targetWorkRevision: parse(WorkRevision)(2),
        expectedPlanRevision: 3,
        items: [
          { itemId: "a", text: "A", status: "Pending" },
          { itemId: "a", text: "B", status: "Blocked" },
        ],
        updatedAt: "t2",
      }),
    ).toMatchObject({ ok: false, error: { _tag: "WorkPlanInvalid" } });
  });
});
