import { ExecutionId, parse, WorkId } from "@arbor/domain";
import { describe, expect, it } from "vitest";
import { filterEntriesForWork } from "../src/work-frontier.js";

describe("Work context frontier", () => {
  it("excludes historical and foreign unbound entries", () => {
    const executionId = parse(ExecutionId)(
      "exe_00000000-0000-7000-8000-0000000000f1",
    );
    const workId = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000f1");
    const entries = [
      {
        sessionId: "ses_x" as never,
        sequence: 1,
        entryKind: "ModelOutput" as const,
        payload: {},
        createdAt: "t",
      },
      {
        sessionId: "ses_x" as never,
        sequence: 2,
        entryKind: "ModelOutput" as const,
        payload: {},
        createdAt: "t",
        causalBinding: {
          projectId: "prj_00000000-0000-7000-8000-0000000000f1" as never,
          workspaceId: "ws_00000000-0000-7000-8000-0000000000f1" as never,
          executionId,
          workId,
          episodeBinding: "WorkEpisode",
          causedByRef: null,
        },
      },
    ];
    expect(
      filterEntriesForWork(entries, { executionId, workId }).map(
        (entry) => entry.sequence,
      ),
    ).toEqual([2]);
  });

  it("retains bound history from prior executions of the same Work", () => {
    const executionId = parse(ExecutionId)(
      "exe_00000000-0000-7000-8000-0000000000f1",
    );
    const priorExecutionId = parse(ExecutionId)(
      "exe_00000000-0000-7000-8000-0000000000f2",
    );
    const workId = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000f1");
    const entries = [
      {
        sessionId: "ses_x" as never,
        sequence: 1,
        entryKind: "Observation" as const,
        payload: {},
        createdAt: "t",
        causalBinding: {
          projectId: "prj_00000000-0000-7000-8000-0000000000f1" as never,
          workspaceId: "ws_00000000-0000-7000-8000-0000000000f1" as never,
          executionId: priorExecutionId,
          workId,
          episodeBinding: "WorkEpisode",
          causedByRef: null,
        },
      },
      {
        sessionId: "ses_x" as never,
        sequence: 2,
        entryKind: "Observation" as const,
        payload: {},
        createdAt: "t",
        causalBinding: {
          projectId: "prj_00000000-0000-7000-8000-0000000000f1" as never,
          workspaceId: "ws_00000000-0000-7000-8000-0000000000f1" as never,
          executionId,
          workId,
          episodeBinding: "WorkEpisode",
          causedByRef: null,
        },
      },
    ];
    expect(
      filterEntriesForWork(entries, { executionId, workId }).map(
        (entry) => entry.sequence,
      ),
    ).toEqual([1, 2]);
  });

  it("drops an AgentLoopAction result when its call was trimmed from the window", () => {
    const executionId = parse(ExecutionId)(
      "exe_00000000-0000-7000-8000-0000000000f1",
    );
    const workId = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000f1");
    const binding = {
      projectId: "prj_00000000-0000-7000-8000-0000000000f1" as never,
      workspaceId: "ws_00000000-0000-7000-8000-0000000000f1" as never,
      executionId,
      workId,
      episodeBinding: "WorkEpisode" as const,
      causedByRef: null,
    };
    const result = filterEntriesForWork(
      [
        {
          sessionId: "ses_x" as never,
          sequence: 1,
          entryKind: "Observation" as const,
          payload: {
            _tag: "ToolResult",
            callRef: "trimmed-call",
            toolName: "read",
          },
          createdAt: "t",
          source: {
            kind: "AgentLoopAction",
            ref: "observation_trimmed",
            contentHash: "hash",
          },
          causalBinding: binding,
        },
        {
          sessionId: "ses_x" as never,
          sequence: 2,
          entryKind: "Observation" as const,
          payload: {
            _tag: "ToolResult",
            callRef: "invocation-result",
            toolName: "read",
          },
          createdAt: "t",
          source: {
            kind: "ToolInvocation",
            ref: "tin_current",
            contentHash: "hash",
          },
          causalBinding: binding,
        },
      ],
      { executionId, workId },
    );
    expect(result.map((entry) => entry.sequence)).toEqual([2]);
  });
});
