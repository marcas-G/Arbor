import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import type {
  DecisionId,
  ExecutionEpisodeBinding,
  ExecutionSettlement,
  MessageId,
  ProjectId,
  Work,
  WorkId,
  Workspace,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  type AttentionReadDeps,
  deriveAttentionRows,
  type ExecutionSettlementReadFact,
  loadAttentionFacts,
  subtreeAttentionAggregate,
} from "../packages/projection-runtime/src/index.js";

const projectId = "prj_00000000-0000-7000-8000-0000000000a1" as ProjectId;
const workspaceId = "ws_00000000-0000-7000-8000-0000000000a1" as WorkspaceId;
const workId = "wrk_00000000-0000-7000-8000-0000000000a1" as WorkId;
const executionId = "exe_00000000-0000-7000-8000-0000000000a1";
const currentWorkRevision = 7;

const workspace = {
  workspaceId,
  projectId,
  parentWorkspaceId: null,
  name: "episode-attention-test",
} as unknown as Workspace;

const work = {
  workId,
  workspaceId,
  projectId,
  objective: "verify safety-stop Attention episode handling",
  why: "unit test fixture",
  completionExpectation: "the source scope is correct",
  lifecycle: "Open",
  revision: currentWorkRevision,
} as unknown as Work;

const safetyStop: ExecutionSettlement = {
  _tag: "Interrupted",
  result: { _tag: "ControlledInterruption", reason: "RuntimeSafetyStop" },
};

const loadSafetyStopFacts = (
  episode: string | null,
  bindingWorkRevision: number | null = null,
  episodeWorkId: WorkId | null = null,
) => {
  const settlementFact: ExecutionSettlementReadFact = {
    executionId,
    workspaceId,
    settlement: safetyStop,
    settledAt: "2026-10-24T00:00:00.000Z",
    settlementKind: "Interrupted",
    settlementMalformed: false,
  };
  const deps: AttentionReadDeps = {
    listWorkspacesByProject: () => Effect.succeed([workspace]),
    listWorksByWorkspace: () => Effect.succeed([work]),
    listExecutionSettlementFacts: () => Effect.succeed([settlementFact]),
    listAttentionSourceExecutionBindings: () =>
      Effect.succeed([
        {
          executionId,
          projectId,
          workspaceId,
          episodeJson: episode,
          workId: episodeWorkId,
          workProjectId: episodeWorkId === null ? null : projectId,
          workWorkspaceId: episodeWorkId === null ? null : workspaceId,
          workRevision: bindingWorkRevision,
        },
      ]),
    listOpenVerifications: () => Effect.succeed([]),
    listUnsatisfiedDependencies: () => Effect.succeed([]),
    findDependency: () => Effect.succeed(Option.none()),
    readEvents: () => Effect.succeed([]),
  };
  return loadAttentionFacts(projectId, deps);
};

const workspaceSafetyRow = async (
  episode: ExecutionEpisodeBinding,
): Promise<ReadonlyArray<ReturnType<typeof deriveAttentionRows>[number]>> => {
  const facts = await Effect.runPromise(
    loadSafetyStopFacts(JSON.stringify(episode)),
  );
  return deriveAttentionRows(facts);
};

describe("P10 RuntimeSafetyEnvelope episode scope", () => {
  it.each([
    {
      _tag: "ConversationResponseEpisode",
      messageId: "msg_00000000-0000-7000-8000-0000000000a1" as MessageId,
      responseJobRevision: 1,
    },
    {
      _tag: "InboxEpisode",
      entryKey: "inbox:attention-test",
      inputKind: "Governance",
    },
    {
      _tag: "DecisionEpisode",
      decisionId: "dec_00000000-0000-7000-8000-0000000000a1" as DecisionId,
      decisionKind: "SelectCurrentWork",
      requestRevision: 3,
    },
  ] satisfies ReadonlyArray<ExecutionEpisodeBinding>)(
    "projects a valid non-Work %s as workspace-scoped Attention",
    async (episode) => {
      const rows = await workspaceSafetyRow(episode);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "RuntimeSafetyEnvelope",
            severity: "Attention",
            targetWorkspaceId: workspaceId,
          }),
        ]),
      );
      const safety = rows.find((row) => row.source === "RuntimeSafetyEnvelope");
      expect(safety).toBeDefined();
      expect(safety && "workId" in safety ? safety.workId : undefined).toBe(
        undefined,
      );
      expect(
        subtreeAttentionAggregate(rows, () => null).get(workspaceId),
      ).toEqual({
        attention: 1,
        actionRequired: 0,
      });
    },
  );

  it("keeps WorkEpisode safety Attention bound to the exact current Work revision", async () => {
    const currentEpisode = JSON.stringify({
      _tag: "WorkEpisode",
      workId,
      targetWorkRevision: currentWorkRevision,
    });
    const current = await Effect.runPromise(
      loadSafetyStopFacts(currentEpisode, currentWorkRevision, workId),
    );
    expect(
      deriveAttentionRows(current).some(
        (row) => row.source === "RuntimeSafetyEnvelope",
      ),
    ).toBe(true);

    const staleEpisode = JSON.stringify({
      _tag: "WorkEpisode",
      workId,
      targetWorkRevision: currentWorkRevision - 1,
    });
    const stale = await Effect.runPromise(
      loadSafetyStopFacts(staleEpisode, currentWorkRevision, workId),
    );
    expect(
      deriveAttentionRows(stale).some(
        (row) => row.source === "RuntimeSafetyEnvelope",
      ),
    ).toBe(false);
  });

  it.each([
    [
      "unknown EGP tag",
      JSON.stringify({ _tag: "WorkEpisodeV9" }),
      "EpisodeVersionUnsupported",
    ],
    ["malformed JSON", "{broken", "EpisodeMalformed"],
    [
      "agent execution identity",
      JSON.stringify({ _tag: "ExecutionBoundEpisode", executionId }),
      "EpisodeVersionUnsupported",
    ],
    [
      "ambiguous legacy identity",
      JSON.stringify({ _tag: "LegacyAmbiguousEpisode", executionId }),
      "EpisodeVersionUnsupported",
    ],
  ] as const)("fails closed for %s", async (_label, episode, reasonCode) => {
    const exit = await Effect.runPromiseExit(loadSafetyStopFacts(episode));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toMatchObject({
        _tag: "ProjectionIntegrityFailure",
        reasonCode,
        executionId,
      });
    }
  });
});
