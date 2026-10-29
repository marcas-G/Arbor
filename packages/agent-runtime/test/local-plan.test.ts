import { parse, WorkId, type WorkRevision } from "@arbor/domain";
import { describe, expect, it } from "vitest";
import { reviseLocalPlan } from "../src/local-plan.js";

const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789d1");

describe("MAC LocalPlan cognition transition", () => {
  it("creates and revises progress without Domain completion semantics", () => {
    const created = reviseLocalPlan({
      current: null,
      workId,
      targetWorkRevision: 0 as WorkRevision,
      expectedRevision: 0,
      items: [
        { itemId: "inspect", text: "inspect evidence", status: "Pending" },
      ],
      updatedAt: "t1",
    });
    expect(created).toMatchObject({
      ok: true,
      value: { revision: 1, workId, targetWorkRevision: 0 },
    });
    if (!created.ok) return;
    expect(created.value).not.toHaveProperty("lifecycle");
    expect(created.value).not.toHaveProperty("completion");

    const revised = reviseLocalPlan({
      current: created.value,
      workId,
      targetWorkRevision: 0 as WorkRevision,
      expectedRevision: 1,
      items: [
        { itemId: "inspect", text: "inspect evidence", status: "Completed" },
      ],
      updatedAt: "t2",
    });
    expect(revised).toMatchObject({ ok: true, value: { revision: 2 } });
  });

  it("rejects stale revisions and invalid items with a runtime-local error algebra", () => {
    expect(
      reviseLocalPlan({
        current: null,
        workId,
        targetWorkRevision: 0 as WorkRevision,
        expectedRevision: 1,
        items: [{ itemId: "a", text: "a", status: "Pending" }],
        updatedAt: "t",
      }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "LocalPlanRevisionConflict", expected: 1, actual: 0 },
    });
    expect(
      reviseLocalPlan({
        current: null,
        workId,
        targetWorkRevision: 0 as WorkRevision,
        expectedRevision: 0,
        items: [
          { itemId: "a", text: "a", status: "Pending" },
          { itemId: "a", text: "duplicate", status: "Blocked" },
        ],
        updatedAt: "t",
      }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "LocalPlanInvalid", reason: "duplicate plan item id" },
    });
  });
});
