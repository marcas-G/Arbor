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
});
