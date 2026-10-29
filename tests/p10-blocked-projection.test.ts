import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import type {
  ExecutionSettlement,
  Work,
  WorkBlocker,
  WorkId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  deriveAttentionRows,
  deriveWorkDetail,
} from "../packages/projection-runtime/src/index.js";

const workId = "wrk_00000000-0000-7000-8000-0000000000b1" as WorkId;
const workspaceId = "ws_00000000-0000-7000-8000-0000000000b1" as WorkspaceId;
const projectId =
  "prj_00000000-0000-7000-8000-0000000000b1" as WorkBlocker["projectId"];
const executionId =
  "exe_00000000-0000-7000-8000-0000000000b1" as WorkBlocker["openCycleId"];
const blockerId =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as WorkBlocker["blockerId"];
const action = {
  executionId,
  providerTurnId: "ptn_00000000-0000-7000-8000-0000000000b1" as never,
  logicalStepNo: 1,
  repairAttempt: 0,
  actionIndex: 0,
  logicalActionId: "action-1",
  callRef: "call:bounded",
  resultRef: "result:bounded",
  settlementRef: "settlement:bounded",
  observationSourceRef: "observation:bounded",
  terminalDenial: {
    _tag: "P4NoEffectDenied",
    reasonCode: "ResourceAdmissionDenied",
  },
} as const;
const blocker: WorkBlocker = {
  blockerId,
  projectId,
  workspaceId,
  workId,
  targetWorkRevision: 4 as WorkBlocker["targetWorkRevision"],
  failureFingerprint: blockerId,
  state: "Open",
  openCycleId: executionId,
  latestRequestRef: "Please inspect the configured workspace resource.",
  failedActionRefs: [action],
  revision: 1,
};
const settlement: ExecutionSettlement = {
  _tag: "Completed",
  result: {
    _tag: "Blocked",
    workId,
    targetWorkRevision: 4 as WorkBlocker["targetWorkRevision"],
    blockerId,
    waitFor: [{ _tag: "Manual" }],
    request: "Please inspect the configured workspace resource.",
    failedActionRefs: [action],
  },
} as unknown as ExecutionSettlement;

describe("Blocked WorkEpisode P10 projections", () => {
  it("derives ActionRequired from the current ledger and lowers it only for an active exact WorkEpisode", () => {
    const base = {
      unfulfillableEvents: [],
      deadlockEvents: [],
      safetyStopSettlements: [],
      reconciliationEscalatedEvents: [],
      openVerifications: [],
      executionSettlements: [],
      vacantProducerCandidates: [],
      workspaceVacancies: [],
      workOwners: [],
    };
    const idle = deriveAttentionRows({
      ...base,
      workBlockers: [blocker, blocker],
    });
    const active = deriveAttentionRows({
      ...base,
      workBlockers: [blocker],
      activeWorkEpisodeIds: [workId],
    });
    expect(idle).toHaveLength(1);
    expect(idle[0]).toMatchObject({
      source: "WorkEpisodeBlocked",
      severity: "ActionRequired",
      targetWorkspaceId: workspaceId,
      dedupKey: blockerId,
    });
    expect(active[0]?.severity).toBe("Attention");
    expect(
      deriveAttentionRows({
        ...base,
        workBlockers: [{ ...blocker, state: "Resolved" }],
      }),
    ).toEqual([]);
  });

  it("shows safe current blocker details only when exact settlement evidence matches", async () => {
    const work = {
      workId,
      projectId,
      workspaceId,
      objective: "Fix the resource setup",
      why: "Needed for the requested change",
      completionExpectation: "The task passes verification",
      lifecycle: "Open",
      revision: 4,
    } as unknown as Work;
    const view = await Effect.runPromise(
      deriveWorkDetail(
        { projectId, workspaceId, workId },
        {
          findWork: () => Effect.succeed(Option.some(work)),
          findAcceptanceByWorkRevision: () => Effect.succeed(Option.none()),
          findVerification: () => Effect.succeed(Option.none()),
          listWorkBlockersByWorkRevision: () => Effect.succeed([blocker]),
          findExecutionSettlement: () =>
            Effect.succeed(Option.some(settlement)),
        },
      ),
    );
    expect(view.blockedEpisode).toMatchObject({
      sourceExecutionId: executionId,
      blockers: [
        {
          blockerId,
          disposition: "Blocked",
          failedActions: [
            {
              actionId: "action-1",
              actionKind: "P4NoEffectDenied",
              status: "Denied",
              denialCategory: "ResourceAdmissionDenied",
              request: blocker.latestRequestRef,
              observationRef: "observation:bounded",
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(view.blockedEpisode)).not.toContain(
      "settlement:bounded",
    );
  });
});
