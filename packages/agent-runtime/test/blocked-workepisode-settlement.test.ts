import {
  blockedFailureFingerprint,
  workBlockerIdentity,
} from "@arbor/application";
import {
  ExecutionId,
  ProjectId,
  ProviderTurnId,
  parse,
  SessionId,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import type {
  AgentLoopStepActionRecord,
  AgentLoopStepRecord,
} from "@arbor/ports";
import { TransactionScope } from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { makeBlockedSettlement } from "../src/agent-loop-actions.js";

const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a1");
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const providerTurnId = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1",
);

const denial = {
  _tag: "HandlerRejected" as const,
  routeKind: "Executable" as const,
};
const step: AgentLoopStepRecord = {
  identity: { executionId, logicalStepNo: 0, repairAttempt: 0 },
  providerTurnId,
  manifestId: "manifest_test",
  state: "ActionsInProgress",
  nextActionIndex: 1,
  revision: 2,
  updatedAt: "2026-10-12T00:00:00.000Z",
};
const action: AgentLoopStepActionRecord = {
  identity: step.identity,
  actionIndex: 0,
  logicalActionId: "lac_exact",
  callRef: "call_exact",
  routeKind: "Executable",
  actionKind: "patch",
  inputHash: "input-hash",
  state: "TerminalRejected",
  resultRef: "result_exact",
  settlementRef: "settlement_exact",
  disposition: {
    _tag: "HandlerRejected",
    status: "Denied",
    terminalDenial: denial,
  },
  observationSourceRef: "observation_exact",
  revision: 1,
  updatedAt: "2026-10-12T00:00:00.000Z",
};
const manifest = {
  executionId,
  providerTurnId,
  logicalStepNo: 0,
  repairAttempt: 0,
  toolRoutes: [
    {
      name: "patch",
      route: "Executable",
      stableId: "builtin.patch",
      version: "1",
      hash: "patch-hash",
    },
  ],
};

const dependencies = () => ({
  input: {
    execution: {
      executionId,
      projectId,
      workspaceId,
      binding: {
        _tag: "WorkspaceExecution" as const,
        workspaceId,
        episode: {
          _tag: "WorkEpisode" as const,
          workId,
          targetWorkRevision: 0 as never,
        },
      },
      sessionId,
      admittedAt: "2026-10-12T00:00:00.000Z",
      stopRequestedAt: null,
      state: { status: "Active" as const, settlement: null },
    },
    context: {} as never,
  },
  tx: {
    transact: (effect: Effect.Effect<unknown, unknown, never>) => effect,
  },
  loopSteps: {
    find: () => Effect.succeed(Option.some(step)),
    listActions: () => Effect.succeed([action]),
  },
  providerTurns: {
    findManifestByTurn: () =>
      Effect.succeed({
        manifestId: "manifest_test",
        manifestJson: JSON.stringify(manifest),
        portableRequestJson: "{}",
      }),
  },
  inboxSequence: { currentSequence: () => Effect.succeed(12) },
  currentLoopStep: step,
  failure: (cause: unknown) => cause as never,
});

describe("P3 explicit Blocked disposition", () => {
  it("binds exact TerminalRejected + Denied action to its pinned manifest and runtime Inbox sequence", async () => {
    const settlement = await Effect.runPromise(
      makeBlockedSettlement(
        dependencies() as never,
        "A human must approve this resource boundary.",
        step,
      ).pipe(
        Effect.provideService(TransactionScope, {
          session: { id: "blocked-episode-test" },
        }),
      ),
    );
    const ref = {
      executionId,
      providerTurnId,
      logicalStepNo: 0,
      repairAttempt: 0,
      actionIndex: 0,
      logicalActionId: action.logicalActionId,
      callRef: action.callRef,
      resultRef: action.resultRef as string,
      settlementRef: action.settlementRef as string,
      observationSourceRef: action.observationSourceRef as string,
      terminalDenial: denial,
    };
    const failureFingerprint = blockedFailureFingerprint([
      {
        ref,
        actionDefinition: {
          stableId: "builtin.patch",
          version: "1",
          hash: "patch-hash",
        },
        routeKind: "Executable",
        actionKind: "patch",
        inputHash: action.inputHash,
        resultStatus: "Denied",
      },
    ]);
    const expectedId = workBlockerIdentity({
      projectId,
      workId,
      targetWorkRevision: 0 as never,
      failureFingerprint,
    });
    expect(settlement).toMatchObject({
      _tag: "Completed",
      result: {
        _tag: "Blocked",
        workId,
        blockerId: expectedId,
        request: "A human must approve this resource boundary.",
        waitFor: {
          conditions: [
            { _tag: "Manual" },
            { _tag: "InboxAdvanced", workspaceId, observedSequence: 12 },
          ],
        },
        failedActionRefs: [ref],
      },
    });
  });

  it("refuses legacy/untyped rejection prose instead of inferring a blocker", async () => {
    const legacy = dependencies();
    legacy.loopSteps.listActions = () =>
      Effect.succeed([
        {
          ...action,
          disposition: "HandlerRejected",
        },
      ] as never);
    const settlement = await Effect.runPromise(
      makeBlockedSettlement(legacy as never, "need help", step).pipe(
        Effect.provideService(TransactionScope, {
          session: { id: "blocked-legacy-refusal-test" },
        }),
      ),
    );
    expect(settlement).toBeNull();
  });
});
