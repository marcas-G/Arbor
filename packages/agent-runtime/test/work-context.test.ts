import type { Work, Workspace } from "@arbor/domain";
import { describe, expect, it } from "vitest";
import { assembleWorkContext } from "../src/work-context.js";

describe("WorkContextAssembler", () => {
  it("assembles responsibility, boundary, constraints and verification facts as separate hard scopes", () => {
    const workspace = {
      workspaceId: "ws_context",
      responsibilityRevision: 2,
      resourceBoundaryRevision: 3,
      responsibilityDefinition: { purpose: "own research" },
      resourceBoundary: { addresses: [{ _tag: "FileTree", path: "." }] },
    } as unknown as Workspace;
    const work = {
      workId: "wrk_context",
      revision: 4,
      objective: "produce report",
      why: "support decision",
      constraints: ["no orders"],
      completionExpectation: "reproducible report",
      verificationMission: {
        criteria: [{ id: "c1", statement: "reproducible" }],
      },
    } as unknown as Work;

    const assembled = assembleWorkContext(workspace, work);
    expect(assembled.fragments.map((fragment) => fragment.scope)).toEqual([
      "responsibility-definition",
      "resource-boundary",
      "work-objective",
      "work-constraints",
      "completion-expectation",
      "verification-mission-summary",
    ]);
    expect([...assembled.contents.values()].join("\n")).toContain("no orders");
    expect([...assembled.contents.values()].join("\n")).toContain(
      "reproducible",
    );
    expect(
      assembled.fragments.every((fragment) => fragment.strength === "Hard"),
    ).toBe(true);
  });
});
