import {
  ProjectId,
  parse,
  WorkId,
  WorkspaceId,
  workspaceEpisodeExecution,
} from "@arbor/domain";
import { describe, expect, it } from "vitest";
import { sessionTimelineEpochForAcceptedOutput } from "../src/model-output-journal.js";

const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a2");
const sessionId = "ses_epoch_owner" as never;

const execution = (episode: Parameters<typeof workspaceEpisodeExecution>[1]) =>
  ({
    executionId: "exe_018f2b3c-4d5e-7abc-8def-0123456789a3" as never,
    projectId,
    workspaceId,
    binding: workspaceEpisodeExecution(workspaceId, episode),
    sessionId,
    admittedAt: "2026-10-17T00:00:00.000Z",
    stopRequestedAt: null,
    state: { status: "Active", settlement: null },
  }) as const;

describe("AH19 owner epoch and Session epoch boundary", () => {
  it("allows Conversation owner epoch 1 while the isolated Work Session remains at 0", () => {
    expect(
      sessionTimelineEpochForAcceptedOutput({
        execution: execution({
          _tag: "ConversationResponseEpisode",
          messageId: "msg_epoch_owner" as never,
          responseJobRevision: 0,
        }),
        sessionEpoch: 0,
        providerEpoch: 1,
      }),
    ).toBe(0);
  });

  it("preserves the exact provider-to-Session epoch contract for Work", () => {
    const workExecution = execution({
      _tag: "WorkEpisode",
      workId: parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a4"),
      targetWorkRevision: 0 as never,
    });
    expect(
      sessionTimelineEpochForAcceptedOutput({
        execution: workExecution,
        sessionEpoch: 0,
        providerEpoch: 0,
      }),
    ).toBe(0);
    expect(
      sessionTimelineEpochForAcceptedOutput({
        execution: workExecution,
        sessionEpoch: 0,
        providerEpoch: 1,
      }),
    ).toMatchObject({
      _tag: "SessionEpochConflict",
      sessionId,
      expectedEpoch: 1,
      currentEpoch: 0,
    });
  });
});
