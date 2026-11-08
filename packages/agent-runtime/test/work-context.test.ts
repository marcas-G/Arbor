import { describe, expect, it } from "vitest";
import {
  makeExecutionBoundFixture,
  makeWorkExecutionFixture,
  makeWorkFixture,
  makeWorkspaceFixture,
} from "../../testkit/dist/index.js";
import { assembleWorkContext } from "../src/work-context.js";

describe("WorkContextAssembler", () => {
  it("assembles responsibility, boundary, constraints and verification facts as separate hard scopes", () => {
    const workspace = makeWorkspaceFixture({
      workspaceId: "ws_00000000-0000-7000-8000-0000000000c1",
      projectId: "prj_00000000-0000-7000-8000-0000000000c1",
      sessionId: "ses_00000000-0000-7000-8000-0000000000c1",
      resourcePath: ".",
    });
    const work = makeWorkFixture({
      workId: "wrk_00000000-0000-7000-8000-0000000000c1",
      projectId: String(workspace.projectId),
      workspaceId: String(workspace.workspaceId),
      objective: "produce report",
    });

    const assembled = assembleWorkContext(workspace, work);
    expect(assembled.fragments.map((fragment) => fragment.scope)).toEqual([
      "responsibility-definition",
      "resource-boundary",
      "work-objective",
      "work-constraints",
      "completion-expectation",
      "verification-mission-summary",
    ]);
    expect([...assembled.contents.values()].join("\n")).toContain(
      "produce report",
    );
    expect([...assembled.contents.values()].join("\n")).toContain(
      "test completion",
    );
    expect(
      assembled.fragments.every((fragment) => fragment.strength === "Hard"),
    ).toBe(true);
  });

  it("projects an ExecutionBound mission as a hard instruction", () => {
    const workspace = makeWorkspaceFixture({
      workspaceId: "ws_00000000-0000-7000-8000-0000000000c2",
      projectId: "prj_00000000-0000-7000-8000-0000000000c2",
      sessionId: "ses_00000000-0000-7000-8000-0000000000c2",
      resourcePath: ".",
    });
    const execution = makeExecutionBoundFixture({
      executionId: "exe_00000000-0000-7000-8000-0000000000c2",
      projectId: String(workspace.projectId),
      workspaceId: String(workspace.workspaceId),
      sessionId: String(workspace.primarySessionId),
      mission: "verify exact criteria and submit a canonical conclusion",
    });

    const assembled = assembleWorkContext(workspace, null, execution);
    expect(assembled.fragments.map((fragment) => fragment.scope)).toContain(
      "execution-bound-mission",
    );
    expect([...assembled.contents.values()].join("\n")).toContain(
      "submit a canonical conclusion",
    );
  });

  it("adds the completion protocol to WorkEpisode context", () => {
    const workspace = makeWorkspaceFixture({
      workspaceId: "ws_00000000-0000-7000-8000-0000000000c3",
      projectId: "prj_00000000-0000-7000-8000-0000000000c3",
      sessionId: "ses_00000000-0000-7000-8000-0000000000c3",
      resourcePath: ".",
    });
    const work = makeWorkFixture({
      workId: "wrk_00000000-0000-7000-8000-0000000000c3",
      projectId: String(workspace.projectId),
      workspaceId: String(workspace.workspaceId),
      objective: "confirm status",
    });
    const execution = makeWorkExecutionFixture({
      executionId: "exe_00000000-0000-7000-8000-0000000000c3",
      projectId: String(workspace.projectId),
      workspaceId: String(workspace.workspaceId),
      sessionId: String(workspace.primarySessionId),
      workId: String(work.workId),
    });
    const assembled = assembleWorkContext(workspace, work, execution);
    expect([...assembled.contents.values()].join("\n")).toContain(
      "call claim_completion",
    );
  });
});
